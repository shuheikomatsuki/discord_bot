# discord_bot

Cloudflare Workers + Hono + D1 で動く Discord Bot。完全に無料枠の中で完結する。

- スラッシュコマンド（HTTP Interactions 方式）
- リマインダー機能：作成 / 一覧 / 詳細 / 編集 / 一時停止・再開 / 削除
- 繰り返し（周期・cron）、繰り返し回数、メンション対象（ユーザー / ロール / @everyone）を指定可能
- 習慣化・目標達成：毎日のチェックイン、連続記録とフリーズ、週次・月次の振り返り、絵文字カレンダー、XP・レベル・バッジ

設計の詳細は [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/REMINDER.md`](docs/REMINDER.md)、[`docs/HABIT.md`](docs/HABIT.md)。

---

## コマンド

```
/remind once   at:<日時>       message:<本文> [mention〜mention5] [everyone] [channel]
/remind every  interval:<頻度> message:<本文> [count] [start] [mention〜mention5] [everyone] [channel]
/remind cron   expr:<cron式>   message:<本文> [count] [mention〜mention5] [everyone] [channel]
/remind list   [mine] [all]
/remind show   id:<ID>
/remind edit   id:<ID> [message] [when] [count] [mention〜mention5] [everyone] [mention_clear] [channel]
/remind pause  id:<ID>
/remind resume id:<ID>
/remind delete id:<ID>
/ping

/habit add   name:<名前> time:<21:00> [days] [channel] [auto_freeze]
/habit list | done | freeze | edit | pause | resume | delete | settings
/goal  add   name:<目標> [target] [unit] [start] [deadline]
/goal  log | list | show | complete | delete
/stats week | month | profile | ranking | reflections
```

習慣・目標の詳しい使い方は [`docs/HABIT.md`](docs/HABIT.md)。

### `every` と `cron` の使い分け

繰り返しの指定方法は2種類ある。**周期で考えるか、暦で考えるか**で選ぶ。

| | `/remind every` | `/remind cron` |
|---|---|---|
| 考え方 | 前回から◯◯後（相対） | 暦のこの位置（絶対） |
| 指定 | `interval:1d` | `expr:0 9 * * *` |
| 開始時刻 | `start` で自由に決められる | 暦で決まるので指定不可 |
| 得意なこと | 90分ごと、3時間ごとなど暦に乗らない周期 | 毎週月曜、毎月1日、平日のみ、1日2回 |
| できないこと | 「毎月1日」（月の長さが違うため） | 「今から40分ごと」のような任意の刻み |

日次や週次のように**両方で書ける場合は `every` のほうが簡単**。
`every` で書けないものが出てきたら `cron` を使う、という順で考えるとよい。

```
/remind every interval:1d  message:朝会           → 24時間ごと（開始は今から24時間後）
/remind every interval:1d  message:朝会 start:09:00 → 明日9時から24時間ごと
/remind cron  expr:0 9 * * *   message:朝会        → 毎日9時（上と同じ結果）

/remind every interval:90m message:休憩           → 90分ごと（cron では書けない）
/remind cron  expr:0 9 1 * *   message:家賃       → 毎月1日9時（every では書けない）
/remind cron  expr:30 8 * * 1-5 message:出発       → 平日8:30（every では書けない）
/remind cron  expr:0 9,18 * * * message:打刻       → 毎日9時と18時（every では書けない）
```

### cron 式の書き方

標準の5フィールド。左から **分 時 日 月 曜**。

```
0 9 * * 1
│ │ │ │ └─ 曜日 0-7（0と7が日曜、1が月曜 … 6が土曜）
│ │ │ └─── 月   1-12
│ │ └───── 日   1-31
│ └─────── 時   0-23
└───────── 分   0-59
```

各フィールドに書けるもの:

| 書き方 | 意味 | 例 |
|---|---|---|
| `*` | すべて | `* * * * *` = 毎分 |
| `5` | その値だけ | `0 9 * * *` = 毎日9:00 |
| `1-5` | 範囲 | `0 9 * * 1-5` = 平日9:00 |
| `1,15` | 複数指定 | `0 9 1,15 * *` = 毎月1日と15日の9:00 |
| `*/15` | ◯おき | `*/15 * * * *` = 15分おき |

よく使う例:

| やりたいこと | cron 式 |
|---|---|
| 毎日9時 | `0 9 * * *` |
| 毎週月曜9時 | `0 9 * * 1` |
| 平日8:30 | `30 8 * * 1-5` |
| 毎週末10時 | `0 10 * * 0,6` |
| 毎月1日9時 | `0 9 1 * *` |
| 毎月25日12時 | `0 12 25 * *` |
| 毎日9時と18時 | `0 9,18 * * *` |
| 30分おき | `*/30 * * * *` |

**注意: 日と曜日の両方を `*` 以外にすると OR 条件になる**（標準 cron の仕様）。
`0 9 1 * 1` は「毎月1日 **または** 毎週月曜の9時」であって、「1日が月曜のときだけ」ではない。
どちらか一方は `*` にしておくのが安全。

### その他の指定

| 項目 | 例 | 備考 |
|---|---|---|
| `at` / `start` / `when`(once) | `09:00` `10/01 09:00` `2026-10-01 09:00` `30m` `2h` | `09:00` は「次に来る9時」。年を省いて過去になる日付は翌年扱い |
| `interval` | `10m` `1h` `1d` `1w` `1h30m` | 単位なしの数値は分。最短1分、最長1年 |
| `count` | `3` | 未指定なら無限。`edit` で `0` を指定すると無限に戻る |
| `mention` 〜 `mention5` | ユーザーまたはロールを選択 | ピッカーから選ぶ。複数人なら `mention2` 以降も使う（ユーザーとロールの混在可、最大5つ） |
| `everyone` | `true` | `mention` より優先される |
| `channel` | チャンネルを選択 | 未指定ならコマンドを打ったチャンネル |

- 時刻はすべて **JST**（`DEFAULT_TIMEZONE`）で解釈される
- `id` はオートコンプリートで選べる。26文字を手打ちする必要はない
- 管理系コマンドの応答は本人にしか見えない（ephemeral）。リマインダー本体の投稿は全員に見える
- `/remind edit` の `when` は、対象の種類に応じて解釈が変わる
  （`once` なら日時、`every` なら頻度、`cron` なら cron 式）

---

## セットアップ

前提: [Cloudflare のアカウント](https://dash.cloudflare.com/sign-up)（無料。カード登録不要）と Node.js 22 以上。

Application ID / Public Key / サーバーID は `wrangler.jsonc` と `.dev.vars.example` に
記入済み。埋める必要があるのは **Bot Token** と **D1 の database_id** の2つだけ。

### 1. Discord 側

1. [Developer Portal](https://discord.com/developers/applications) → 対象アプリ → **Bot** タブ
   → *Reset Token* でトークンを発行してコピー（一度しか表示されない）
2. **OAuth2 → URL Generator**
   - scopes: `bot`, `applications.commands`
   - bot permissions: `Send Messages`, `Embed Links`,
     **`Mention @everyone, @here, and All Roles`**
     （最後のものが無いと `@everyone` とロールメンションが飛ばない）
   - 生成された URL を開いてサーバーに招待する

### 2. 手元で実行する

```bash
npm install                                  # 依存の取得（wrangler もここに入る）
cp .dev.vars.example .dev.vars               # DISCORD_BOT_TOKEN の行だけ埋める

npx wrangler login                           # ブラウザが開くので許可する
npm run db:create                            # 出力された database_id を wrangler.jsonc に貼る
npm run db:migrate                           # 本番 D1 にテーブルを作る
npm run deploy                               # ★ ここで Worker の URL が表示される
npx wrangler secret put DISCORD_BOT_TOKEN    # プロンプトにトークンを貼る
```

`npm run deploy` の出力に出る URL（`https://discord-bot.<サブドメイン>.workers.dev`）を控える。

### 3. Discord に URL を教える

Developer Portal → 対象アプリ → **General Information** →
**Interactions Endpoint URL** に次を入力して *Save Changes*：

```
https://discord-bot.<サブドメイン>.workers.dev/interactions
```

保存した瞬間に Discord が署名付きの PING を送ってくる。検証に失敗すると保存自体が
弾かれるので、**保存できたら土台は正しく動いている**という確認になる。

### 4. コマンドを登録する

```bash
npm run register     # ギルドコマンドとして登録（即時反映）
```

同じアプリケーションを以前にも使っていて古いコマンドが残っている場合は、
現状を確認してから消す。

```bash
npm run register -- --list             # グローバル / ギルドの登録状況を表示
npm run register -- --global --clear   # 古いグローバルコマンドを削除
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
