# リマインダー機能 設計

`docs/ARCHITECTURE.md` の土台（Hono + Workers + D1 + 毎分 Cron）を前提とした、最初の機能の詳細設計。

---

## 1. 要件

- 任意のメッセージを指定時刻に投稿する
- **繰り返し**（頻度）を設定できる
- **繰り返し回数**を設定できる（無限も可）
- **メンション対象**を選べる：特定ユーザー / ロール / @everyone / メンションなし
- 一覧・停止・再開・削除ができる

---

## 2. コマンド設計

`/remind` 1つにサブコマンドをぶら下げる。トップレベルのコマンド名を増やさないことで、
機能が増えても Discord のコマンド一覧が散らからない。

```
/remind once    at:<日時>        message:<本文> [mention] [everyone] [channel]
/remind every   interval:<頻度>  message:<本文> [count] [start] [mention] [everyone] [channel]
/remind cron    expr:<cron式>    message:<本文> [count] [mention] [everyone] [channel]
/remind list    [all]
/remind show    id:<ID>
/remind pause   id:<ID>
/remind resume  id:<ID>
/remind delete  id:<ID>
```

### オプションの型（Discord の Application Command Option Type）

| オプション | 型 | 必須 | 説明 |
|---|---|---|---|
| `message` | STRING (3) | ✅ | 投稿する本文。最大1500文字程度に制限しておく |
| `at` | STRING (3) | ✅ (once) | `2026-10-01 09:00` / `10/01 09:00` / `09:00`（次に来るその時刻） / `30m`・`2h`（相対） |
| `interval` | STRING (3) | ✅ (every) | `10m` `1h` `1d` `1w` 等。**choices ではなく autocomplete** にして候補提示＋自由入力を両立 |
| `expr` | STRING (3) | ✅ (cron) | 標準5フィールド cron。`0 9 * * 1` = 毎週月曜9時（**JST解釈**） |
| `count` | INTEGER (4) | | 繰り返し回数。1〜1000。**未指定なら無限** |
| `start` | STRING (3) | | 繰り返しの開始時刻。未指定なら「今から1周期後」 |
| `mention` | MENTIONABLE (9) | | ユーザーとロールの**どちらも**受け取れる。これ1つで両対応できる |
| `everyone` | BOOLEAN (5) | | true なら `@everyone` |
| `channel` | CHANNEL (7) | | 投稿先。未指定なら**コマンドを打ったチャンネル** |

> `mention` を MENTIONABLE 型にしているのが要点。USER と ROLE で別オプションに分けると
> 「どちらか片方だけ指定してね」という検証が必要になるが、MENTIONABLE なら Discord 側の
> ピッカーが1つで済む。複数人メンションしたくなったら、後述のスキーマが配列を持てるので
> オプションを `mention2` `mention3` と足すか、モーダルに切り替えれば拡張できる。

### レスポンスの流儀

- 作成系（`once` / `every` / `cron`）: D1 書き込みがあるので **defer（type 5）→ followUp**
- `list` / `show`: D1 読み取り1回。3秒に余裕で収まるので**即時応答（type 4）**でよい
- `pause` / `resume` / `delete`: 即時応答 + Embed 更新
- 作成完了メッセージには **[一時停止] [削除] ボタン**を付ける（`custom_id` = `v1:reminder:pause:<id>`）

---

## 3. D1 スキーマ

```sql
-- migrations/0001_reminders.sql
CREATE TABLE reminders (
  id               TEXT    PRIMARY KEY,              -- ULID（時系列ソート可能・26文字）
  guild_id         TEXT    NOT NULL,
  channel_id       TEXT    NOT NULL,                 -- 投稿先
  created_by       TEXT    NOT NULL,                 -- 作成者のユーザーID
  message          TEXT    NOT NULL,

  -- メンション
  mention_type     TEXT    NOT NULL DEFAULT 'none',  -- none | everyone | here | users | roles
  mention_user_ids TEXT    NOT NULL DEFAULT '[]',    -- JSON配列
  mention_role_ids TEXT    NOT NULL DEFAULT '[]',    -- JSON配列

  -- スケジュール
  timezone         TEXT    NOT NULL DEFAULT 'Asia/Tokyo',
  schedule_kind    TEXT    NOT NULL,                 -- once | interval | cron
  schedule_expr    TEXT    NOT NULL,                 -- once:ISO8601 / interval:秒数 / cron:cron式
  next_fire_at     INTEGER,                          -- UNIX秒(UTC)。NULL = もう発火しない

  -- 繰り返し回数
  max_count        INTEGER,                          -- NULL = 無限
  fired_count      INTEGER NOT NULL DEFAULT 0,

  -- 状態
  status           TEXT    NOT NULL DEFAULT 'active', -- active | paused | completed | failed
  lease_until      INTEGER,                           -- 配信中ロックの期限（UNIX秒）
  last_fired_at    INTEGER,
  last_error       TEXT,

  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 毎分の「発火対象を引く」クエリ専用。これが唯一のホットパス
CREATE INDEX idx_reminders_due ON reminders (status, next_fire_at);
-- /remind list 用
CREATE INDEX idx_reminders_guild ON reminders (guild_id, status);
```

### 設計判断のメモ

- **時刻は全て UNIX秒(UTC) で保存**し、`timezone` 列は「ユーザーがどのタイムゾーンで指定したか」の
  再現用に持つ。`cron` 式の次回計算にはこれが必須（`0 9 * * *` は JST の9時であって UTC の9時ではない）。
  SQLite に timestamp 型は無いので INTEGER が素直。
- **`remaining_count` ではなく `fired_count` + `max_count`** を持つ。減算式だと
  「何回鳴ったか」が失われ、一覧表示で `3/10回` と出せない。
- **配信ログ用の別テーブルは作らない**。D1 無料枠の書き込みは10万行/日と潤沢だが、
  ログは増える一方でメリットが薄い。失敗調査は `last_error` 1列で足りる。
  本格的に要るようになったら `reminder_deliveries` を後から足せばよい。
- `status='failed'` は「チャンネルが消された / 権限が無い」等の**回復不能な失敗**専用。
  一時的な失敗ではこの状態にしない。

---

## 4. 次回発火時刻の計算

`schedule_kind` ごとに `nextFireAt(reminder, after): number | null` を実装する。

| kind | `schedule_expr` | 計算 |
|---|---|---|
| `once` | `1790000000`（発火時刻そのもの） | 1回鳴ったら `null` |
| `interval` | `3600`（周期を秒で保存） | `next += interval` を `> now` になるまで繰り返す |
| `cron` | `0 9 * * 1` | タイムゾーンを考慮して次の一致時刻を求める |

### interval を「秒」で持つ理由
`1w` を「7日後の同時刻」と解釈すれば単純な加算で済み、DST も月末も考えなくてよい。
`P1M`（毎月同日）のような暦ベースの周期が欲しくなったら、それは `cron`（`0 9 1 * *`）で表現する。
**周期系は算術、暦系は cron** と役割を分けておくと、実装が破綻しない。

### cron の次回計算（タイムゾーン対応）
分単位で総当たりすると最大52万回ループしてCPU時間を食う。**日単位で回す**。

```
1. expr をパースして minutes/hours/dom/months/dow の Set を作る
2. after を timezone のローカル日付に変換
3. その日から最大366日ぶんループ:
     - 日付が dom/month/dow に一致しなければ次の日へ
     - 一致したら hours × minutes を昇順に走査し、after より後の最初の時刻を返す
4. ローカル時刻 → UNIX秒(UTC) に戻して返す
```

ローカル⇄UTC変換は `Intl.DateTimeFormat` の `timeZone` 付きフォーマットでオフセットを求める。
Workers は完全な ICU を積んでいるので追加ライブラリは不要（`Asia/Tokyo` は DST が無いので
実質固定オフセットだが、ヘルパは汎用に書いておく）。

---

## 5. 配信ループ（毎分 Cron）

```
scheduled(event, env, ctx):
  now = floor(Date.now()/1000)

  due = SELECT * FROM reminders
        WHERE status = 'active'
          AND next_fire_at IS NOT NULL
          AND next_fire_at <= now
          AND (lease_until IS NULL OR lease_until < now)
        ORDER BY next_fire_at
        LIMIT 25                      -- ★ Workers の subrequest 上限50に対する安全弁

  for r of due:
    ① リースを取る（楽観ロック）
    ② Discord へ POST
    ③ 結果を確定
```

### ① リース取得（二重送信の防止）

Cron の実行が重なったり再試行されたりしても1回しか送らないよう、**UPDATE の戻り行数で所有権を判定**する。

```sql
UPDATE reminders
   SET lease_until = ?now_plus_120, updated_at = ?now
 WHERE id = ?id
   AND status = 'active'
   AND next_fire_at = ?observed_next_fire_at   -- 読んだ時から変わっていないこと
   AND (lease_until IS NULL OR lease_until < ?now);
```

`meta.changes === 1` のときだけ送信に進む。0 なら他の実行が持っていったので**黙ってスキップ**。
リースは120秒で自然に切れるので、途中でWorkerが落ちても次の分で再挑戦される。

### ③ 結果の確定

| 送信結果 | 処理 |
|---|---|
| 成功 | `fired_count+1`、`last_fired_at=now`、`next_fire_at=nextFireAt(...)`、`lease_until=NULL`。`max_count` に達した or 次回が `null` なら `status='completed'` |
| 403 / 404（権限なし・チャンネル削除） | `status='failed'`、`last_error` に記録。**再試行しない** |
| 429 | `lease_until=NULL` に戻し、`next_fire_at` は据え置き。次の分で自然に再試行 |
| 5xx / ネットワーク | 同上（次の分で再試行）。`last_error` だけ更新 |

### 取りこぼしの扱い（catch-up ポリシー）

デプロイや障害で数時間止まっていた場合、`next_fire_at` が大きく過去になる。方針を決めておく。

- **送るのは1回だけ**。`nextFireAt` を `> now` になるまで進めて、間に挟まった分は捨てる
  （毎時のリマインダーが復旧時に6連投されるのは事故）
- ただし `fired_count` はスキップした分も加算し、`max_count` の消費として扱う
- 予定時刻から**1時間以上遅れている場合は本文に `(⚠ 遅延配信)` を付ける**

---

## 6. メンションの実装

Discord は `content` に `<@123>` と書いただけでは**通知が飛ばない場合がある**。
`allowed_mentions` を明示するのが必須。

```ts
// src/discord/mentions.ts
function buildMention(r: Reminder): { prefix: string; allowed_mentions: AllowedMentions } {
  switch (r.mention_type) {
    case 'none':
      return { prefix: '', allowed_mentions: { parse: [] } };
    case 'everyone':
      return { prefix: '@everyone ', allowed_mentions: { parse: ['everyone'] } };
    case 'users':
      return {
        prefix: r.mention_user_ids.map((id) => `<@${id}>`).join(' ') + ' ',
        allowed_mentions: { parse: [], users: r.mention_user_ids },  // parse:[] で事故を防ぐ
      };
    case 'roles':
      return {
        prefix: r.mention_role_ids.map((id) => `<@&${id}>`).join(' ') + ' ',
        allowed_mentions: { parse: [], roles: r.mention_role_ids },
      };
  }
}
```

- **`parse: []` を必ず入れる**。これを省くと、ユーザーが本文に書いた `@everyone` が
  意図せず発火する。本文は完全に信用しない前提で組む。
- `@everyone` とロールメンションには、Bot に **Mention @everyone, @here, and All Roles** 権限が必要。
  Bot 招待URLの permissions に含めておく。
- 作成時に「そのチャンネルへの送信権限があるか」を厳密に検証するのは重いので、
  **初回配信の失敗で `status='failed'` にして通知する**ほうが実装が素直。

---

## 7. `/remind list` の表示

```
📋 このサーバーのリマインダー (3件)

🟢 01JBX7K2ZQ  毎日 09:00        「朝会やるよ」        @everyone     12/∞
🟢 01JBX9M4AA  毎週月 10:00      「ゼミの課題」        @ゼミ         2/10
⏸ 01JBXB1CCC  2026-10-01 18:00  「レポート提出」      @komashuhei   0/1
```

- ID は ULID の**先頭を表示**し、`/remind delete` では autocomplete で補完させる
  （ユーザーに26文字を手打ちさせない）
- autocomplete は **defer できない**（3秒以内に必ず返す必要がある）が、
  `guild_id` インデックス付きの `LIMIT 25` なら D1 で十分間に合う
- 自分が作ったものだけを既定表示し、`all: true` で全員ぶんを出す

---

## 8. この設計が次の機能にどう効くか

`reminders` テーブルと配信ループは、**「時刻が来たら何かする」機能の共通基盤**になっている。

| 将来の機能 | 再利用できるもの |
|---|---|
| 投票の締切通知 | 配信ループ、メンション生成 |
| 定期的な当番のローテーション通知 | cron スケジュール、回数管理 |
| 一定時間後にメッセージを消す | リース機構、`CronJob` インターフェース |
| 天気予報の朝の自動投稿 | `CronJob` を1つ足すだけ |

新機能が `CronJob` を実装して registry に登録すれば、**毎分の Cron は1本のまま**増やせる。
Cloudflare 側の cron 定義を機能ごとに増やさないのが、この設計の一番の狙い。

---

## 9. 実装状況

この設計はすべて実装済み。対応は次のとおり。

| 設計 | 実装 |
|---|---|
| コマンド設計（§2） | `src/features/reminder/commands.ts` |
| スキーマ（§3） | `migrations/0001_create_reminders.sql` / `src/features/reminder/schema.ts` |
| 次回発火時刻の計算（§4） | `src/features/reminder/schedule.ts`（`test/schedule.test.ts` で検証） |
| 配信ループ・リース（§5） | `src/features/reminder/cron.ts` / `repository.ts` の `claim()` |
| メンション（§6） | `src/discord/mentions.ts`（`test/core.test.ts` で検証） |
| 一覧表示（§7） | `src/features/reminder/service.ts` |

設計からの差分は2点のみ。

- **ORM を入れなかった**。テーブルが1つで、リースの楽観ロックに `meta.changes` を直接見たいため、
  D1 の prepared statement を `repository.ts` で薄く包む形にした。
- **`/remind edit` を追加した**。作成・参照・削除だけでは更新ができず CRUD が閉じないため。
  スケジュールの差し替えは既存の `schedule_kind` の意味で解釈する（once なら日時、every なら頻度、cron なら式）。
