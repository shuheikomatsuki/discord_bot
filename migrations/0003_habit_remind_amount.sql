-- 未回答の再通知と、量の記録（docs/HABIT.md）

-- 再通知の時刻（0:00 からの分）。NULL = 再通知しない。チェックインの時刻より後でなければ使わない
ALTER TABLE habits ADD COLUMN remind_minute INTEGER;
-- 量を記録する習慣の単位（例: 分 / km / ページ）。NULL = やった・やらないだけ
ALTER TABLE habits ADD COLUMN unit TEXT;
-- 1日の目安量（表示用。下回っても達成として扱う）
ALTER TABLE habits ADD COLUMN daily_target REAL;

-- その日に記録した量
ALTER TABLE habit_checkins ADD COLUMN amount REAL;
-- 再通知を送った時刻（1日1回まで）
ALTER TABLE habit_checkins ADD COLUMN reminded_at INTEGER;

-- 既存の習慣も、23時より前に聞くものは 23:00 に再通知する
UPDATE habits SET remind_minute = 1380 WHERE check_minute < 1380;
