import type { CheckinStatus } from './streak';

export type HabitStatus = 'active' | 'paused';
export type GoalStatus = 'active' | 'completed';

export interface HabitRow {
  id: string;
  guild_id: string;
  user_id: string;
  channel_id: string;
  name: string;
  timezone: string;
  check_minute: number;
  days_mask: number;
  auto_freeze: number;
  status: string;
  next_prompt_at: number | null;
  lease_until: number | null;
  current_streak: number;
  best_streak: number;
  total_done: number;
  last_error: string | null;
  remind_minute: number | null;
  unit: string | null;
  daily_target: number | null;
  created_at: number;
  updated_at: number;
}

export interface Habit {
  id: string;
  guildId: string;
  userId: string;
  channelId: string;
  name: string;
  timeZone: string;
  checkMinute: number;
  daysMask: number;
  autoFreeze: boolean;
  status: HabitStatus;
  nextPromptAt: number | null;
  currentStreak: number;
  bestStreak: number;
  totalDone: number;
  lastError: string | null;
  /** 未回答のときに再通知する時刻（0:00 からの分）。null = しない */
  remindMinute: number | null;
  /** 量を記録する習慣の単位。null = やった・やらないだけ */
  unit: string | null;
  dailyTarget: number | null;
  createdAt: number;
}

export function toHabit(row: HabitRow): Habit {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id,
    name: row.name,
    timeZone: row.timezone,
    checkMinute: row.check_minute,
    daysMask: row.days_mask,
    autoFreeze: row.auto_freeze === 1,
    status: row.status === 'paused' ? 'paused' : 'active',
    nextPromptAt: row.next_prompt_at,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    totalDone: row.total_done,
    lastError: row.last_error,
    remindMinute: row.remind_minute,
    unit: row.unit,
    dailyTarget: row.daily_target,
    createdAt: row.created_at,
  };
}

export interface CheckinRow {
  id: string;
  habit_id: string;
  guild_id: string;
  user_id: string;
  date: string;
  status: string;
  note: string | null;
  channel_id: string | null;
  message_id: string | null;
  xp_awarded: number;
  answered_at: number | null;
  amount: number | null;
}

export interface Checkin {
  id: string;
  habitId: string;
  guildId: string;
  userId: string;
  date: string;
  status: CheckinStatus;
  note: string | null;
  channelId: string | null;
  messageId: string | null;
  xpAwarded: boolean;
  amount: number | null;
}

export function toCheckin(row: CheckinRow): Checkin {
  return {
    id: row.id,
    habitId: row.habit_id,
    guildId: row.guild_id,
    userId: row.user_id,
    date: row.date,
    status: row.status as CheckinStatus,
    note: row.note,
    channelId: row.channel_id,
    messageId: row.message_id,
    xpAwarded: row.xp_awarded === 1,
    amount: row.amount,
  };
}

export interface GoalRow {
  id: string;
  guild_id: string;
  user_id: string;
  name: string;
  unit: string;
  start_value: number;
  target_value: number | null;
  current: number;
  deadline: string | null;
  status: string;
  completed_at: number | null;
  created_at: number;
}

export interface Goal {
  id: string;
  guildId: string;
  userId: string;
  name: string;
  unit: string;
  startValue: number;
  targetValue: number | null;
  current: number;
  deadline: string | null;
  status: GoalStatus;
  completedAt: number | null;
  createdAt: number;
}

export function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    guildId: row.guild_id,
    userId: row.user_id,
    name: row.name,
    unit: row.unit,
    startValue: row.start_value,
    targetValue: row.target_value,
    current: row.current,
    deadline: row.deadline,
    status: row.status === 'completed' ? 'completed' : 'active',
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

export interface GoalLog {
  date: string;
  mode: 'add' | 'set';
  value: number;
  after: number;
  note: string | null;
}

export interface ProfileRow {
  guild_id: string;
  user_id: string;
  xp: number;
  freezes: number;
  summary_channel_id: string | null;
  hide_ranking: number;
  last_weekly_key: string | null;
  last_monthly_key: string | null;
}

export interface Profile {
  guildId: string;
  userId: string;
  xp: number;
  freezes: number;
  summaryChannelId: string | null;
  hideRanking: boolean;
  lastWeeklyKey: string | null;
  lastMonthlyKey: string | null;
}

export function toProfile(row: ProfileRow): Profile {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    xp: row.xp,
    freezes: row.freezes,
    summaryChannelId: row.summary_channel_id,
    hideRanking: row.hide_ranking === 1,
    lastWeeklyKey: row.last_weekly_key,
    lastMonthlyKey: row.last_monthly_key,
  };
}

/** goal の進捗率（0〜1）。数値なしの目標は達成なら 1 */
export function goalProgress(goal: Goal): number {
  if (goal.targetValue === null) return goal.status === 'completed' ? 1 : 0;
  const span = goal.targetValue - goal.startValue;
  if (span === 0) return 1;
  return Math.max(0, Math.min(1, (goal.current - goal.startValue) / span));
}

/** 目標値に到達したか（減らす目標にも対応する） */
export function goalReached(goal: Goal): boolean {
  if (goal.targetValue === null) return false;
  return goal.targetValue >= goal.startValue
    ? goal.current >= goal.targetValue
    : goal.current <= goal.targetValue;
}
