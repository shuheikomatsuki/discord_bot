import {
  type APIEmbed,
  type APIMessageTopLevelComponent,
  ButtonStyle,
  ComponentType,
} from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { discordTimestamp } from '../../core/time';
import type { Item } from './schema';

export const FEATURE_NAME = 'readlater';

/** これだけスヌーズされたら「そろそろ決めよう」と声をかける */
export const SNOOZE_NUDGE_THRESHOLD = 3;

const COLOR_UNREAD = 0x5865f2;
const COLOR_DONE = 0x57f287;
const COLOR_MUTED = 0x99aab5;

const DAY = 24 * 60 * 60;

export function originalMessageUrl(item: Item): string | null {
  if (!item.guildId) return null;
  return `https://discord.com/channels/${item.guildId}/${item.channelId}/${item.messageId}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function itemEmbed(item: Item, now: number): APIEmbed {
  const ageDays = Math.max(0, Math.floor((now - item.savedAt) / DAY));
  const lines: string[] = [];
  if (item.note) lines.push(`💬 ${item.note}`);
  lines.push(item.url);

  const meta = [`📅 ${discordTimestamp(item.savedAt, 'D')} に保存（${ageDays}日前）`];
  if (item.notifyCount > 0) meta.push(`紹介 ${item.notifyCount + 1} 回目`);
  const original = originalMessageUrl(item);
  if (original) meta.push(`[元の投稿](${original})`);
  lines.push(meta.join(' ・ '));

  if (item.status === 'unread' && item.snoozeCount >= SNOOZE_NUDGE_THRESHOLD) {
    lines.push(
      `⚠️ ${item.snoozeCount} 回「また今度」にしています。今日読むか、いらないか決めませんか？`,
    );
  }

  const color =
    item.status === 'done'
      ? COLOR_DONE
      : item.status === 'dropped' || item.snoozeUntil
        ? COLOR_MUTED
        : COLOR_UNREAD;

  return {
    title: (item.title || hostOf(item.url)).slice(0, 256),
    url: item.url,
    description: lines.join('\n').slice(0, 4000),
    color,
  };
}

export function itemButtons(item: Item, snoozeDays: number): APIMessageTopLevelComponent[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Success,
          label: '読んだ',
          emoji: { name: '✅' },
          custom_id: encodeCustomId(FEATURE_NAME, 'done', item.id),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Primary,
          label: `${snoozeDays}日後にまた`,
          emoji: { name: '🔁' },
          custom_id: encodeCustomId(FEATURE_NAME, 'snooze', item.id),
        },
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: 'いらない',
          emoji: { name: '🗑️' },
          custom_id: encodeCustomId(FEATURE_NAME, 'drop', item.id),
        },
      ],
    },
  ];
}

/** 操作後に残す「元に戻す」ボタン。何を取り消すかを custom_id に持たせる */
export function undoButtons(
  item: Item,
  action: 'done' | 'snooze' | 'drop',
): APIMessageTopLevelComponent[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Secondary,
          label: '元に戻す',
          emoji: { name: '↩️' },
          custom_id: encodeCustomId(FEATURE_NAME, 'undo', item.id, action),
        },
      ],
    },
  ];
}

export function resultLine(item: Item, action: 'done' | 'snooze' | 'drop'): string {
  switch (action) {
    case 'done':
      return '✅ 読了にしました。おつかれさまでした！';
    case 'snooze':
      return item.snoozeUntil
        ? `🔁 ${discordTimestamp(item.snoozeUntil, 'D')} 以降にまた紹介します。`
        : '🔁 また今度紹介します。';
    case 'drop':
      return '🗑️ もう紹介しません。';
  }
}

export function digestHeader(picked: number, unread: number): string {
  return `📚 **今日のあとで読む** — 未読 ${unread} 件から ${picked} 件`;
}
