# 習慣化・目標達成機能（`src/features/habit/`）

決まった時刻にチャンネルで「やった？」と聞き、ボタンで答えて記録を続ける機能。
目標の数値管理、週次・月次の振り返り、XP・レベル・バッジも同じ feature に入っている。

## 基本ルール

- **ユーザーごとに分かれる。** すべての行が `(guild_id, user_id)` を持ち、操作できるのは自分の習慣・目標だけ。ボタンも本人以外が押すと断る
- **1日の区切りは深夜0時**（`DEFAULT_TIMEZONE`、既定は Asia/Tokyo）。当日中なら回答を押し直せる
- **サーバー内のチャンネルだけ**で動く（DM は使わない）。コマンドの返信は本人にしか見えない（ephemeral）。チェックインとまとめはチャンネルに投稿され、本人にメンションが付く

## コマンド

```
/habit add      name time [days] [channel] [auto_freeze]   習慣を登録（例: time:21:00 days:平日）
/habit list                                                自分の習慣・レベル・フリーズ在庫
/habit done     id [note]                                  今日の分を今すぐ記録（通知前にやり終えたとき）
/habit freeze   id [days] [start]                          休む日を前もってフリーズ
/habit edit     id [name] [time] [days] [channel] [auto_freeze]
/habit pause | resume | delete  id
/habit settings [summary_channel] [hide_ranking]           まとめの投稿先・ランキング表示

/goal add       name [target] [unit] [start] [deadline]    例: name:TOEIC target:800 unit:点 deadline:2027-03-31
/goal log       id value [mode:足す|現在値にする] [note]   目標値に届くと自動で達成
/goal list [all] | show id | complete id | delete id

/stats week [last]        今週（先週）の達成状況
/stats month [month]      月のカレンダー（例: 2026-10 / last）
/stats profile [user]     レベル・XP・バッジ・連続記録
/stats ranking            サーバー内の XP ランキング
/stats reflections        過去の振り返り
```

`days` は `毎日` / `平日` / `土日` / `月水金` / `mon,wed,fri` などで指定できる。

## チェックインの流れ

```
毎分の cron
  ├─ habit:prompt  next_prompt_at を過ぎた習慣を投稿（✅やった / 📝メモして記録 / 🧊フリーズ / ❌できなかった）
  │                その日の行が既にあれば（/habit done 済み・フリーズ予約済み）投稿しない
  ├─ habit:close   前日以前で未回答の行を締める（偶数分のみ）
  │                auto_freeze がオンでフリーズの在庫があれば frozen、なければ missed にしてボタンを外す
  └─ habit:summary 月曜9時以降に先週、毎月1日9時以降に先月のまとめを送る（奇数分のみ・1分1人）
```

二重投稿は reminder と同じ楽観ロック（`next_prompt_at` を条件にした UPDATE + リース）と、
`habit_checkins` の `UNIQUE (habit_id, date)` で防いでいる。

### 1日の状態

| 状態 | 意味 | 連続記録 |
|---|---|---|
| `pending` | 投稿済み・回答待ち | 判定を保留 |
| `done` | やった | +1 |
| `frozen` | フリーズ | 増えないが途切れない |
| `missed` | できなかった / 未回答 | 0 に戻る |

予定外の曜日や一時停止中の日は行が作られないので、連続記録には影響しない。

## ゲーミフィケーション（数値は `gamification.ts`）

| 出来事 | XP |
|---|---|
| チェックイン達成（その日の初回だけ。押し直しでは増えない） | 10 |
| 連続記録が7の倍数 / 30日 / 100日 / 365日 | +20 / +50 / +200 / +500 |
| 目標の記録（1目標1日1回まで） | 5 |
| 目標達成 | 100 |
| 振り返りを書く（期間ごとに初回だけ） | 15 |

- レベル L に必要な累計 XP は `25 × (L-1)²`（Lv2=25, Lv5=400, Lv10=2025）
- **フリーズ**は最初に1個。連続記録が7の倍数になるたびに1個もらえ、最大3個まで持てる
- バッジは15種類（はじめの一歩、3/7/30/100/365日連続、累計50/100/500回、目標達成1/5個、Lv5/10、初めての振り返り、パーフェクトウィーク）

## 可視化

Workers では画像を作りにくいので絵文字で描く。

```
月　火　水　木　金　土　日
🟩🟩🟨🟩🧊⬜🟥
🟩🟩🟩🟦⬛⬛⬛
```

🟩達成 🟨一部（複数習慣のうち一部）🟥未達 🧊フリーズ 🟦回答待ち ⬜予定なし ⬛未来。
目標は `▰▰▰▱▱` の進捗バーと `▁▃▅▇` の推移で表示する。

## D1 の負荷について

Workers Free では、1回の起動で使える D1 クエリの数に上限がある（50前後）。毎分の cron は reminder も含めて
1回の起動を共有するので、1分あたりの処理件数を絞っている（prompt 5件、close 3件、summary 1人）。
残りは次の分に持ち越されるだけなので、同じ時刻の習慣が多くても数分のうちにすべて処理される。

## テスト

- `test/habit.logic.test.ts` … 日付・連続記録・XP・バッジ・描画の純粋関数
- `test/habit.flow.test.ts` … `node:sqlite` に migrations を流した D1 互換シム（`test/helpers/d1.ts`）で、
  回答・締め切り・投稿・まとめを通しで確認する。Discord への送信は fetch をモックする
