export type ItemStatus = 'unread' | 'done' | 'dropped';

/** D1 の行そのまま */
export interface ItemRow {
  id: string;
  url: string;
  note: string | null;
  title: string | null;
  guild_id: string | null;
  channel_id: string;
  message_id: string;
  author_id: string;
  saved_at: number;
  status: string;
  snooze_until: number | null;
  snooze_count: number;
  notify_count: number;
  last_notified_at: number | null;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Item {
  id: string;
  url: string;
  note: string | null;
  title: string | null;
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  savedAt: number;
  status: ItemStatus;
  snoozeUntil: number | null;
  snoozeCount: number;
  notifyCount: number;
  lastNotifiedAt: number | null;
}

export function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    url: row.url,
    note: row.note,
    title: row.title,
    guildId: row.guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    authorId: row.author_id,
    savedAt: row.saved_at,
    status: (['unread', 'done', 'dropped'].includes(row.status)
      ? row.status
      : 'unread') as ItemStatus,
    snoozeUntil: row.snooze_until,
    snoozeCount: row.snooze_count,
    notifyCount: row.notify_count,
    lastNotifiedAt: row.last_notified_at,
  };
}
