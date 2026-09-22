-- リマインダー本体。時刻はすべて UNIX 秒 (UTC) で保存し、
-- timezone 列は「ユーザーがどのタイムゾーンで指定したか」の再現用に持つ。
CREATE TABLE IF NOT EXISTS reminders (
  id               TEXT    PRIMARY KEY,
  guild_id         TEXT    NOT NULL,
  channel_id       TEXT    NOT NULL,
  created_by       TEXT    NOT NULL,
  message          TEXT    NOT NULL,

  -- メンション
  mention_type     TEXT    NOT NULL DEFAULT 'none',   -- none | everyone | here | users | roles
  mention_user_ids TEXT    NOT NULL DEFAULT '[]',     -- JSON 配列
  mention_role_ids TEXT    NOT NULL DEFAULT '[]',     -- JSON 配列

  -- スケジュール
  timezone         TEXT    NOT NULL DEFAULT 'Asia/Tokyo',
  schedule_kind    TEXT    NOT NULL,                  -- once | interval | cron
  schedule_expr    TEXT    NOT NULL,                  -- once:UNIX秒 / interval:秒 / cron:cron式
  next_fire_at     INTEGER,                           -- NULL = もう発火しない

  -- 繰り返し回数（減算ではなく加算で持つ。一覧に "3/10回" と出せるようにするため）
  max_count        INTEGER,                           -- NULL = 無限
  fired_count      INTEGER NOT NULL DEFAULT 0,

  -- 状態
  status           TEXT    NOT NULL DEFAULT 'active', -- active | paused | completed | failed
  lease_until      INTEGER,                           -- 配信中ロックの期限
  last_fired_at    INTEGER,
  last_error       TEXT,

  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 毎分の「発火対象を引く」クエリ専用。唯一のホットパス
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (status, next_fire_at);

-- /remind list 用
CREATE INDEX IF NOT EXISTS idx_reminders_guild ON reminders (guild_id, status);
