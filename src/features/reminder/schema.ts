import type { MentionType } from '../../discord/mentions';
import type { ScheduleKind } from './schedule';

export type ReminderStatus = 'active' | 'paused' | 'completed' | 'failed';

/** D1 の行そのまま */
export interface ReminderRow {
  id: string;
  guild_id: string;
  channel_id: string;
  created_by: string;
  message: string;
  mention_type: string;
  mention_user_ids: string;
  mention_role_ids: string;
  timezone: string;
  schedule_kind: string;
  schedule_expr: string;
  next_fire_at: number | null;
  max_count: number | null;
  fired_count: number;
  status: string;
  lease_until: number | null;
  last_fired_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** アプリ側で扱う形（JSON 列をパースし、型を絞ったもの） */
export interface Reminder {
  id: string;
  guildId: string;
  channelId: string;
  createdBy: string;
  message: string;
  mentionType: MentionType;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  timeZone: string;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  nextFireAt: number | null;
  maxCount: number | null;
  firedCount: number;
  status: ReminderStatus;
  leaseUntil: number | null;
  lastFiredAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

function parseIdList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    createdBy: row.created_by,
    message: row.message,
    mentionType: row.mention_type as MentionType,
    mentionUserIds: parseIdList(row.mention_user_ids),
    mentionRoleIds: parseIdList(row.mention_role_ids),
    timeZone: row.timezone,
    scheduleKind: row.schedule_kind as ScheduleKind,
    scheduleExpr: row.schedule_expr,
    nextFireAt: row.next_fire_at,
    maxCount: row.max_count,
    firedCount: row.fired_count,
    status: row.status as ReminderStatus,
    leaseUntil: row.lease_until,
    lastFiredAt: row.last_fired_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
