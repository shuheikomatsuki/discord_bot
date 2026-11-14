/**
 * 毎分の cron から呼ばれる3つの処理。
 *  1. prompt  … 時刻になった習慣のチェックインをチャンネルに投稿する
 *  2. close   … 日付が変わったのに未回答のチェックインを締める（自動フリーズ or 未達）
 *  3. summary … 月曜9時に先週の、毎月1日9時に先月のまとめを送る
 */
import { ButtonStyle, ComponentType } from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { nowSeconds, toZonedParts } from '../../core/time';
import { ulid } from '../../core/ulid';
import { createMessage, DiscordApiError } from '../../discord/rest';
import type { Env } from '../../env';
import { addDays, nextPromptAt } from './dates';
import { promptContent } from './render';
import { buildReport, monthPeriod, type Period, weekPeriod } from './report';
import * as repo from './repository';
import type { Habit } from './schema';
import {
  checkBadges,
  checkinButtons,
  FEATURE_NAME,
  refreshHabitStats,
  syncCheckinMessage,
  timeZoneOf,
  todayOf,
} from './service';

/**
 * 1分あたりの処理件数。Workers Free の D1 は「1回の起動あたり約50クエリ」が上限で、
 * reminder を含む全 cron が同じ起動を共有する。prompt は1件4クエリ、close は1件約6クエリ、
 * summary は1人約12クエリかかるので、件数を絞り、close と summary は奇数分/偶数分で交互に回す。
 * 残りは次の分に持ち越されるだけなので、取りこぼしは起きない。
 */
const PROMPT_BATCH = 5;
const CLOSE_BATCH = 3;
const SUMMARY_BATCH = 1;

const isEvenMinute = (now: number): boolean => Math.floor(now / 60) % 2 === 0;
const LEASE_SECONDS = 120;
/** まとめを送る時刻（月曜 / 1日の何時以降か） */
const SUMMARY_HOUR = 9;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ================================================================ 1. prompt

export async function promptDueHabits(env: Env): Promise<void> {
  const now = nowSeconds();
  const due = await repo.findDueHabits(env.DB, now, PROMPT_BATCH);
  for (const habit of due) {
    const scheduledAt = habit.nextPromptAt;
    if (scheduledAt === null) continue;
    if (!(await repo.claimHabit(env.DB, habit.id, scheduledAt, now, LEASE_SECONDS))) continue;
    await promptOne(env, habit, scheduledAt, now);
  }
}

async function promptOne(env: Env, habit: Habit, scheduledAt: number, now: number): Promise<void> {
  const date = todayOf(env, scheduledAt);
  const next = nextPromptAt(now, habit.checkMinute, habit.daysMask, habit.timeZone).at;

  // 寝ている間に何日も止まっていた場合など、もう締め切った日は聞かない
  if (date < todayOf(env, now)) {
    await repo.finishPrompt(env.DB, habit.id, next, now, { posted: false });
    return;
  }

  // 先に「やった」を記録済み / フリーズ予約済みなら聞かない
  const checkinId = ulid(now * 1000);
  const created = await repo.insertCheckin(env.DB, {
    id: checkinId,
    habit,
    date,
    status: 'pending',
    now,
  });
  if (!created) {
    await repo.finishPrompt(env.DB, habit.id, next, now, { posted: false });
    return;
  }

  try {
    const response = await createMessage(env.DISCORD_BOT_TOKEN, habit.channelId, {
      content: promptContent(habit, date),
      components: checkinButtons(habit.id, date),
      allowed_mentions: { users: [habit.userId] },
    });
    const message = (await response.json()) as { id: string };
    await repo.attachMessage(env.DB, checkinId, habit.channelId, message.id);
    await repo.finishPrompt(env.DB, habit.id, next, now, { posted: true });
  } catch (error) {
    console.error('habit prompt failed', habit.id, habit.channelId, describe(error));
    if (error instanceof DiscordApiError && error.isPermanent) {
      // チャンネル削除・権限不足。毎分失敗し続けないよう止める（行は残すので未達として締まる）
      await repo.pauseHabitWithError(env.DB, habit.id, describe(error), now);
    } else {
      // 一時的な失敗: 行を消して次の分にやり直す
      await env.DB.prepare('DELETE FROM habit_checkins WHERE id = ?1').bind(checkinId).run();
      await repo.releaseHabit(env.DB, habit.id, describe(error), now);
    }
  }
}

// ================================================================ 2. close

export async function closeStaleCheckins(env: Env): Promise<void> {
  const now = nowSeconds();
  if (!isEvenMinute(now)) return;
  const today = todayOf(env, now);
  const stale = await repo.findStalePending(env.DB, today, CLOSE_BATCH);
  const habits = new Map<string, Habit | null>();

  for (const checkin of stale) {
    if (!habits.has(checkin.habitId))
      habits.set(checkin.habitId, await repo.getHabit(env.DB, checkin.habitId));
    const habit = habits.get(checkin.habitId);
    if (!habit) {
      await env.DB.prepare('DELETE FROM habit_checkins WHERE id = ?1').bind(checkin.id).run();
      continue;
    }

    // 自動フリーズ: 在庫があれば使って記録をつなぐ
    let status: 'missed' | 'frozen' = 'missed';
    if (
      habit.autoFreeze &&
      (await repo.consumeFreezes(env.DB, habit.guildId, habit.userId, 1, now))
    ) {
      status = 'frozen';
    }
    const { updated } = await repo.setCheckinStatus(env.DB, {
      id: checkin.id,
      status,
      expected: ['pending'],
      now,
    });
    if (!updated) {
      // 締め切り直前に本人が回答していた
      if (status === 'frozen')
        await repo.refundFreezes(env.DB, habit.guildId, habit.userId, 1, now);
      continue;
    }

    const refreshed = await refreshHabitStats(env.DB, habit, now);
    habits.set(habit.id, refreshed);
    await syncCheckinMessage(env, refreshed, { ...checkin, status }, null, true);
  }
}

// ================================================================ 3. summary

/** 今まとめを送るべき期間。月曜9時を過ぎたら先週、1日9時を過ぎたら先月 */
export function duePeriods(now: number, timeZone: string, today: string): Period[] {
  const periods: Period[] = [];
  const p = toZonedParts(now, timeZone);
  // その週の月曜9時を過ぎていれば先週分が対象（火曜以降も、未送信なら送る）
  const sinceMonday = (p.weekday + 6) % 7;
  if (sinceMonday > 0 || p.hour >= SUMMARY_HOUR) periods.push(weekPeriod(addDays(today, -7)));
  if (p.day > 1 || p.hour >= SUMMARY_HOUR)
    periods.push(monthPeriod(addDays(`${today.slice(0, 7)}-01`, -1)));
  return periods;
}

export async function sendSummaries(env: Env): Promise<void> {
  const now = nowSeconds();
  if (isEvenMinute(now)) return;
  const today = todayOf(env, now);
  // 空振り（記録が無い人）もレポートを作るぶんクエリを使うので、処理人数で数える
  let budget = SUMMARY_BATCH;

  for (const period of duePeriods(now, timeZoneOf(env), today)) {
    const targets = await repo.findSummaryTargets(env.DB, period.kind, period.key, budget);
    for (const profile of targets) {
      if (budget <= 0) return;
      budget -= 1;
      // 先に送信済みにして二重送信を防ぐ（失敗しても次の期間に持ち越さない）
      if (
        !(await repo.markSummarySent(
          env.DB,
          profile.guildId,
          profile.userId,
          period.kind,
          period.key,
        ))
      )
        continue;

      const report = await buildReport(env, profile.guildId, profile.userId, period, today);
      if (report.empty || !profile.summaryChannelId) continue;

      if (period.kind === 'week' && report.perfect) {
        await checkBadges(env.DB, profile.guildId, profile.userId, { perfectWeek: true }, now);
      }

      try {
        await createMessage(env.DISCORD_BOT_TOKEN, profile.summaryChannelId, {
          content: `<@${profile.userId}> ${period.kind === 'week' ? '先週' : '先月'}のまとめです。振り返ってみましょう！`,
          embeds: [report.embed],
          components: [
            {
              type: ComponentType.ActionRow,
              components: [
                {
                  type: ComponentType.Button,
                  style: ButtonStyle.Primary,
                  label: '振り返りを書く',
                  emoji: { name: '📝' },
                  custom_id: encodeCustomId(
                    FEATURE_NAME,
                    'reflect',
                    period.kind,
                    period.key,
                    profile.userId,
                  ),
                },
              ],
            },
          ],
          allowed_mentions: { users: [profile.userId] },
        });
      } catch (error) {
        console.error('summary send failed', profile.userId, period.key, describe(error));
      }
    }
  }
}
