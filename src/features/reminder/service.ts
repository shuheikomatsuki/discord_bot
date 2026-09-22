import {
  type APIButtonComponent,
  type APIEmbed,
  type APIMessageTopLevelComponent,
  ButtonStyle,
  ComponentType,
} from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { discordTimestamp, formatZoned } from '../../core/time';
import { shortId } from '../../core/ulid';
import { describeMention } from '../../discord/mentions';
import { describeSchedule } from './schedule';
import type { Reminder } from './schema';

export const FEATURE_NAME = 'reminder';

export function statusEmoji(reminder: Reminder): string {
  switch (reminder.status) {
    case 'active':
      return '🟢';
    case 'paused':
      return '⏸️';
    case 'completed':
      return '✅';
    case 'failed':
      return '⚠️';
  }
}

export function countLabel(reminder: Reminder): string {
  return `${reminder.firedCount}/${reminder.maxCount ?? '∞'}`;
}

export function mentionSpecOf(reminder: Reminder): {
  type: Reminder['mentionType'];
  userIds: string[];
  roleIds: string[];
} {
  return {
    type: reminder.mentionType,
    userIds: reminder.mentionUserIds,
    roleIds: reminder.mentionRoleIds,
  };
}

export function scheduleSpecOf(reminder: Reminder): {
  kind: Reminder['scheduleKind'];
  expr: string;
  timeZone: string;
} {
  return {
    kind: reminder.scheduleKind,
    expr: reminder.scheduleExpr,
    timeZone: reminder.timeZone,
  };
}

export function reminderEmbed(reminder: Reminder): APIEmbed {
  const next =
    reminder.nextFireAt === null
      ? '—'
      : `${discordTimestamp(reminder.nextFireAt)} (${discordTimestamp(reminder.nextFireAt, 'R')})`;

  const embed: APIEmbed = {
    title: `${statusEmoji(reminder)} リマインダー \`${shortId(reminder.id)}\``,
    description: reminder.message.slice(0, 2000),
    color: reminder.status === 'active' ? 0x57f287 : 0x99aab5,
    fields: [
      { name: 'スケジュール', value: describeSchedule(scheduleSpecOf(reminder)), inline: true },
      { name: '次回', value: next, inline: true },
      { name: '回数', value: countLabel(reminder), inline: true },
      { name: 'メンション', value: describeMention(mentionSpecOf(reminder)), inline: true },
      { name: '投稿先', value: `<#${reminder.channelId}>`, inline: true },
      { name: '作成者', value: `<@${reminder.createdBy}>`, inline: true },
    ],
    footer: {
      text: `ID: ${reminder.id} ・ ${reminder.timeZone}${
        reminder.nextFireAt === null
          ? ''
          : ` ・ ${formatZoned(reminder.nextFireAt, reminder.timeZone)}`
      }`,
    },
  };

  if (reminder.lastError) {
    embed.fields?.push({ name: '直近のエラー', value: reminder.lastError.slice(0, 1000) });
  }
  return embed;
}

/** 作成直後・詳細表示に付ける操作ボタン */
export function reminderButtons(reminder: Reminder): APIMessageTopLevelComponent[] {
  const buttons: APIButtonComponent[] = [];

  if (reminder.status === 'active') {
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Secondary,
      label: '一時停止',
      emoji: { name: '⏸️' },
      custom_id: encodeCustomId(FEATURE_NAME, 'pause', reminder.id),
    });
  } else if (reminder.status === 'paused') {
    buttons.push({
      type: ComponentType.Button,
      style: ButtonStyle.Success,
      label: '再開',
      emoji: { name: '▶️' },
      custom_id: encodeCustomId(FEATURE_NAME, 'resume', reminder.id),
    });
  }

  buttons.push({
    type: ComponentType.Button,
    style: ButtonStyle.Danger,
    label: '削除',
    emoji: { name: '🗑️' },
    custom_id: encodeCustomId(FEATURE_NAME, 'delete', reminder.id),
  });

  return [{ type: ComponentType.ActionRow, components: buttons }];
}

export function listLines(reminders: Reminder[]): string {
  if (reminders.length === 0)
    return 'リマインダーはまだありません。`/remind once` などで作成できます。';

  return reminders
    .map((r) => {
      const when = r.nextFireAt === null ? '—' : discordTimestamp(r.nextFireAt, 'f');
      const head = `${statusEmoji(r)} \`${shortId(r.id)}\` ${describeSchedule(scheduleSpecOf(r))} ・ 次回 ${when} ・ ${countLabel(r)}`;
      const body = r.message.length > 60 ? `${r.message.slice(0, 60)}…` : r.message;
      return `${head}\n　${body.replace(/\n/g, ' ')}`;
    })
    .join('\n');
}

/** 一覧やオートコンプリートでの短いラベル */
export function autocompleteLabel(reminder: Reminder): string {
  const label = `${shortId(reminder.id)} | ${describeSchedule(scheduleSpecOf(reminder))} | ${reminder.message.replace(/\s+/g, ' ')}`;
  return label.length > 100 ? `${label.slice(0, 99)}…` : label;
}
