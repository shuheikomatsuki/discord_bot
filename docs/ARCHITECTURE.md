# Discord Bot アーキテクチャ設計（Hono + Cloudflare Workers + D1）

個人利用（大学の友人3人程度のサーバー）を前提に、**完全無料枠で完結**させる構成をまとめる。

---

## 1. 最重要の前提：Gateway ではなく Interactions（HTTP）を使う

Discord Bot の実装方式は2つある。Cloudflare Workers で動かす場合、選べるのは後者だけ。

| 方式 | 通信 | Workers で動くか |
|---|---|---|
| Gateway (WebSocket) | 常時接続して全イベントを受信 | **不可**（常駐プロセスが必要。discord.js / eris はこちら） |
| Interactions Endpoint (HTTP Webhook) | Discord → 自分のURLへ POST | **可**（Workers はこれ向き） |

### これにより「できること / できないこと」

できる:
- スラッシュコマンド（`/foo`）
- ボタン / セレクトメニュー / モーダル（Message Components）
- 右クリックメニュー（User / Message Context Menu）
- Cron Triggers による定期実行（定期投稿・リマインダー）
- Bot Token で REST API を叩く（メッセージ送信、ロール付与、履歴取得など**能動的な操作**）

できない（Workers 単体では原理的に無理）:
- 通常のメッセージ投稿を**リアルタイムに検知**する（`MESSAGE_CREATE` が来ない）
- リアクション追加の検知、入退室の検知、VC関連、プレゼンス
- つまり「誰かが『おはよう』と言ったら反応する」系の bot は作れない

> **ここが設計の分岐点。** 用途がスラッシュコマンド中心（集計、投票、リマインダー、天気、割り勘計算、ガチャ等）なら Workers で完結できる。メッセージ監視が必須なら Gateway 常駐が必要で、その場合は Workers ではなく無料VPS/Fly.io 等を検討することになる。
> 妥協案として「Discord の Channel Webhook や Automod ではなく、ユーザーが `/` を打つ」UX に寄せるのが Workers 流。

---

## 2. 推奨スタック

| レイヤ | 選定 | 理由 |
|---|---|---|
| 言語 | TypeScript | 指定どおり |
| ランタイム | Cloudflare Workers | 無料枠 10万req/日 |
| HTTP フレームワーク | **Hono** | Workers 前提、軽量、型が強い |
| DB | **Cloudflare D1**（SQLite） | Workers からバインディングで直結。無料枠あり |
| ORM | **Drizzle ORM**（任意） | D1 対応、型安全、マイグレーション生成が楽。薄いので生SQLでも可 |
| 署名検証 | WebCrypto の Ed25519（または `discord-interactions` の `verifyKey`） | Workers は Ed25519 を標準サポート |
| デプロイ | Wrangler + GitHub Actions | 無料 |
| テスト | Vitest + `@cloudflare/vitest-pool-workers` | 実 Workers ランタイムでテストできる |
| Lint/Format | Biome（または ESLint + Prettier） | Biome は1つで済んで速い |

### 補足：`discord-hono` という選択肢
Hono ベースで Discord Interactions を扱うライブラリが存在する。楽だが、学習目的・依存を薄く保つ目的なら **Hono + 自前の薄いルーティング層**を推奨（本書はこちら前提）。

---

## 3. 無料枠の見積り

| サービス | 無料枠 | 本件の想定 |
|---|---|---|
| Workers Requests | 100,000 req/日 | 3人で使う程度なら 1日数十〜数百。**余裕** |
| Workers CPU time | 10ms / invocation | Discord API 待ちは I/O なので CPU 時間に計上されない。**問題なし** |
| Workers Subrequests | 50 / invocation | 1コマンドで数回。**問題なし** |
| Cron Triggers | 無料枠に含まれる | 定期投稿に使える |
| D1 ストレージ | 5GB | テキストデータなら事実上無制限 |
| D1 行読み取り | 500万行/日 | **問題なし** |
| D1 行書き込み | 10万行/日 | **問題なし** |
| KV（使う場合） | 読 10万/日、**書 1,000/日** | 書き込みが少ないので注意。基本 D1 を使う |

**結論：完全無料で完結する。** クレジットカード登録も不要（Workers Free プランのまま）。

> 注意点: **Cloudflare Queues は有料プラン専用**。無料で非同期処理したい場合は `ctx.waitUntil()` と Cron Triggers で代替する。Durable Objects は現在無料プランでも利用可能（SQLite backend）だが、本件の規模では不要。

---

## 4. リクエストフロー

### 4.1 スラッシュコマンド実行時

```
ユーザーが /foo を入力
        │
        ▼
Discord ──POST──▶ https://<worker>.workers.dev/interactions
                  ├─ ① Ed25519 署名検証（X-Signature-Ed25519 / X-Signature-Timestamp + raw body）
                  │     失敗 → 401（これを返さないと Discord がエンドポイント登録を拒否する）
                  ├─ ② type: 1 (PING) → { type: 1 } (PONG) を返す
                  └─ ③ type: 2 (APPLICATION_COMMAND) → コマンド名でハンドラを dispatch
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     【速い処理（<3秒）】          【遅い処理（D1/外部API）】
     type: 4                      type: 5 (DEFERRED) を即返す
     CHANNEL_MESSAGE_WITH_SOURCE   + ctx.waitUntil(async () => {
     で即返信                          重い処理...
                                       PATCH /webhooks/{app_id}/{token}/messages/@original
                                     })
```

**3秒ルール**が最大の制約。Discord は 3 秒以内に何らかのレスポンスが無いと「アプリケーションが応答しませんでした」になる。外部APIやDBを触るなら**原則 defer（type 5）する**設計にしておくのが安全。

### 4.2 Cron（定期投稿・リマインダー）

```
Cloudflare Cron Trigger（例: 毎日 9:00 JST = "0 0 * * *" UTC）
        │
        ▼
scheduled() ハンドラ
  ├─ D1 から対象レコードを取得
  └─ POST /channels/{channel_id}/messages （Authorization: Bot <TOKEN>）
```

### 4.3 コマンド登録（デプロイとは別作業）

スラッシュコマンドの定義は**実行時ではなく事前に** Discord へ登録する。

```
npm run register
  └─ PUT /applications/{APP_ID}/commands           ← グローバル（反映に最大1時間）
     または
     PUT /applications/{APP_ID}/guilds/{GUILD_ID}/commands  ← ギルド限定（即時反映）
```

個人サーバー用途なので **ギルドコマンド推奨**（即時反映されて開発が速い）。

---

## 5. ディレクトリ構成

```
discord_bot/
├── src/
│   ├── index.ts                  # エントリ。Hono app + scheduled() を export
│   ├── app.ts                    # Hono のルート定義
│   ├── middleware/
│   │   └── verifyDiscordRequest.ts   # Ed25519 署名検証ミドルウェア
│   ├── interactions/
│   │   ├── router.ts             # interaction type / custom_id で分岐
│   │   └── respond.ts            # reply() / defer() / followUp() のヘルパ
│   ├── commands/
│   │   ├── index.ts              # ★ コマンドレジストリ（唯一の真実の源）
│   │   ├── ping.ts
│   │   ├── memo.ts               # D1 を使う例
│   │   └── types.ts              # Command 型定義
│   ├── components/               # ボタン/モーダルのハンドラ（custom_id ベース）
│   ├── discord/
│   │   ├── rest.ts               # Bot Token を使う REST クライアント
│   │   └── types.ts              # discord-api-types から再export
│   ├── db/
│   │   ├── schema.ts             # Drizzle スキーマ
│   │   └── client.ts             # drizzle(env.DB)
│   ├── cron/
│   │   └── handlers.ts           # scheduled() の中身
│   └── env.d.ts                  # Env（バインディング + secrets）の型
├── scripts/
│   └── register-commands.ts      # コマンド登録スクリプト
├── migrations/                   # wrangler d1 migrations が生成
│   └── 0000_init.sql
├── test/
│   └── interactions.test.ts
├── wrangler.toml                 # (or wrangler.jsonc)
├── .dev.vars                     # ローカル用シークレット（.gitignore する）
├── .dev.vars.example
├── package.json
├── tsconfig.json
├── biome.json
└── docs/ARCHITECTURE.md
```

### 設計上のキモ：コマンドレジストリの一元化

`src/commands/index.ts` で **「Discord への登録定義」と「実行時ハンドラ」を同じオブジェクトに持たせる**。

```ts
// src/commands/types.ts
import type { APIApplicationCommandInteraction } from 'discord-api-types/v10';

export type CommandContext = {
  interaction: APIApplicationCommandInteraction;
  env: Env;
  ctx: ExecutionContext;
};

export type Command = {
  /** Discord に PUT する定義（そのままJSONで送れる形） */
  definition: RESTPostAPIApplicationCommandsJSONBody;
  /** 3秒以内に返せないなら true にして defer させる */
  deferred?: boolean;
  handler: (c: CommandContext) => Promise<APIInteractionResponse | void>;
};
```

これで「コマンド追加 → 登録スクリプトの修正を忘れて動かない」という典型的な事故が起きない。

---

## 6. 環境変数 / シークレット

| 名前 | 種類 | 用途 |
|---|---|---|
| `DISCORD_PUBLIC_KEY` | vars（公開情報） | 署名検証 |
| `DISCORD_APPLICATION_ID` | vars | REST のパス、コマンド登録 |
| `DISCORD_BOT_TOKEN` | **secret** | REST 認証。絶対にコミットしない |
| `DISCORD_GUILD_ID` | vars | ギルドコマンド登録先 |
| `DB` | D1 binding | `wrangler.toml` の `[[d1_databases]]` |

- 本番: `wrangler secret put DISCORD_BOT_TOKEN`
- ローカル: `.dev.vars`（`.gitignore` 必須）
- CI: GitHub Actions Secrets に `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`

**Public リポジトリなので、`.dev.vars` と `.env` の gitignore は最初にやること。** 万一トークンを push したら即 Discord Developer Portal で Reset Token。

---

## 7. ローカル開発フロー

Discord は Interactions Endpoint に**公開HTTPS URL**を要求するので、ローカル開発には以下のどちらか。

**方式A（推奨）: 開発用の別 Discord アプリを作る**
```
wrangler dev                     # localhost:8787
cloudflared tunnel --url http://localhost:8787   # 無料・アカウント不要で一時URLが出る
→ 開発用アプリの Interactions Endpoint URL にそのURL/interactions を設定
```
本番アプリと開発アプリを分けておけば、開発中に本番 bot が壊れない。

**方式B: いきなり Workers にデプロイして試す**
個人利用なら実はこれで十分（`wrangler deploy` は数秒）。ただしログは `wrangler tail` で追う。

ローカル D1 は `wrangler dev` が自動でローカル SQLite を使う（`--remote` で本番D1に繋ぐ）。

---

## 8. マイグレーション運用

```bash
# スキーマ変更（Drizzle 使用時）
npx drizzle-kit generate           # migrations/ にSQL生成
npx wrangler d1 migrations apply <DB_NAME> --local    # ローカル適用
npx wrangler d1 migrations apply <DB_NAME> --remote   # 本番適用
```

D1 はマイグレーション履歴テーブルを Cloudflare 側で管理してくれるので、手動管理は不要。

---

## 9. CI/CD（GitHub Actions・無料）

`main` に push されたら自動デプロイ。ブランチは main のみ運用で問題ない。

```yaml
# .github/workflows/deploy.yml
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run typecheck && npm run test
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          # マイグレーションも一緒に流す場合は command を分ける
```

コマンド定義を変えたときだけ `npm run register` を手で叩く（毎デプロイで叩く必要はない。叩いてもレート制限に注意）。

---

## 10. 段階的な実装順序（推奨）

1. `wrangler.toml` + Hono + `/interactions` で **PING/PONG だけ**返す。Discord Developer Portal にエンドポイント登録が通ることを確認（ここが最初の関門）
2. `/ping` コマンドを登録スクリプトで登録し、即時応答（type 4）で動作確認
3. defer（type 5 + `waitUntil` + PATCH）のパターンを1つ実装してテンプレ化
4. D1 を作成・バインドし、`/memo add` `/memo list` のような CRUD を1機能作る
5. ボタン or モーダルを1つ入れて Components の流れを確認
6. Cron Trigger で定期投稿を1つ
7. CI を入れる

---

## 11. 将来の逃げ道

| 要件が出たら | 対応 |
|---|---|
| メッセージ監視したい | Gateway 常駐が必要。Fly.io / Oracle Cloud Free 等に薄い中継プロセスを置き、イベントを Workers に HTTP で転送する構成にすれば、ロジックは Workers 側に残せる |
| 状態を持った対話 | Durable Objects（無料枠あり）。ただし大抵は D1 + custom_id で足りる |
| 重いバッチ | Queues は有料。Cron Triggers の分割実行で代替 |
| ファイル保存 | R2（無料枠 10GB） |
