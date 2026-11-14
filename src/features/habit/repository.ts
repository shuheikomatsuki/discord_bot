/**
 * 習慣・目標・プロフィールの D1 アクセス。
 * どのクエリも guild_id と user_id で絞り、ユーザー同士のデータが混ざらないようにする。
 */
import { normalizeIdish } from '../reminder/repository';
import {
  type Checkin,
  type CheckinRow,
  type Goal,
  type GoalLog,
  type GoalRow,
  type Habit,
  type HabitRow,
  type HabitStatus,
  type Profile,
  type ProfileRow,
  toCheckin,
  toGoal,
  toHabit,
  toProfile,
} from './schema';
import type { CheckinStatus, DayRecord } from './streak';

const changed = (r: D1Result): boolean => (r.meta.changes ?? 0) > 0;

// ================================================================ habits

const HABIT_COLUMNS = `id, guild_id, user_id, channel_id, name, timezone, check_minute, days_mask,
  auto_freeze, status, next_prompt_at, lease_until, current_streak, best_streak, total_done,
  last_error, remind_minute, unit, daily_target, created_at, updated_at`;

export interface NewHabit {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  name: string;
  timeZone: string;
  checkMinute: number;
  daysMask: number;
  autoFreeze: boolean;
  nextPromptAt: number;
  remindMinute?: number | null;
  unit?: string | null;
  dailyTarget?: number | null;
  now: number;
}

export async function insertHabit(db: D1Database, h: NewHabit): Promise<void> {
  await db
    .prepare(
      `INSERT INTO habits (id, guild_id, user_id, channel_id, name, timezone, check_minute,
         days_mask, auto_freeze, status, next_prompt_at, remind_minute, unit, daily_target,
         created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?12, ?13, ?14, ?11, ?11)`,
    )
    .bind(
      h.id,
      h.guildId,
      h.userId,
      h.channelId,
      h.name,
      h.timeZone,
      h.checkMinute,
      h.daysMask,
      h.autoFreeze ? 1 : 0,
      h.nextPromptAt,
      h.now,
      h.remindMinute ?? null,
      h.unit ?? null,
      h.dailyTarget ?? null,
    )
    .run();
}

export async function getHabit(db: D1Database, id: string): Promise<Habit | null> {
  const row = await db
    .prepare(`SELECT ${HABIT_COLUMNS} FROM habits WHERE id = ?1`)
    .bind(id)
    .first<HabitRow>();
  return row ? toHabit(row) : null;
}

/** 自分の習慣を、完全な ID でも末尾数文字でも引けるようにする */
export async function findHabit(
  db: D1Database,
  guildId: string,
  userId: string,
  idish: string,
): Promise<Habit | null> {
  const needle = normalizeIdish(idish);
  if (!needle) return null;
  const row = await db
    .prepare(
      `SELECT ${HABIT_COLUMNS} FROM habits
       WHERE guild_id = ?1 AND user_id = ?2 AND (id = ?3 OR substr(id, -length(?3)) = ?3)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(guildId, userId, needle)
    .first<HabitRow>();
  return row ? toHabit(row) : null;
}

export async function listHabits(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<Habit[]> {
  const { results } = await db
    .prepare(
      `SELECT ${HABIT_COLUMNS} FROM habits WHERE guild_id = ?1 AND user_id = ?2
       ORDER BY status ASC, check_minute ASC LIMIT 25`,
    )
    .bind(guildId, userId)
    .all<HabitRow>();
  return (results ?? []).map(toHabit);
}

export interface HabitPatch {
  name?: string;
  channelId?: string;
  checkMinute?: number;
  daysMask?: number;
  autoFreeze?: boolean;
  status?: HabitStatus;
  nextPromptAt?: number | null;
  remindMinute?: number | null;
  unit?: string | null;
  dailyTarget?: number | null;
}

export async function updateHabit(
  db: D1Database,
  id: string,
  patch: HabitPatch,
  now: number,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  };
  if (patch.name !== undefined) push('name', patch.name);
  if (patch.channelId !== undefined) push('channel_id', patch.channelId);
  if (patch.checkMinute !== undefined) push('check_minute', patch.checkMinute);
  if (patch.daysMask !== undefined) push('days_mask', patch.daysMask);
  if (patch.autoFreeze !== undefined) push('auto_freeze', patch.autoFreeze ? 1 : 0);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.nextPromptAt !== undefined) push('next_prompt_at', patch.nextPromptAt);
  if (patch.remindMinute !== undefined) push('remind_minute', patch.remindMinute);
  if (patch.unit !== undefined) push('unit', patch.unit);
  if (patch.dailyTarget !== undefined) push('daily_target', patch.dailyTarget);
  if (sets.length === 0) return false;
  push('updated_at', now);
  binds.push(id);
  return changed(
    await db
      .prepare(`UPDATE habits SET ${sets.join(', ')} WHERE id = ?${binds.length}`)
      .bind(...binds)
      .run(),
  );
}

export async function updateHabitStats(
  db: D1Database,
  id: string,
  stats: { current: number; best: number; totalDone: number },
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE habits SET current_streak = ?2, best_streak = ?3, total_done = ?4, updated_at = ?5
       WHERE id = ?1`,
    )
    .bind(id, stats.current, stats.best, stats.totalDone, now)
    .run();
}

export async function deleteHabit(db: D1Database, id: string): Promise<void> {
  // 外部キーの CASCADE に頼らず明示的に消す（ローカルの SQLite 設定差で残らないように）
  await db.batch([
    db.prepare('DELETE FROM habit_checkins WHERE habit_id = ?1').bind(id),
    db.prepare('DELETE FROM habits WHERE id = ?1').bind(id),
  ]);
}

// ----------------------------------------------------- 毎分の cron 用

export async function findDueHabits(db: D1Database, now: number, limit: number): Promise<Habit[]> {
  const { results } = await db
    .prepare(
      `SELECT ${HABIT_COLUMNS} FROM habits
       WHERE status = 'active' AND next_prompt_at IS NOT NULL AND next_prompt_at <= ?1
         AND (lease_until IS NULL OR lease_until < ?1)
       ORDER BY next_prompt_at ASC LIMIT ?2`,
    )
    .bind(now, limit)
    .all<HabitRow>();
  return (results ?? []).map(toHabit);
}

/** 送信の所有権を取る（reminder と同じ楽観ロック）。二重投稿を防ぐ */
export async function claimHabit(
  db: D1Database,
  id: string,
  observedNextPromptAt: number,
  now: number,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE habits SET lease_until = ?3
       WHERE id = ?1 AND status = 'active' AND next_prompt_at = ?4
         AND (lease_until IS NULL OR lease_until < ?2)`,
    )
    .bind(id, now, now + leaseSeconds, observedNextPromptAt)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * 次回に進めてロックを外す。last_error は「実際に投稿できたとき」だけ消す。
 * 投稿せずに日付だけ進めた場合（締め切り済み・記録済み）に消すと、直前の失敗理由が見えなくなるため。
 */
export async function finishPrompt(
  db: D1Database,
  id: string,
  nextPromptAt: number | null,
  now: number,
  opts: { posted: boolean },
): Promise<void> {
  await db
    .prepare(
      `UPDATE habits SET next_prompt_at = ?2, lease_until = NULL,
         last_error = CASE WHEN ?4 = 1 THEN NULL ELSE last_error END, updated_at = ?3
       WHERE id = ?1`,
    )
    .bind(id, nextPromptAt, now, opts.posted ? 1 : 0)
    .run();
}

export async function releaseHabit(
  db: D1Database,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE habits SET lease_until = NULL, last_error = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, error.slice(0, 500), now)
    .run();
}

/** チャンネル削除などで投稿できない習慣は一時停止にする */
export async function pauseHabitWithError(
  db: D1Database,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE habits SET status = 'paused', next_prompt_at = NULL, lease_until = NULL,
         last_error = ?2, updated_at = ?3 WHERE id = ?1`,
    )
    .bind(id, error.slice(0, 500), now)
    .run();
}

// ================================================================ checkins

const CHECKIN_COLUMNS = `id, habit_id, guild_id, user_id, date, status, note, channel_id,
  message_id, xp_awarded, answered_at, amount`;

export async function getCheckin(
  db: D1Database,
  habitId: string,
  date: string,
): Promise<Checkin | null> {
  const row = await db
    .prepare(`SELECT ${CHECKIN_COLUMNS} FROM habit_checkins WHERE habit_id = ?1 AND date = ?2`)
    .bind(habitId, date)
    .first<CheckinRow>();
  return row ? toCheckin(row) : null;
}

/** 既にその日の行があれば何もしない。作れたら true */
export async function insertCheckin(
  db: D1Database,
  c: {
    id: string;
    habit: Habit;
    date: string;
    status: CheckinStatus;
    now: number;
  },
): Promise<boolean> {
  return changed(
    await db
      .prepare(
        `INSERT OR IGNORE INTO habit_checkins
           (id, habit_id, guild_id, user_id, date, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
      )
      .bind(c.id, c.habit.id, c.habit.guildId, c.habit.userId, c.date, c.status, c.now)
      .run(),
  );
}

export async function attachMessage(
  db: D1Database,
  checkinId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await db
    .prepare('UPDATE habit_checkins SET channel_id = ?2, message_id = ?3 WHERE id = ?1')
    .bind(checkinId, channelId, messageId)
    .run();
}

/**
 * 回答を記録する。expected を渡すと「その状態のときだけ」更新する（cron と人の操作の競合対策）。
 * XP は初めて done になったときだけ付けるので、xp_awarded を立てたかどうかを返す。
 */
export async function setCheckinStatus(
  db: D1Database,
  params: {
    id: string;
    status: CheckinStatus;
    note?: string | null;
    /** done のときだけ残す。未指定なら前の値のまま、done 以外にすると消す */
    amount?: number | null;
    expected?: CheckinStatus[];
    now: number;
  },
): Promise<{ updated: boolean; firstDone: boolean }> {
  const before = await db
    .prepare('SELECT status, xp_awarded FROM habit_checkins WHERE id = ?1')
    .bind(params.id)
    .first<{ status: string; xp_awarded: number }>();
  if (!before) return { updated: false, firstDone: false };

  const firstDone = params.status === 'done' && before.xp_awarded === 0;
  const expected = params.expected ?? [];
  const guard =
    expected.length > 0 ? `AND status IN (${expected.map((s) => `'${s}'`).join(', ')})` : '';

  const result = await db
    .prepare(
      `UPDATE habit_checkins
          SET status = ?2,
              note = COALESCE(?3, note),
              amount = CASE WHEN ?2 = 'done' THEN COALESCE(?7, amount) ELSE NULL END,
              xp_awarded = CASE WHEN ?4 = 1 THEN 1 ELSE xp_awarded END,
              answered_at = ?5,
              updated_at = ?5
        WHERE id = ?1 AND xp_awarded = ?6 ${guard}`,
    )
    .bind(
      params.id,
      params.status,
      params.note ?? null,
      firstDone ? 1 : 0,
      params.now,
      before.xp_awarded,
      params.amount ?? null,
    )
    .run();
  const updated = changed(result);
  return { updated, firstDone: updated && firstDone };
}

export async function habitRecords(db: D1Database, habitId: string): Promise<DayRecord[]> {
  const { results } = await db
    .prepare('SELECT date, status FROM habit_checkins WHERE habit_id = ?1 ORDER BY date ASC')
    .bind(habitId)
    .all<{ date: string; status: CheckinStatus }>();
  return results ?? [];
}

export interface UserDayRecord extends DayRecord {
  habitId: string;
  amount: number | null;
}

export async function userRecords(
  db: D1Database,
  guildId: string,
  userId: string,
  from: string,
  to: string,
): Promise<UserDayRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT habit_id AS habitId, date, status, amount FROM habit_checkins
       WHERE guild_id = ?1 AND user_id = ?2 AND date >= ?3 AND date <= ?4
       ORDER BY date ASC`,
    )
    .bind(guildId, userId, from, to)
    .all<UserDayRecord>();
  return results ?? [];
}

export async function countUserDone(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM habit_checkins
       WHERE guild_id = ?1 AND user_id = ?2 AND status = 'done'`,
    )
    .bind(guildId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 前日以前のまま回答が無いチェックイン（締め切り処理の対象） */
export async function findStalePending(
  db: D1Database,
  today: string,
  limit: number,
): Promise<Checkin[]> {
  const { results } = await db
    .prepare(
      `SELECT ${CHECKIN_COLUMNS} FROM habit_checkins
       WHERE status = 'pending' AND date < ?1 ORDER BY date ASC LIMIT ?2`,
    )
    .bind(today, limit)
    .all<CheckinRow>();
  return (results ?? []).map(toCheckin);
}

export interface DueReminder {
  checkin: Checkin;
  habit: Habit;
}

/**
 * 今日まだ回答が無く、再通知の時刻を過ぎたチェックイン。
 * 投稿に成功した（message_id がある）ものだけを対象にし、返信の形で知らせる。
 */
export async function findDueReminders(
  db: D1Database,
  today: string,
  minuteOfDay: number,
  limit: number,
): Promise<DueReminder[]> {
  const habitCols = HABIT_COLUMNS.split(',')
    .map((c) => `h.${c.trim()} AS h_${c.trim()}`)
    .join(', ');
  const checkinCols = CHECKIN_COLUMNS.split(',')
    .map((c) => `c.${c.trim()}`)
    .join(', ');
  const { results } = await db
    .prepare(
      `SELECT ${checkinCols}, ${habitCols} FROM habit_checkins c
       JOIN habits h ON h.id = c.habit_id
       WHERE c.status = 'pending' AND c.date = ?1 AND c.reminded_at IS NULL
         AND c.message_id IS NOT NULL AND h.status = 'active'
         AND h.remind_minute IS NOT NULL AND h.remind_minute > h.check_minute
         AND h.remind_minute <= ?2
       ORDER BY h.remind_minute ASC LIMIT ?3`,
    )
    .bind(today, minuteOfDay, limit)
    .all<Record<string, unknown>>();
  return (results ?? []).map((row) => {
    const habitRow: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k.startsWith('h_')) habitRow[k.slice(2)] = v;
    }
    return {
      checkin: toCheckin(row as unknown as CheckinRow),
      habit: toHabit(habitRow as unknown as HabitRow),
    };
  });
}

/** 再通知の権利を取る（1日1回・二重送信防止）。取れたら true */
export async function claimReminder(
  db: D1Database,
  checkinId: string,
  now: number,
): Promise<boolean> {
  return changed(
    await db
      .prepare(
        `UPDATE habit_checkins SET reminded_at = ?2
         WHERE id = ?1 AND reminded_at IS NULL AND status = 'pending'`,
      )
      .bind(checkinId, now)
      .run(),
  );
}

// ================================================================ profiles

const PROFILE_COLUMNS = `guild_id, user_id, xp, freezes, summary_channel_id, hide_ranking,
  last_weekly_key, last_monthly_key`;

/** 無ければ作る。summaryChannelId は初回だけ使う（以後は /habit settings で変える） */
export async function ensureProfile(
  db: D1Database,
  guildId: string,
  userId: string,
  now: number,
  summaryChannelId?: string,
): Promise<Profile> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO habit_profiles (guild_id, user_id, summary_channel_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    )
    .bind(guildId, userId, summaryChannelId ?? null, now)
    .run();
  if (summaryChannelId) {
    await db
      .prepare(
        `UPDATE habit_profiles SET summary_channel_id = ?3
         WHERE guild_id = ?1 AND user_id = ?2 AND summary_channel_id IS NULL`,
      )
      .bind(guildId, userId, summaryChannelId)
      .run();
  }
  const profile = await getProfile(db, guildId, userId);
  if (!profile) throw new Error('profile の作成に失敗しました');
  return profile;
}

export async function getProfile(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<Profile | null> {
  const row = await db
    .prepare(`SELECT ${PROFILE_COLUMNS} FROM habit_profiles WHERE guild_id = ?1 AND user_id = ?2`)
    .bind(guildId, userId)
    .first<ProfileRow>();
  return row ? toProfile(row) : null;
}

/** XP を加算して加算後の値を返す */
export async function addXp(
  db: D1Database,
  guildId: string,
  userId: string,
  delta: number,
  now: number,
): Promise<number> {
  const row = await db
    .prepare(
      `UPDATE habit_profiles SET xp = xp + ?3, updated_at = ?4
       WHERE guild_id = ?1 AND user_id = ?2 RETURNING xp`,
    )
    .bind(guildId, userId, delta, now)
    .first<{ xp: number }>();
  return row?.xp ?? 0;
}

/** フリーズを1個もらう（上限あり）。実際に増えたら true */
export async function grantFreeze(
  db: D1Database,
  guildId: string,
  userId: string,
  max: number,
  now: number,
): Promise<boolean> {
  return changed(
    await db
      .prepare(
        `UPDATE habit_profiles SET freezes = freezes + 1, updated_at = ?4
         WHERE guild_id = ?1 AND user_id = ?2 AND freezes < ?3`,
      )
      .bind(guildId, userId, max, now)
      .run(),
  );
}

/** フリーズを n 個使う。足りなければ何もせず false */
export async function consumeFreezes(
  db: D1Database,
  guildId: string,
  userId: string,
  n: number,
  now: number,
): Promise<boolean> {
  return changed(
    await db
      .prepare(
        `UPDATE habit_profiles SET freezes = freezes - ?3, updated_at = ?4
         WHERE guild_id = ?1 AND user_id = ?2 AND freezes >= ?3`,
      )
      .bind(guildId, userId, n, now)
      .run(),
  );
}

export async function refundFreezes(
  db: D1Database,
  guildId: string,
  userId: string,
  n: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE habit_profiles SET freezes = freezes + ?3, updated_at = ?4
       WHERE guild_id = ?1 AND user_id = ?2`,
    )
    .bind(guildId, userId, n, now)
    .run();
}

export async function updateProfileSettings(
  db: D1Database,
  guildId: string,
  userId: string,
  patch: { summaryChannelId?: string; hideRanking?: boolean },
  now: number,
): Promise<void> {
  if (patch.summaryChannelId !== undefined) {
    await db
      .prepare(
        `UPDATE habit_profiles SET summary_channel_id = ?3, updated_at = ?4
         WHERE guild_id = ?1 AND user_id = ?2`,
      )
      .bind(guildId, userId, patch.summaryChannelId, now)
      .run();
  }
  if (patch.hideRanking !== undefined) {
    await db
      .prepare(
        `UPDATE habit_profiles SET hide_ranking = ?3, updated_at = ?4
         WHERE guild_id = ?1 AND user_id = ?2`,
      )
      .bind(guildId, userId, patch.hideRanking ? 1 : 0, now)
      .run();
  }
}

export async function ranking(db: D1Database, guildId: string, limit: number): Promise<Profile[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PROFILE_COLUMNS} FROM habit_profiles
       WHERE guild_id = ?1 AND hide_ranking = 0 AND xp > 0
       ORDER BY xp DESC LIMIT ?2`,
    )
    .bind(guildId, limit)
    .all<ProfileRow>();
  return (results ?? []).map(toProfile);
}

export type SummaryKind = 'week' | 'month';

const SUMMARY_COLUMN: Record<SummaryKind, string> = {
  week: 'last_weekly_key',
  month: 'last_monthly_key',
};

/** まだその期間のまとめを送っていないプロフィール */
export async function findSummaryTargets(
  db: D1Database,
  kind: SummaryKind,
  key: string,
  limit: number,
): Promise<Profile[]> {
  const column = SUMMARY_COLUMN[kind];
  const { results } = await db
    .prepare(
      `SELECT ${PROFILE_COLUMNS} FROM habit_profiles
       WHERE summary_channel_id IS NOT NULL AND (${column} IS NULL OR ${column} < ?1)
       LIMIT ?2`,
    )
    .bind(key, limit)
    .all<ProfileRow>();
  return (results ?? []).map(toProfile);
}

/** 送信済みにする。同じ期間を2回送らないよう、まだ古いときだけ更新する */
export async function markSummarySent(
  db: D1Database,
  guildId: string,
  userId: string,
  kind: SummaryKind,
  key: string,
): Promise<boolean> {
  const column = SUMMARY_COLUMN[kind];
  return changed(
    await db
      .prepare(
        `UPDATE habit_profiles SET ${column} = ?3
         WHERE guild_id = ?1 AND user_id = ?2 AND (${column} IS NULL OR ${column} < ?3)`,
      )
      .bind(guildId, userId, key)
      .run(),
  );
}

// ================================================================ badges

export async function listBadges(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      'SELECT badge FROM habit_badges WHERE guild_id = ?1 AND user_id = ?2 ORDER BY awarded_at',
    )
    .bind(guildId, userId)
    .all<{ badge: string }>();
  return (results ?? []).map((r) => r.badge);
}

export async function awardBadges(
  db: D1Database,
  guildId: string,
  userId: string,
  badges: string[],
  now: number,
): Promise<void> {
  if (badges.length === 0) return;
  await db.batch(
    badges.map((badge) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO habit_badges (guild_id, user_id, badge, awarded_at) VALUES (?1, ?2, ?3, ?4)',
        )
        .bind(guildId, userId, badge, now),
    ),
  );
}

// ================================================================ goals

const GOAL_COLUMNS = `id, guild_id, user_id, name, unit, start_value, target_value, current,
  deadline, status, completed_at, created_at`;

export async function insertGoal(
  db: D1Database,
  g: {
    id: string;
    guildId: string;
    userId: string;
    name: string;
    unit: string;
    startValue: number;
    targetValue: number | null;
    deadline: string | null;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO goals (id, guild_id, user_id, name, unit, start_value, target_value, current,
         deadline, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8, 'active', ?9, ?9)`,
    )
    .bind(g.id, g.guildId, g.userId, g.name, g.unit, g.startValue, g.targetValue, g.deadline, g.now)
    .run();
}

export async function findGoal(
  db: D1Database,
  guildId: string,
  userId: string,
  idish: string,
): Promise<Goal | null> {
  const needle = normalizeIdish(idish);
  if (!needle) return null;
  const row = await db
    .prepare(
      `SELECT ${GOAL_COLUMNS} FROM goals
       WHERE guild_id = ?1 AND user_id = ?2 AND (id = ?3 OR substr(id, -length(?3)) = ?3)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(guildId, userId, needle)
    .first<GoalRow>();
  return row ? toGoal(row) : null;
}

export async function listGoals(
  db: D1Database,
  guildId: string,
  userId: string,
  includeCompleted: boolean,
): Promise<Goal[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GOAL_COLUMNS} FROM goals
       WHERE guild_id = ?1 AND user_id = ?2 ${includeCompleted ? '' : "AND status = 'active'"}
       ORDER BY status ASC, (deadline IS NULL), deadline ASC, created_at DESC LIMIT 25`,
    )
    .bind(guildId, userId)
    .all<GoalRow>();
  return (results ?? []).map(toGoal);
}

export async function setGoalCurrent(
  db: D1Database,
  id: string,
  current: number,
  now: number,
): Promise<void> {
  await db
    .prepare('UPDATE goals SET current = ?2, updated_at = ?3 WHERE id = ?1')
    .bind(id, current, now)
    .run();
}

/** active -> completed。既に完了していたら false（XP の二重付与を防ぐ） */
export async function completeGoal(db: D1Database, id: string, now: number): Promise<boolean> {
  return changed(
    await db
      .prepare(
        `UPDATE goals SET status = 'completed', completed_at = ?2, updated_at = ?2
         WHERE id = ?1 AND status = 'active'`,
      )
      .bind(id, now)
      .run(),
  );
}

export async function deleteGoal(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM goal_logs WHERE goal_id = ?1').bind(id),
    db.prepare('DELETE FROM goals WHERE id = ?1').bind(id),
  ]);
}

export async function insertGoalLog(
  db: D1Database,
  log: {
    id: string;
    goal: Goal;
    date: string;
    mode: 'add' | 'set';
    value: number;
    after: number;
    note: string | null;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO goal_logs (id, goal_id, guild_id, user_id, date, mode, value, after, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      log.id,
      log.goal.id,
      log.goal.guildId,
      log.goal.userId,
      log.date,
      log.mode,
      log.value,
      log.after,
      log.note,
      log.now,
    )
    .run();
}

export async function goalLogs(db: D1Database, goalId: string, limit: number): Promise<GoalLog[]> {
  const { results } = await db
    .prepare(
      `SELECT date, mode, value, after, note FROM goal_logs WHERE goal_id = ?1
       ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(goalId, limit)
    .all<GoalLog>();
  return (results ?? []).reverse();
}

export async function countGoalLogsOn(
  db: D1Database,
  goalId: string,
  date: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM goal_logs WHERE goal_id = ?1 AND date = ?2')
    .bind(goalId, date)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countCompletedGoals(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM goals WHERE guild_id = ?1 AND user_id = ?2 AND status = 'completed'`,
    )
    .bind(guildId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 期間内の目標の記録数と完了数（まとめ用）。完了は completed_at（UNIX 秒）で数える */
export async function goalActivity(
  db: D1Database,
  guildId: string,
  userId: string,
  range: { from: string; to: string; fromEpoch: number; toEpoch: number },
): Promise<{ logs: number; completed: number }> {
  const logs = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM goal_logs
       WHERE guild_id = ?1 AND user_id = ?2 AND date >= ?3 AND date <= ?4`,
    )
    .bind(guildId, userId, range.from, range.to)
    .first<{ n: number }>();
  const completed = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM goals
       WHERE guild_id = ?1 AND user_id = ?2 AND status = 'completed'
         AND completed_at >= ?3 AND completed_at < ?4`,
    )
    .bind(guildId, userId, range.fromEpoch, range.toEpoch)
    .first<{ n: number }>();
  return { logs: logs?.n ?? 0, completed: completed?.n ?? 0 };
}

// ================================================================ reflections

export interface Reflection {
  period: SummaryKind;
  periodKey: string;
  good: string | null;
  bad: string | null;
  next: string | null;
}

/** 書き込み、初回なら true（XP は初回だけ付与する） */
export async function upsertReflection(
  db: D1Database,
  r: Reflection & { guildId: string; userId: string; now: number },
): Promise<boolean> {
  const inserted = changed(
    await db
      .prepare(
        `INSERT OR IGNORE INTO habit_reflections
           (guild_id, user_id, period, period_key, good, bad, next, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(r.guildId, r.userId, r.period, r.periodKey, r.good, r.bad, r.next, r.now)
      .run(),
  );
  if (!inserted) {
    await db
      .prepare(
        `UPDATE habit_reflections SET good = ?5, bad = ?6, next = ?7, updated_at = ?8
         WHERE guild_id = ?1 AND user_id = ?2 AND period = ?3 AND period_key = ?4`,
      )
      .bind(r.guildId, r.userId, r.period, r.periodKey, r.good, r.bad, r.next, r.now)
      .run();
  }
  return inserted;
}

export async function getReflection(
  db: D1Database,
  guildId: string,
  userId: string,
  period: SummaryKind,
  periodKey: string,
): Promise<Reflection | null> {
  return db
    .prepare(
      `SELECT period, period_key AS periodKey, good, bad, next FROM habit_reflections
       WHERE guild_id = ?1 AND user_id = ?2 AND period = ?3 AND period_key = ?4`,
    )
    .bind(guildId, userId, period, periodKey)
    .first<Reflection>();
}

export async function recentReflections(
  db: D1Database,
  guildId: string,
  userId: string,
  limit: number,
): Promise<Reflection[]> {
  const { results } = await db
    .prepare(
      `SELECT period, period_key AS periodKey, good, bad, next FROM habit_reflections
       WHERE guild_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT ?3`,
    )
    .bind(guildId, userId, limit)
    .all<Reflection>();
  return results ?? [];
}

export async function countReflections(
  db: D1Database,
  guildId: string,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM habit_reflections WHERE guild_id = ?1 AND user_id = ?2')
    .bind(guildId, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
