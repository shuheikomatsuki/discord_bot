-- 「あとで読む」機能。監視チャンネルに貼られた URL 1つが 1行。
-- 時刻はすべて UNIX 秒 (UTC)。
CREATE TABLE IF NOT EXISTS read_later_items (
  id               TEXT    PRIMARY KEY,
  -- 正規化済み URL（トラッキング用クエリ除去・x.com 統一）。同じ記事の二重登録を防ぐ
  url              TEXT    NOT NULL UNIQUE,
  -- 投稿に添えたメモ（URL を除いた本文）
  note             TEXT,
  -- NULL = まだ取得していない / '' = 取得を試みて失敗した
  title            TEXT,

  -- 元の投稿（「元の投稿へ」リンク用）
  guild_id         TEXT,
  channel_id       TEXT    NOT NULL,
  message_id       TEXT    NOT NULL,
  author_id        TEXT    NOT NULL,
  saved_at         INTEGER NOT NULL,

  status           TEXT    NOT NULL DEFAULT 'unread', -- unread | done | dropped
  snooze_until     INTEGER,                           -- これより前は紹介しない
  snooze_count     INTEGER NOT NULL DEFAULT 0,
  notify_count     INTEGER NOT NULL DEFAULT 0,
  last_notified_at INTEGER,
  resolved_at      INTEGER,                           -- done / dropped になった時刻

  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 毎日の「紹介候補を引く」クエリ用
CREATE INDEX IF NOT EXISTS idx_read_later_items_candidates
  ON read_later_items (status, snooze_until);

-- 取り込みのカーソルや「今日はもう送ったか」などの小さな状態
CREATE TABLE IF NOT EXISTS read_later_state (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
