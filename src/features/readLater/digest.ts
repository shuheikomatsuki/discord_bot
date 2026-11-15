import { createMessage } from '../../discord/rest';
import type { Env } from '../../env';
import type { ReadLaterConfig } from './config';
import * as repo from './repository';
import { digestDateIfDue } from './schedule';
import { digestHeader, itemButtons, itemEmbed } from './service';
import { syncSource } from './sync';
import { fetchTitle } from './title';

/** 取り込みは毎分ではなく5分おきで十分（紹介は1日1回なので） */
const SYNC_EVERY_MINUTES = 5;

/** 毎分の cron から呼ばれる入口 */
export async function runReadLater(env: Env, config: ReadLaterConfig, now: number): Promise<void> {
  const date = digestDateIfDue(now, config);
  const syncTick = Math.floor(now / 60) % SYNC_EVERY_MINUTES === 0;

  // 送る直前には必ず取り込んで、さっき貼った記事も候補に入れる
  const lastDigest = date ? await repo.getState(env.DB, 'digest:last') : null;
  const digestDue = date !== null && lastDigest !== date;
  if (!syncTick && !digestDue) return;

  try {
    await syncSource(env, config, now);
  } catch (error) {
    // 取り込みに失敗しても、既に取り込んである記事の紹介は続ける
    console.error('readLater: sync failed', error);
  }

  if (date && digestDue && (await repo.claimDigest(env.DB, date, now))) {
    await sendDigest(env, config, now);
  }
}

export async function sendDigest(env: Env, config: ReadLaterConfig, now: number): Promise<void> {
  const items = await repo.findQueueHead(env.DB, now, config.digestCount);
  // 紹介できるものが無い日は黙っておく（毎日「ありません」と来るのはうるさいので）
  if (items.length === 0) return;

  const unread = await repo.countUnread(env.DB);

  await createMessage(env.DISCORD_BOT_TOKEN, config.notifyChannelId, {
    content: digestHeader(items.length, unread),
    allowed_mentions: { parse: [] },
  });

  for (const item of items) {
    if (item.title === null) {
      // '' を入れて「取得を試みた」ことを残し、失敗したページを毎回取りに行かない
      item.title = (await fetchTitle(item.url)) ?? '';
      await repo.setTitle(env.DB, item.id, item.title);
    }
    await createMessage(env.DISCORD_BOT_TOKEN, config.notifyChannelId, {
      embeds: [itemEmbed(item, now)],
      components: itemButtons(item, config.snoozeDays),
      allowed_mentions: { parse: [] },
    });
  }

  await repo.markNotified(
    env.DB,
    items.map((i) => i.id),
    now,
  );
}
