-- 習慣化・目標達成・ゲーミフィケーション（docs/HABIT.md）
-- 時刻は UNIX 秒 (UTC)。日付は「ユーザーのタイムゾーンでの暦日」を 'YYYY-MM-DD' で持つ。
-- 1日の区切りは深夜0時。すべての行は (guild_id, user_id) でユーザーを分ける。

-- 習慣。毎日決まった時刻にチャンネルでチェックインを聞く
CREATE TABLE IF NOT EXISTS habits (
  id             TEXT    PRIMARY KEY,
  guild_id       TEXT    NOT NULL,
  user_id        TEXT    NOT NULL,
  channel_id     TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  timezone       TEXT    NOT NULL DEFAULT 'Asia/Tokyo',
  check_minute   INTEGER NOT NULL,                  -- 0:00 からの分（21:00 なら 1260）
  days_mask      INTEGER NOT NULL DEFAULT 127,      -- bit0=日 … bit6=土
  auto_freeze    INTEGER NOT NULL DEFAULT 1,        -- 未回答の日に在庫があれば自動でフリーズを使う
  status         TEXT    NOT NULL DEFAULT 'active', -- active | paused
  next_prompt_at INTEGER,                           -- 次に聞く時刻。paused なら NULL
  lease_until    INTEGER,                           -- 送信中ロック
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  total_done     INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_habits_due ON habits (status, next_prompt_at);
CREATE INDEX IF NOT EXISTS idx_habits_user ON habits (guild_id, user_id);

-- 1習慣 × 1日 = 1行
CREATE TABLE IF NOT EXISTS habit_checkins (
  id          TEXT    PRIMARY KEY,
  habit_id    TEXT    NOT NULL REFERENCES habits (id) ON DELETE CASCADE,
  guild_id    TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  date        TEXT    NOT NULL,                     -- 'YYYY-MM-DD'
  status      TEXT    NOT NULL,                     -- pending | done | missed | frozen
  note        TEXT,
  channel_id  TEXT,                                 -- チェックインを投稿したメッセージ
  message_id  TEXT,
  xp_awarded  INTEGER NOT NULL DEFAULT 0,           -- 付け外しで XP を稼げないよう初回だけ付与
  answered_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (habit_id, date)
);

CREATE INDEX IF NOT EXISTS idx_checkins_pending ON habit_checkins (status, date);
CREATE INDEX IF NOT EXISTS idx_checkins_user_date ON habit_checkins (guild_id, user_id, date);

-- 目標。数値目標（target あり）と、達成/未達成だけの目標（target なし）
CREATE TABLE IF NOT EXISTS goals (
  id           TEXT    PRIMARY KEY,
  guild_id     TEXT    NOT NULL,
  user_id      TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  unit         TEXT    NOT NULL DEFAULT '',
  start_value  REAL    NOT NULL DEFAULT 0,
  target_value REAL,                                -- NULL = 数値なし
  current      REAL    NOT NULL DEFAULT 0,
  deadline     TEXT,                                -- 'YYYY-MM-DD'
  status       TEXT    NOT NULL DEFAULT 'active',   -- active | completed
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goals_user ON goals (guild_id, user_id, status);

CREATE TABLE IF NOT EXISTS goal_logs (
  id         TEXT    PRIMARY KEY,
  goal_id    TEXT    NOT NULL REFERENCES goals (id) ON DELETE CASCADE,
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  date       TEXT    NOT NULL,
  mode       TEXT    NOT NULL,                      -- add | set
  value      REAL    NOT NULL,
  after      REAL    NOT NULL,                      -- 記録後の current
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goal_logs_goal ON goal_logs (goal_id, created_at);

-- ユーザーごとの XP・フリーズ在庫・振り返りの送信状況
CREATE TABLE IF NOT EXISTS habit_profiles (
  guild_id           TEXT    NOT NULL,
  user_id            TEXT    NOT NULL,
  xp                 INTEGER NOT NULL DEFAULT 0,
  freezes            INTEGER NOT NULL DEFAULT 1,
  summary_channel_id TEXT,                          -- 週次・月次まとめの投稿先
  hide_ranking       INTEGER NOT NULL DEFAULT 0,
  last_weekly_key    TEXT,                          -- 送信済みの週（その週の月曜の日付）
  last_monthly_key   TEXT,                          -- 送信済みの月 'YYYY-MM'
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS habit_badges (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  badge      TEXT    NOT NULL,
  awarded_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, badge)
);

-- 週次・月次の振り返り（うまくいったこと / 改善点 / 次にやること）
CREATE TABLE IF NOT EXISTS habit_reflections (
  guild_id   TEXT    NOT NULL,
  user_id    TEXT    NOT NULL,
  period     TEXT    NOT NULL,                      -- week | month
  period_key TEXT    NOT NULL,                      -- 週: 月曜の日付 / 月: 'YYYY-MM'
  good       TEXT,
  bad        TEXT,
  next       TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, period, period_key)
);
