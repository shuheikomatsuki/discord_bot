import type { APIMessage } from 'discord-api-types/v10';
import { ulid } from '../../core/ulid';
import { getChannel, getChannelMessages } from '../../discord/rest';
import type { Env } from '../../env';
import type { ReadLaterConfig } from './config';
import * as repo from './repository';
import { extractNote, extractUrls } from './urls';

/** 1回の取り込みで読むページ数（1ページ100件）。subrequest 上限に対する安全弁 */
const MAX_PAGES = 3;
const PAGE_SIZE = 100;

export class MissingContentIntentError extends Error {
  constructor() {
    super(
      'メッセージ本文が空で返ってきました。Developer Portal > Bot で Message Content Intent を ON にしてください',
    );
    this.name = 'MissingContentIntentError';
  }
}

/**
 * 監視チャンネルの新しい投稿を D1 に取り込む。
 * 「どこまで読んだか」を read_later_state にカーソルとして持ち、そこから先だけを読む。
 * 初回はカーソルが無いので一番古い投稿から読み、数回の実行に分けて過去分も取り込む。
 */
export async function syncSource(env: Env, config: ReadLaterConfig, now: number): Promise<number> {
  const channelId = config.sourceChannelId;
  const cursorKey = `cursor:${channelId}`;
  let cursor = (await repo.getState(env.DB, cursorKey)) ?? '0';
  const guildId = await resolveGuildId(env, channelId, now);
  let inserted = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const messages = await getChannelMessages(env.DISCORD_BOT_TOKEN, channelId, {
      after: cursor,
      limit: PAGE_SIZE,
    });
    if (messages.length === 0) break;
    messages.sort((a, b) => compareSnowflakes(a.id, b.id));

    const owned = messages.filter((m) => m.author.id === config.ownerId && !m.author.bot);
    // Intent が OFF のまま取り込むとカーソルだけ進んで記事を取りこぼすので、ここで止める
    if (owned.some(looksLikeMissingContent)) throw new MissingContentIntentError();

    const items = owned.flatMap((message) => itemsFrom(message, channelId, guildId));
    await repo.insertItems(env.DB, items, now);
    inserted += items.length;

    cursor = messages[messages.length - 1]?.id ?? cursor;
    await repo.setState(env.DB, cursorKey, cursor, now);
    if (messages.length < PAGE_SIZE) break;
  }
  return inserted;
}

/** 本文 + 転送されたメッセージの本文 */
export function textOf(message: APIMessage): string {
  const snapshots = (message.message_snapshots ?? []).map((s) => s.message.content ?? '');
  return [message.content ?? '', ...snapshots].join('\n').trim();
}

export function itemsFrom(
  message: APIMessage,
  channelId: string,
  guildId: string | null,
): repo.NewItem[] {
  const text = textOf(message);
  const urls = extractUrls(text);
  if (urls.length === 0) return [];
  const savedAt = Math.floor(Date.parse(message.timestamp) / 1000);
  const note = extractNote(text);
  return urls.map((url) => ({
    id: ulid(savedAt * 1000),
    url,
    note,
    guildId,
    channelId,
    messageId: message.id,
    authorId: message.author.id,
    savedAt,
  }));
}

/** 人間の投稿なのに本文も添付も何も無い = 本文を読む権限が無い */
export function looksLikeMissingContent(message: APIMessage): boolean {
  return (
    textOf(message) === '' &&
    (message.attachments?.length ?? 0) === 0 &&
    (message.embeds?.length ?? 0) === 0 &&
    (message.sticker_items?.length ?? 0) === 0 &&
    !message.poll
  );
}

export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 「元の投稿へ」リンクにサーバー ID が要る。チャンネルから一度だけ引いて覚えておく */
async function resolveGuildId(env: Env, channelId: string, now: number): Promise<string | null> {
  const key = `guild:${channelId}`;
  const cached = await repo.getState(env.DB, key);
  if (cached !== null) return cached || null;
  const channel = await getChannel(env.DISCORD_BOT_TOKEN, channelId);
  await repo.setState(env.DB, key, channel.guild_id ?? '', now);
  return channel.guild_id ?? null;
}
