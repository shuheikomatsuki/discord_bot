/**
 * 回答の記録・XP・バッジ付与など、コマンド / ボタン / cron から共通で呼ぶ処理。
 */
import {
  type APIActionRowComponent,
  type APIButtonComponent,
  ButtonStyle,
  ComponentType,
} from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { ulid } from '../../core/ulid';
import { editMessage } from '../../discord/rest';
import type { Env } from '../../env';
import { dateKeyOf } from './dates';
import {
  earnsFreeze,
  levelInfo,
  MAX_FREEZES,
  newlyEarnedBadges,
  streakBonus,
  XP,
} from './gamification';
import { type AnswerSummary, answeredContent } from './render';
import * as repo from './repository';
import type { Checkin, Habit } from './schema';
import { type CheckinStatus, computeStreak } from './streak';

export const FEATURE_NAME = 'habit';

export class HabitUserError extends Error {}

export function timeZoneOf(env: Env): string {
  return env.DEFAULT_TIMEZONE || 'Asia/Tokyo';
}

export function todayOf(env: Env, now: number): string {
  return dateKeyOf(now, timeZoneOf(env));
}

// --------------------------------------------------------------- ボタン

/**
 * チェックインのボタン。量を記録する習慣は「やった」の代わりに「記録する」（量の入力フォーム）を出す。
 * どちらの習慣でも custom_id は同じ形なので、古いボタンが残っていても動く。
 */
export function checkinButtons(
  habit: Pick<Habit, 'id' | 'unit'>,
  date: string,
): APIActionRowComponent<APIButtonComponent>[] {
  const id = (action: string): string => encodeCustomId(FEATURE_NAME, action, habit.id, date);
  const record: APIButtonComponent[] = habit.unit
    ? [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: `記録する（${habit.unit}）`.slice(0, 80),
          emoji: { name: '📏' },
          custom_id: id('note'),
        },
      ]
    : [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: 'やった',
          emoji: { name: '✅' },
          custom_id: id('done'),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Primary,
          label: 'メモして記録',
          emoji: { name: '📝' },
          custom_id: id('note'),
        },
      ];
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        ...record,
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: 'フリーズ',
          emoji: { name: '🧊' },
          custom_id: id('freeze'),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Danger,
          label: 'できなかった',
          emoji: { name: '❌' },
          custom_id: id('miss'),
        },
      ],
    },
  ];
}

// --------------------------------------------------------------- 記録

/** 連続記録などを履歴から計算し直して habits に書き戻す */
export async function refreshHabitStats(db: D1Database, habit: Habit, now: number): Promise<Habit> {
  const stats = computeStreak(await repo.habitRecords(db, habit.id));
  await repo.updateHabitStats(db, habit.id, stats, now);
  return {
    ...habit,
    currentStreak: stats.current,
    bestStreak: stats.best,
    totalDone: stats.totalDone,
  };
}

/** XP を足し、レベルアップしたら新レベルを返す */
export async function grantXp(
  db: D1Database,
  guildId: string,
  userId: string,
  amount: number,
  now: number,
): Promise<{ xp: number; leveledUpTo: number | null }> {
  const after = await repo.addXp(db, guildId, userId, amount, now);
  const before = levelInfo(after - amount).level;
  const level = levelInfo(after).level;
  return { xp: after, leveledUpTo: level > before ? level : null };
}

/** 事実から新しいバッジを判定して付与し、付与したものを返す */
export async function checkBadges(
  db: D1Database,
  guildId: string,
  userId: string,
  facts: Parameters<typeof newlyEarnedBadges>[0],
  now: number,
): Promise<string[]> {
  const owned = await repo.listBadges(db, guildId, userId);
  const earned = newlyEarnedBadges(facts, owned);
  await repo.awardBadges(db, guildId, userId, earned, now);
  return earned;
}

export interface AnswerResult {
  habit: Habit;
  checkin: Checkin;
  summary: AnswerSummary;
}

/**
 * その日のチェックインに回答する。行が無ければ作る。
 * - frozen にするときはフリーズ在庫を1個使う（frozen から外すときは返す）
 * - XP は初めて done になったときだけ（押し直しで稼げないように）
 */
export async function answer(
  env: Env,
  habit: Habit,
  date: string,
  status: Exclude<CheckinStatus, 'pending'>,
  note: string | null,
  now: number,
  amount: number | null = null,
): Promise<AnswerResult> {
  const db = env.DB;
  const profile = await repo.ensureProfile(db, habit.guildId, habit.userId, now, habit.channelId);

  await repo.insertCheckin(db, { id: ulid(now * 1000), habit, date, status: 'pending', now });
  const before = await repo.getCheckin(db, habit.id, date);
  if (!before) throw new Error('チェックインの作成に失敗しました');

  let freezesLeft = profile.freezes;
  if (status === 'frozen' && before.status !== 'frozen') {
    const ok = await repo.consumeFreezes(db, habit.guildId, habit.userId, 1, now);
    if (!ok) throw new HabitUserError('フリーズの在庫がありません（7日連続ごとに1個もらえます）。');
    freezesLeft -= 1;
  }

  const { updated, firstDone } = await repo.setCheckinStatus(db, {
    id: before.id,
    status,
    note,
    amount,
    expected: [before.status],
    now,
  });
  if (!updated) {
    // 同時に別の操作が入った。使ったフリーズを戻してやり直してもらう
    if (status === 'frozen' && before.status !== 'frozen') {
      await repo.refundFreezes(db, habit.guildId, habit.userId, 1, now);
    }
    throw new HabitUserError('同時に別の操作がありました。もう一度押してください。');
  }
  if (before.status === 'frozen' && status !== 'frozen') {
    await repo.refundFreezes(db, habit.guildId, habit.userId, 1, now);
    freezesLeft += 1;
  }

  const refreshed = await refreshHabitStats(db, habit, now);

  let xpGained = 0;
  let leveledUpTo: number | null = null;
  let freezeEarned = false;
  let xp = profile.xp;
  if (firstDone) {
    xpGained = XP.checkin + streakBonus(refreshed.currentStreak);
    ({ xp, leveledUpTo } = await grantXp(db, habit.guildId, habit.userId, xpGained, now));
    if (earnsFreeze(refreshed.currentStreak)) {
      freezeEarned = await repo.grantFreeze(db, habit.guildId, habit.userId, MAX_FREEZES, now);
      if (freezeEarned) freezesLeft += 1;
    }
  }

  const newBadges =
    status === 'done'
      ? await checkBadges(
          db,
          habit.guildId,
          habit.userId,
          {
            streak: refreshed.currentStreak,
            totalDone: await repo.countUserDone(db, habit.guildId, habit.userId),
            level: levelInfo(xp).level,
          },
          now,
        )
      : [];

  const after = await repo.getCheckin(db, habit.id, date);
  if (!after) throw new Error('チェックインの再取得に失敗しました');
  return {
    habit: refreshed,
    checkin: after,
    summary: {
      streak: refreshed.currentStreak,
      xpGained,
      leveledUpTo,
      newBadges,
      freezeEarned,
      freezesLeft,
    },
  };
}

/** チェックインの投稿を最新の状態に書き換える（コマンドから記録したときなど）。失敗しても握り潰す */
export async function syncCheckinMessage(
  env: Env,
  habit: Habit,
  checkin: Checkin,
  summary: AnswerSummary | null,
  closed: boolean,
): Promise<void> {
  if (!checkin.channelId || !checkin.messageId) return;
  try {
    await editMessage(env.DISCORD_BOT_TOKEN, checkin.channelId, checkin.messageId, {
      content: answeredContent(
        habit,
        checkin.date,
        checkin.status,
        checkin.note,
        summary,
        closed,
        checkin.amount,
      ),
      components: closed ? [] : checkinButtons(habit, checkin.date),
      allowed_mentions: { parse: [] },
    });
  } catch (error) {
    console.warn('チェックインメッセージの更新に失敗', habit.id, checkin.date, error);
  }
}
