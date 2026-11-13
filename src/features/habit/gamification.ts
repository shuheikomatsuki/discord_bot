/**
 * XP・レベル・バッジ・フリーズの獲得ルール（純粋関数）。
 * 数値を調整したいときはこのファイルだけ触ればよい。
 */

export const XP = {
  checkin: 10,
  goalLog: 5,
  goalComplete: 100,
  reflection: 15,
} as const;

/** フリーズの在庫上限。7日連続ごとに1個もらえる */
export const MAX_FREEZES = 3;
export const FREEZE_EVERY_STREAK = 7;

/** 連続記録が節目に達したときのボーナス XP */
export function streakBonus(streak: number): number {
  if (streak <= 0) return 0;
  let bonus = 0;
  if (streak % 7 === 0) bonus += 20;
  if (streak === 30) bonus += 50;
  if (streak === 100) bonus += 200;
  if (streak === 365) bonus += 500;
  return bonus;
}

export function earnsFreeze(streak: number): boolean {
  return streak > 0 && streak % FREEZE_EVERY_STREAK === 0;
}

// --------------------------------------------------------------- レベル

/** レベル L に必要な累計 XP = 25 × (L-1)²（L2=25, L3=100, L5=400, L10=2025） */
export function xpForLevel(level: number): number {
  return 25 * (level - 1) ** 2;
}

export interface LevelInfo {
  level: number;
  /** 今のレベルに入ってから稼いだ XP */
  into: number;
  /** 次のレベルまでに必要な XP（このレベル内の幅） */
  span: number;
}

export function levelInfo(xp: number): LevelInfo {
  const level = Math.floor(Math.sqrt(Math.max(0, xp) / 25)) + 1;
  const base = xpForLevel(level);
  return { level, into: xp - base, span: xpForLevel(level + 1) - base };
}

// --------------------------------------------------------------- バッジ

export interface BadgeDef {
  id: string;
  emoji: string;
  name: string;
  description: string;
}

export const BADGES: BadgeDef[] = [
  { id: 'first_step', emoji: '🌱', name: 'はじめの一歩', description: '初めてチェックインを達成' },
  { id: 'streak_3', emoji: '🔥', name: '三日坊主卒業', description: '3日連続で達成' },
  { id: 'streak_7', emoji: '⭐', name: '1週間継続', description: '7日連続で達成' },
  { id: 'streak_30', emoji: '🏅', name: '1ヶ月継続', description: '30日連続で達成' },
  { id: 'streak_100', emoji: '🏆', name: '100日継続', description: '100日連続で達成' },
  { id: 'streak_365', emoji: '👑', name: '1年継続', description: '365日連続で達成' },
  { id: 'total_50', emoji: '💪', name: '50回達成', description: 'チェックインを累計50回達成' },
  { id: 'total_100', emoji: '🎯', name: '100回達成', description: 'チェックインを累計100回達成' },
  { id: 'total_500', emoji: '🌋', name: '500回達成', description: 'チェックインを累計500回達成' },
  { id: 'goal_1', emoji: '🚩', name: '目標達成', description: '初めて目標を達成' },
  { id: 'goal_5', emoji: '🗻', name: '目標ハンター', description: '目標を5つ達成' },
  { id: 'level_5', emoji: '✨', name: 'レベル5', description: 'レベル5に到達' },
  { id: 'level_10', emoji: '💎', name: 'レベル10', description: 'レベル10に到達' },
  { id: 'reflect_1', emoji: '📝', name: '振り返り上手', description: '初めて振り返りを書いた' },
  {
    id: 'perfect_week',
    emoji: '🌈',
    name: 'パーフェクトウィーク',
    description: '1週間の予定（3回以上）をすべて達成',
  },
];

const BADGE_BY_ID = new Map(BADGES.map((b) => [b.id, b]));

export function badgeOf(id: string): BadgeDef | undefined {
  return BADGE_BY_ID.get(id);
}

export function badgeLabel(id: string): string {
  const def = BADGE_BY_ID.get(id);
  return def ? `${def.emoji} ${def.name}` : id;
}

export interface BadgeFacts {
  /** 今回の出来事で到達した連続記録 */
  streak?: number;
  /** 全習慣の累計達成回数 */
  totalDone?: number;
  goalsCompleted?: number;
  level?: number;
  reflections?: number;
  perfectWeek?: boolean;
}

/** 条件を満たしていて、まだ持っていないバッジ */
export function newlyEarnedBadges(facts: BadgeFacts, owned: Iterable<string>): string[] {
  const have = new Set(owned);
  const earned: string[] = [];
  const check = (id: string, condition: boolean): void => {
    if (condition && !have.has(id)) earned.push(id);
  };
  const streak = facts.streak ?? 0;
  const total = facts.totalDone ?? 0;
  const goals = facts.goalsCompleted ?? 0;
  const level = facts.level ?? 0;

  check('first_step', total >= 1);
  check('streak_3', streak >= 3);
  check('streak_7', streak >= 7);
  check('streak_30', streak >= 30);
  check('streak_100', streak >= 100);
  check('streak_365', streak >= 365);
  check('total_50', total >= 50);
  check('total_100', total >= 100);
  check('total_500', total >= 500);
  check('goal_1', goals >= 1);
  check('goal_5', goals >= 5);
  check('level_5', level >= 5);
  check('level_10', level >= 10);
  check('reflect_1', (facts.reflections ?? 0) >= 1);
  check('perfect_week', facts.perfectWeek === true);
  return earned;
}
