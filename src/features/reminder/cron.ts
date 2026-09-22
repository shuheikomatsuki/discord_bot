import { nowSeconds } from '../../core/time';
import { buildMention } from '../../discord/mentions';
import { createMessage, DiscordApiError } from '../../discord/rest';
import type { Env } from '../../env';
import * as repo from './repository';
import { advanceSchedule } from './schedule';
import type { Reminder, ReminderStatus } from './schema';
import { mentionSpecOf, scheduleSpecOf } from './service';

/** 1回の実行で扱う最大件数。Workers の subrequest 上限(50)に対する安全弁 */
const BATCH_LIMIT = 20;
/** 配信ロックの寿命。途中で Worker が落ちても次の分で再挑戦できる */
const LEASE_SECONDS = 120;
/** これ以上遅れていたら本文に遅延を明示する */
const LATE_THRESHOLD_SECONDS = 60 * 60;
const DISCORD_MESSAGE_LIMIT = 2000;

export async function deliverDueReminders(env: Env): Promise<void> {
  const now = nowSeconds();
  const due = await repo.findDue(env.DB, now, BATCH_LIMIT);
  if (due.length === 0) return;

  for (const reminder of due) {
    const scheduledAt = reminder.nextFireAt;
    if (scheduledAt === null) continue;

    // 所有権が取れなかった = 他の実行が持っていった。黙ってスキップする
    const owned = await repo.claim(env.DB, reminder.id, scheduledAt, now, LEASE_SECONDS);
    if (!owned) continue;

    await deliverOne(env, reminder, scheduledAt, now);
  }
}

async function deliverOne(
  env: Env,
  reminder: Reminder,
  scheduledAt: number,
  now: number,
): Promise<void> {
  let next: number | null;
  let skipped: number;
  try {
    ({ next, skipped } = advanceSchedule(scheduleSpecOf(reminder), scheduledAt, now));
  } catch (error) {
    // cron 式が壊れている等。再試行しても直らないので止める
    await repo.markFailed(env.DB, reminder.id, describeError(error), now);
    return;
  }

  const mention = buildMention(mentionSpecOf(reminder));
  const late = now - scheduledAt > LATE_THRESHOLD_SECONDS ? '(⚠ 遅延配信) ' : '';
  const content = `${mention.prefix}${late}${reminder.message}`.slice(0, DISCORD_MESSAGE_LIMIT);

  try {
    await createMessage(env.DISCORD_BOT_TOKEN, reminder.channelId, {
      content,
      allowed_mentions: mention.allowedMentions,
    });
  } catch (error) {
    if (error instanceof DiscordApiError && error.isPermanent) {
      // チャンネル削除・権限不足など。再試行しても無駄なので止める
      await repo.markFailed(env.DB, reminder.id, describeError(error), now);
    } else {
      // 429 / 5xx / ネットワーク。リースだけ外して次の分で再試行する
      await repo.releaseWithError(env.DB, reminder.id, describeError(error), now);
    }
    return;
  }

  // 取りこぼしたぶんも「鳴った回数」として消費する（復旧時の連投を避けるため）
  const firedIncrement = 1 + skipped;
  const totalFired = reminder.firedCount + firedIncrement;
  const reachedLimit = reminder.maxCount !== null && totalFired >= reminder.maxCount;
  const nextFireAt = reachedLimit ? null : next;
  const status: ReminderStatus = nextFireAt === null ? 'completed' : 'active';

  await repo.finishDelivery(env.DB, reminder.id, {
    nextFireAt,
    firedIncrement,
    status,
    now,
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
