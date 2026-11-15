# あとで読む（readLater）

自分のチャンネルに貼った記事 URL を、毎日決まった時刻に数件ずつ「今日の1本」として紹介する機能。
「Discord に送って満足して、結局読まない」を減らすのが目的。

## 動き

```
[自分] #あとで読む に URL を貼る（X の共有ボタン → Discord でも、コピペでも）
          │
          ▼  5分おき（cron）: チャンネル履歴を読んで D1 に取り込む
[D1] read_later_items（URL 1つ = 1行、正規化して重複排除）
          │
          ▼  毎日 READ_LATER_DIGEST_TIME に1回
[bot] 未読キューの先頭から数件紹介（FIFO）
      ┌──────────────────────────────────────┐
      │ Rustで学ぶ非同期処理の仕組み            │
      │ 💬 あとで試す                           │
      │ https://zenn.dev/...                   │
      │ 📅 2026/09/03 に保存（72日前）・元の投稿 │
      │ [✅ 読んだ] [🔁 7日後にまた] [🗑️ いらない] │
      └──────────────────────────────────────┘
```

| ボタン | 結果 |
|---|---|
| ✅ 読んだ | もう紹介しない |
| 🔁 N日後にまた | N 日間は飛ばす。明けたらキューの前の方に戻るので、すぐまた紹介される。3回以上スヌーズすると「そろそろ決めよう」と表示 |
| 🗑️ いらない | もう紹介しない |
| ↩️ 元に戻す | 押し間違いの取り消し（操作後に出る） |
| 何も押さない | キューの最後尾に並び直す（未読が一巡したらまた紹介される） |

- ボタンを押せるのは `READ_LATER_OWNER_ID` の人だけ
- 取り込むのは `READ_LATER_OWNER_ID` の人の投稿だけ。bot や他人の投稿は無視する
- 見るチャンネルは `READ_LATER_SOURCE_CHANNEL_ID` だけ。他のサーバー・チャンネルは一切読まない
- スラッシュコマンドは持たないので、友人サーバーのコマンド一覧は変わらない
- 紹介できる記事が無い日は何も送らない

### 記事の選び方（FIFO キュー）
未読を「キューに入った順」に並べ、先頭から `READ_LATER_DIGEST_COUNT` 件を紹介する（`repository.ts` の `findQueueHead`）。

- キューに入った時刻 = 最後に紹介した時刻。まだ一度も紹介していなければ保存した時刻
- つまり **古く保存したものから順に** 紹介され、紹介した記事は最後尾に並び直す
- 未読が一巡するまで同じ記事は出てこない（未読 30 件・1日 3 件なら 10 日で一巡）
- スヌーズ中は飛ばす。明けたら最後に紹介した時点の位置に戻るので、後から保存した記事より先に出る

### URL の扱い（`urls.ts`）
- 1つの投稿に URL が複数あれば、それぞれ別の記事にする
- URL 以外の本文は「メモ」として紹介時に表示する（なぜ保存したか思い出せるように）
- `twitter.com` / `mobile.x.com` などは `x.com` に統一し、`?s=20&t=...` や `utm_*` を落として重複判定する
- 転送（Forward）したメッセージの URL も拾う

### タイトル（`title.ts`）
紹介する直前に1度だけ取得して D1 に保存する。
- 普通のページ: `og:title` → `<title>`
- X のポスト: ログインが必要で HTML から取れないので、認証不要の oEmbed（`publish.twitter.com`）で投稿者名と本文を取る
- 取れなければ URL のホスト名を表示する

## セットアップ

### 1. Discord 側
1. Developer Portal > 対象アプリ > **Bot** > **Message Content Intent を ON**
   - OFF のままだと履歴の本文が空で返ってくる。その場合は取り込みを止めてログにエラーを出す（カーソルを進めて取りこぼさないため）
2. Discord の設定 > 詳細設定 > **開発者モードを ON**
3. 次の ID をコピーする（右クリック >「ID をコピー」）
   - URL を貼るチャンネル
   - 紹介を送るチャンネル（同じでよければ不要）
   - 自分のユーザー ID（自分のアイコンを右クリック）
4. bot がそのチャンネルで **チャンネルを見る / メッセージ履歴を読む / メッセージを送信 / 埋め込みリンク** を持っていることを確認

### 2. 設定
`wrangler.jsonc` の `vars` に入れる（いずれも秘密情報ではない）。

| 変数 | 既定 | 説明 |
|---|---|---|
| `READ_LATER_SOURCE_CHANNEL_ID` | （空＝無効） | URL を貼るチャンネル |
| `READ_LATER_NOTIFY_CHANNEL_ID` | SOURCE と同じ | 紹介を送るチャンネル |
| `READ_LATER_OWNER_ID` | （空＝無効） | 自分のユーザー ID |
| `READ_LATER_DIGEST_TIME` | `08:00` | 紹介する時刻（`DEFAULT_TIMEZONE`） |
| `READ_LATER_DIGEST_COUNT` | `3` | 1回に紹介する件数（最大 5） |
| `READ_LATER_SNOOZE_DAYS` | `7` | 🔁 で何日後に戻すか |

### 3. 反映
```bash
npm run db:migrate   # 0002_create_read_later.sql を本番 D1 に適用
npm run deploy
```
コマンド登録（`npm run register`）は不要。

### 4. 動作確認
`READ_LATER_DIGEST_TIME` を数分後にしてデプロイし、その時刻に紹介が届くか確認する。
初回は過去の投稿を古い順に取り込む（1回 300 件まで、5 分おきに続きを読む）。

> 同じ日にもう一度試したいときは、その日の送信記録を消す:
> `npx wrangler d1 execute discord-bot --remote --command "DELETE FROM read_later_state WHERE key = 'digest:last'"`

## D1

`migrations/0002_create_read_later.sql`

- `read_later_items`: 記事 1件 = 1行。`url` は UNIQUE
- `read_later_state`: 小さな key-value
  - `cursor:<channelId>`: どこまで取り込んだか（メッセージ ID）
  - `guild:<channelId>`: 「元の投稿へ」リンク用のサーバー ID
  - `digest:last`: 最後に紹介した日付。`UPDATE ... WHERE value <> 今日` の楽観ロックで二重送信を防ぐ

## 無料枠への影響
- cron は既存の毎分1本に相乗り。紹介時刻前の大半の分は何もせず return する
- Discord API: 5 分おきに履歴取得 1 回（1日 288 回）+ 紹介時に数回
- D1: 1日数百行の読み書き程度
