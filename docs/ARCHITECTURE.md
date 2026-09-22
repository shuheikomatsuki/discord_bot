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
| DB アクセス | **D1 の prepared statement を薄い repository で包む** | ORM を入れていない。テーブルが1つで、配信ロックに `meta.changes` を使う楽観ロック UPDATE を書きたいため、生SQLのほうが素直で依存も減る |
| 署名検証 | WebCrypto の Ed25519（または `discord-interactions` の `verifyKey`） | Workers は Ed25519 を標準サポート |
| デプロイ | Wrangler + GitHub Actions | 無料 |
| テスト | **Vitest**（Node 環境） | 価値があるのは時刻計算・cron 解釈・署名検証といった純粋な処理。Workers ランタイムが要るテストが出てきたら `@cloudflare/vitest-pool-workers` を足す |
| Lint/Format | Biome（または ESLint + Prettier） | Biome は1つで済んで速い |

### 補足：`discord-hono` という選択肢
Hono ベースで Discord Interactions を扱うラッパーが存在する。ただし本件では **Hono + 自前の薄いルーティング層**を推奨する。理由は実利的なもので、

- 必要な抽象化が小さい（署名検証 + type による分岐 + defer ヘルパで概ね150行程度）
- Discord API の仕様変更に追従できなくなったとき、ラッパーが止まると全体が止まる
- `discord-api-types` で型は十分得られるので、ラッパーが提供する型の旨味が薄い

依存を1つ減らして自分で握っておくほうが、長期の保守コストは低い。

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

Cron Triggers は**個別のスケジュールを cron 式で登録するのではなく、毎分1本だけ回してD1をポーリングする**。
リマインダーは実行時刻がユーザー入力で決まるため、Cloudflare 側の cron 定義を動的に増やすことはできない（できても上限がある）。

```
wrangler.toml: crons = ["* * * * *"]   ← 毎分1本だけ
        │
        ▼
scheduled() ハンドラ（1日1,440回 / 無料枠 10万に対して十分）
  ├─ registry から全 feature の CronJob を集めて実行
  └─ reminder の CronJob:
       SELECT * FROM reminders WHERE status='active' AND next_fire_at <= now LIMIT 50
       各行について
         ├─ 楽観ロックで「取得」（後述の二重送信対策）
         ├─ POST /channels/{channel_id}/messages
         └─ next_fire_at を進める / 回数を減らす / 完了なら status='completed'
```

詳細は `docs/REMINDER.md` を参照。

### 4.3 コマンド登録（デプロイとは別作業）

スラッシュコマンドの定義は**実行時ではなく事前に** Discord へ登録する。`npm run register` で `PUT` するだけ。
詳細は「§5 グローバルコマンド vs ギルドコマンド」を参照。

---

## 5. グローバルコマンド vs ギルドコマンド

スラッシュコマンドの登録先は2種類ある。**dev/prod の分離とは無関係**の、純粋な「どこで使えるか」の話。

| | グローバル | ギルド |
|---|---|---|
| エンドポイント | `PUT /applications/{app_id}/commands` | `PUT /applications/{app_id}/guilds/{guild_id}/commands` |
| 使える場所 | Bot が参加している**全サーバー** + DM（許可すれば） | **指定した1サーバーのみ**（DM不可） |
| 反映タイミング | Discord 側にキャッシュされ、**最大1時間**かかることがある | **即時**（登録した瞬間に出る） |
| 上限 | 100個 | 1ギルドにつき100個（グローバル枠とは別勘定） |
| 権限設定 | サーバー管理者が各サーバーで上書き可能 | 同上 |

**両方に同名のコマンドを登録すると、ギルド側が優先されて2重に見えることは無い**（ギルドが勝つ）。ただし混乱の元なので、どちらか一方に統一する。

### 本件の結論：ギルドコマンド一本

- 使うサーバーは1つだけ（大学の友人3人のサーバー）
- 反映が即時なので「コマンドの説明文を直したのに1時間出てこない」というストレスが無い
- グローバルにする理由（=他人が自分のサーバーに bot を招待する）が無い

`.dev.vars` / Workers vars の `DISCORD_GUILD_ID` に対象サーバーIDを入れ、登録スクリプトはそこへ `PUT` する。

> 将来 bot を他のサーバーにも入れたくなったら、`register` スクリプトの登録先をグローバルに切り替えるだけ（コマンド定義は同じものを使い回せる）。その際は**古いギルドコマンドを空配列で `PUT` して消す**のを忘れずに。

```bash
npm run register            # DISCORD_GUILD_ID へ登録
npm run register -- --clear # 全削除（空配列を PUT）
```

## 6. ディレクトリ構成（機能単位の縦割り）

機能が増えることを前提に、**レイヤ横割りではなく機能ごとの縦割り（feature slice）**にする。
「リマインダーを直すときに触るファイルは `src/features/reminder/` 配下だけ」という状態を保つ。

```
src/
├── index.ts                    # エントリ。fetch() と scheduled() を export
├── env.d.ts                    # Env（D1 binding / vars / secrets）の型
│
├── core/                       # 機能に依存しない土台。ここは滅多に変わらない
│   ├── http.ts                 # Hono app の組み立て
│   ├── verify.ts               # Ed25519 署名検証ミドルウェア
│   ├── router.ts               # interaction を type と名前で dispatch
│   ├── respond.ts              # reply / defer / autocomplete ヘルパ
│   ├── options.ts              # サブコマンドを剥がしてオプションを型付きで取り出す
│   ├── time.ts                 # タイムゾーンを跨ぐ時刻計算（Intl のみ、依存なし）
│   ├── ulid.ts                 # 時系列ソート可能なID（自前の最小実装）
│   ├── cron.ts                 # scheduled() から全 feature の CronJob を回す
│   ├── customId.ts             # ボタン等の custom_id エンコード・デコード
│   ├── registry.ts             # ★ 全 feature を集約する唯一の場所
│   └── types.ts                # Feature / Command / CronJob のインターフェース
│
├── discord/
│   ├── rest.ts                 # Bot Token を使う REST クライアント（薄く）
│   └── mentions.ts             # メンション文字列と allowed_mentions の生成
│
└── features/
    ├── reminder/
    │   ├── index.ts            # Feature オブジェクトを default export
    │   ├── commands.ts         # /remind の定義・ハンドラ・オートコンプリート
    │   ├── components.ts       # 一時停止 / 再開 / 削除ボタン
    │   ├── cron.ts             # 毎分の配信処理（リース取得と結果の確定）
    │   ├── service.ts          # Embed・一覧表示などの組み立て
    │   ├── repository.ts       # D1 アクセス（CRUD + 配信用クエリ）
    │   ├── schedule.ts         # 日時・頻度・cron の解釈と次回発火時刻の計算
    │   └── schema.ts           # 行の型と D1 行 -> ドメイン型の変換
    └── ping/
        └── index.ts            # 最小のお手本として残しておく

scripts/register-commands.ts    # registry から定義を集めて PUT するだけ
migrations/                     # wrangler d1 migrations が生成
test/
```

### 拡張の契約：`Feature` インターフェース

新機能を足す作業を「**ディレクトリを1つ作って registry に1行足す**」だけにする。

```ts
// src/core/types.ts
export type Feature = {
  name: string;
  /** Discord に登録するコマンド定義と、その実行ハンドラ */
  commands?: Command[];
  /** ボタン/セレクト/モーダルのハンドラ。custom_id の namespace で引く */
  components?: Record<string, ComponentHandler>;
  /** 毎分の cron から呼ばれる。自分の担当分だけ処理する */
  cron?: CronJob[];
};

export type Command = {
  definition: RESTPostAPIApplicationCommandsJSONBody; // そのまま PUT できる形
  deferred?: boolean;            // true なら router が自動で type:5 を返す
  handler: (c: CommandContext) => Promise<void | APIInteractionResponse>;
  autocomplete?: (c: AutocompleteContext) => Promise<APICommandAutocompleteResponse>;
};
```

```ts
// src/core/registry.ts  ← 新機能追加時に触るのはここだけ
import reminder from '../features/reminder';
import ping from '../features/ping';

export const features: Feature[] = [ping, reminder];
```

`registry.ts` が
- ルーティング表（コマンド名 → ハンドラ）
- 登録スクリプトが `PUT` する定義の配列
- cron が回すジョブ一覧

の**すべての供給源**になる。定義とハンドラが1箇所にあるので、「コマンドを足したのに登録し忘れて動かない」が構造的に起きない。

### `custom_id` の規約

Discord の `custom_id` は **100文字上限**。ここに JSON を詰めると破綻するので、最初から規約を決めておく。

```
<version>:<feature>:<action>:<arg1>:<arg2>
例) v1:reminder:pause:01JBX7K2ZQ
```

ルータは `:` の2番目で feature を引き当てて委譲する。データが100文字に収まらないものは
**custom_id にはIDだけ入れて、実体は D1 から引き直す**（この方針を崩さない）。

## 7. 環境変数 / シークレット

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

## 8. ローカル開発フロー

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

## 9. マイグレーション運用

`migrations/` に連番の SQL ファイルを手で置く。

```bash
# migrations/0002_xxx.sql を追加したあと
npm run db:migrate:local   # ローカル D1 に適用
npm run db:migrate         # 本番 D1 に適用
```

D1 はどこまで適用したかを Cloudflare 側のテーブルで管理してくれるので、手動管理は不要。
CI（`.github/workflows/deploy.yml`）でも deploy の前に `--remote` で流している。

---

## 10. CI/CD（GitHub Actions・無料）

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

## 11. 段階的な実装順序（推奨）

1. `wrangler.toml` + Hono + `/interactions` で **PING/PONG だけ**返す。Discord Developer Portal にエンドポイント登録が通ることを確認（ここが最初の関門）
2. `core/` の骨組み（registry / router / respond / Feature 型）と `ping` feature を作り、ギルドコマンド登録 → 即時応答（type 4）まで確認
3. defer（type 5 + `waitUntil` + PATCH）のパターンをヘルパ化
4. D1 を作成・バインドし、`reminders` テーブルのマイグレーションを適用
5. `/remind once` と `/remind list` を実装（1回限りのリマインダーが飛べば、土台は全部動いている証明になる）
6. 毎分 Cron を有効化し、配信ループと二重送信対策を入れる
7. `/remind every` / `/remind cron`（繰り返し・回数制限）を追加
8. メンション指定（ユーザー / ロール / @everyone）と `allowed_mentions` を追加
9. `/remind delete` の autocomplete、`pause` / `resume` ボタンを追加
10. CI を入れる

---

## 12. 将来の逃げ道

| 要件が出たら | 対応 |
|---|---|
| メッセージ監視したい | Gateway 常駐が必要。Fly.io / Oracle Cloud Free 等に薄い中継プロセスを置き、イベントを Workers に HTTP で転送する構成にすれば、ロジックは Workers 側に残せる |
| 状態を持った対話 | Durable Objects（無料枠あり）。ただし大抵は D1 + custom_id で足りる |
| 重いバッチ | Queues は有料。Cron Triggers の分割実行で代替 |
| ファイル保存 | R2（無料枠 10GB） |
