# discord_bot

Cloudflare Workers + Hono + D1 で動く Discord Bot。完全に無料枠の中で完結する。

- スラッシュコマンド（HTTP Interactions 方式）
- リマインダー機能：作成 / 一覧 / 詳細 / 編集 / 一時停止・再開 / 削除
- 繰り返し（周期・cron）、繰り返し回数、メンション対象（ユーザー / ロール / @everyone）を指定可能

設計の詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) と [`docs/REMINDER.md`](docs/REMINDER.md)。

---

## コマンド

```
/remind once   at:<日時>       message:<本文> [mention] [everyone] [channel]
/remind every  interval:<頻度> message:<本文> [count] [start] [mention] [everyone] [channel]
/remind cron   expr:<cron式>   message:<本文> [count] [mention] [everyone] [channel]
/remind list   [mine] [all]
/remind show   id:<ID>
/remind edit   id:<ID> [message] [when] [count] [mention] [everyone] [mention_clear] [channel]
/remind pause  id:<ID>
/remind resume id:<ID>
/remind delete id:<ID>
/ping
```

### 指定できる書式

| 項目 | 例 |
|---|---|
| `at` / `start` / `when`(once) | `09:00`（次に来る9時） `10/01 09:00` `2026-10-01 09:00` `30m`（30分後） `2h` |
| `interval` | `10m` `1h` `1d` `1w` `1h30m`（単位なしの数値は分） |
| `expr` | `0 9 * * 1`（毎週月曜9時） `0 9 1 * *`（毎月1日9時） `30 8 * * 1-5`（平日8:30） `*/15 * * * *` |
| `count` | 1〜1000。未指定なら無限。`edit` では `0` を指定すると無限に戻る |

- 時刻はすべて **JST（`DEFAULT_TIMEZONE`）** で解釈される
- `everyone` は `mention` より優先される
- `id` はオートコンプリートで選べる（26文字を手打ちする必要はない）
- 管理系コマンドの応答は本人にしか見えない（ephemeral）

---

## セットアップ（あなたの作業）

### 1. Discord 側

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application**
2. **Bot** タブ → *Reset Token* → トークンをコピー（これだけが秘密情報）
3. **General Information** から **Application ID** と **Public Key** をコピー
4. **OAuth2 → URL Generator**
   - scopes: `bot`, `applications.commands`
   - bot permissions: `Send Messages`, `Embed Links`, **`Mention @everyone, @here, and All Roles`**
     （最後のものが無いと `@everyone` とロールメンションが飛ばない）
   - 生成された URL を開いて、自分のサーバーに招待する
5. サーバーIDを取得：Discord の 設定 → 詳細設定 → **開発者モード** を ON →
   サーバーを右クリック → *サーバーIDをコピー*

### 2. ローカル

```bash
npm install
cp .dev.vars.example .dev.vars   # 4つの値を埋める
```

`wrangler.jsonc` の `REPLACE_ME` を埋める（Bot Token 以外は秘密情報ではないのでコミットして問題ない）:

```jsonc
"vars": {
  "DISCORD_APPLICATION_ID": "...",
  "DISCORD_PUBLIC_KEY": "...",
  "DISCORD_GUILD_ID": "...",
  "DEFAULT_TIMEZONE": "Asia/Tokyo"
}
```

### 3. Cloudflare

```bash
npx wrangler login
npm run db:create                 # 出力された database_id を wrangler.jsonc に貼る
npm run db:migrate:local          # ローカル D1 にスキーマを適用
npm run db:migrate                # 本番 D1 にスキーマを適用
npx wrangler secret put DISCORD_BOT_TOKEN   # Bot Token を登録
npm run deploy                    # https://discord-bot.<subdomain>.workers.dev が払い出される
```

### 4. エンドポイント登録とコマンド登録

1. Developer Portal → **General Information** → **Interactions Endpoint URL** に
   `https://discord-bot.<subdomain>.workers.dev/interactions` を入力して保存
   （Discord がその場で署名付き PING を送ってくる。ここが通れば土台は動いている）
2. コマンドを登録する：

```bash
npm run register     # DISCORD_GUILD_ID のサーバーへ登録（即時反映）
```

### 5. 動作確認

```
/ping
/remind once at:2m message:テスト
```

2分後に投稿されれば完成。

---

## 開発

```bash
npm run dev         # wrangler dev（ローカル D1 を自動で使う）
npm run typecheck
npm test
npm run lint
npm run format
```

ローカルの Worker に Discord から届かせたい場合は、`cloudflared tunnel --url http://localhost:8787`
などで公開 URL を作り、Interactions Endpoint URL に設定する。
個人利用なら `npm run deploy` が数秒で終わるので、直接デプロイして `npx wrangler tail` で
ログを見るほうが手軽。

### 新しい機能を足すとき

1. `src/features/<機能名>/index.ts` で `Feature` を default export する
2. `src/core/registry.ts` の `features` 配列に1行足す
3. コマンド定義を変えたなら `npm run register`

`src/features/ping/index.ts` が最小のお手本。

---

## 無料枠

| | 無料枠 | 本プロジェクト |
|---|---|---|
| Workers リクエスト | 100,000/日 | コマンド実行ぶんのみ。数百程度 |
| Cron 実行 | 無料枠内 | 毎分1回 = 1,440/日 |
| D1 行読み取り | 5,000,000/日 | 毎分の発火チェックで数行 |
| D1 行書き込み | 100,000/日 | 配信のたびに1行 |

クレジットカード登録は不要。
