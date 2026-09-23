import type { Reminder, ReminderRow, ReminderStatus } from './schema';
import { toReminder } from './schema';

const COLUMNS = `id, guild_id, channel_id, created_by, message,
  mention_type, mention_user_ids, mention_role_ids,
  timezone, schedule_kind, schedule_expr, next_fire_at,
  max_count, fired_count, status, lease_until, last_fired_at, last_error,
  created_at, updated_at`;

export interface NewReminder {
  id: string;
  guildId: string;
  channelId: string;
  createdBy: string;
  message: string;
  mentionType: string;
  mentionUserIds: string[];
  mentionRoleIds: string[];
  timeZone: string;
  scheduleKind: string;
  scheduleExpr: string;
  nextFireAt: number;
  maxCount: number | null;
  now: number;
}

export async function insert(db: D1Database, r: NewReminder): Promise<void> {
  await db
    .prepare(
      `INSERT INTO reminders (${COLUMNS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 'active', NULL, NULL, NULL, ?14, ?14)`,
    )
    .bind(
      r.id,
      r.guildId,
      r.channelId,
      r.createdBy,
      r.message,
      r.mentionType,
      JSON.stringify(r.mentionUserIds),
      JSON.stringify(r.mentionRoleIds),
      r.timeZone,
      r.scheduleKind,
      r.scheduleExpr,
      r.nextFireAt,
      r.maxCount,
      r.now,
    )
    .run();
}

/**
 * id 欄の入力から検索用の ID（全体または末尾）を取り出す。
 * 候補を選んでも Discord クライアントが value ではなく表示名
 * （`145FT1 | 30分ごと | 本文…`）を送ってくることがあるので、先頭の語だけを使う。
 * ID は ULID（Crockford Base32 の 26 文字）なので、その形でなければ null。
 */
export function normalizeIdish(idish: string): string | null {
  const head = idish.trim().split(/[\s|]/, 1)[0]?.toUpperCase() ?? '';
  return /^[0-9A-Z]{1,26}$/.test(head) ? head : null;
}

/** 完全な ID でも末尾数文字でも引けるようにする（ユーザーに26文字を手打ちさせないため） */
export async function findByIdish(
  db: D1Database,
  guildId: string,
  idish: string,
): Promise<Reminder | null> {
  // 自由入力をそのまま LIKE に渡すと D1 のパターン長制限（50 バイト）で SQL エラーになるので必ず正規化する
  const needle = normalizeIdish(idish);
  if (!needle) return null;
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM reminders
       WHERE guild_id = ?1 AND (id = ?2 OR substr(id, -length(?2)) = ?2)
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(guildId, needle)
    .first<ReminderRow>();
  return row ? toReminder(row) : null;
}

export interface ListFilter {
  guildId: string;
  createdBy?: string;
  /** 完了・失敗も含めるか */
  includeInactive?: boolean;
  limit?: number;
}

export async function list(db: D1Database, filter: ListFilter): Promise<Reminder[]> {
  const conditions = ['guild_id = ?1'];
  const binds: unknown[] = [filter.guildId];

  if (filter.createdBy) {
    binds.push(filter.createdBy);
    conditions.push(`created_by = ?${binds.length}`);
  }
  if (!filter.includeInactive) {
    conditions.push(`status IN ('active', 'paused')`);
  }
  binds.push(filter.limit ?? 25);

  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM reminders
       WHERE ${conditions.join(' AND ')}
       ORDER BY (next_fire_at IS NULL), next_fire_at ASC
       LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<ReminderRow>();
  return (results ?? []).map(toReminder);
}

export interface ReminderPatch {
  message?: string;
  channelId?: string;
  mentionType?: string;
  mentionUserIds?: string[];
  mentionRoleIds?: string[];
  scheduleExpr?: string;
  nextFireAt?: number | null;
  maxCount?: number | null;
  status?: ReminderStatus;
  lastError?: string | null;
}

/** 部分更新。指定されたフィールドだけ SET する */
export async function update(
  db: D1Database,
  guildId: string,
  id: string,
  patch: ReminderPatch,
  now: number,
): Promise<boolean> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const push = (column: string, value: unknown): void => {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  };

  if (patch.message !== undefined) push('message', patch.message);
  if (patch.channelId !== undefined) push('channel_id', patch.channelId);
  if (patch.mentionType !== undefined) push('mention_type', patch.mentionType);
  if (patch.mentionUserIds !== undefined)
    push('mention_user_ids', JSON.stringify(patch.mentionUserIds));
  if (patch.mentionRoleIds !== undefined)
    push('mention_role_ids', JSON.stringify(patch.mentionRoleIds));
  if (patch.scheduleExpr !== undefined) push('schedule_expr', patch.scheduleExpr);
  if (patch.nextFireAt !== undefined) push('next_fire_at', patch.nextFireAt);
  if (patch.maxCount !== undefined) push('max_count', patch.maxCount);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.lastError !== undefined) push('last_error', patch.lastError);

  if (sets.length === 0) return false;
  push('updated_at', now);

  binds.push(guildId, id);
  const result = await db
    .prepare(
      `UPDATE reminders SET ${sets.join(', ')}
       WHERE guild_id = ?${binds.length - 1} AND id = ?${binds.length}`,
    )
    .bind(...binds)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function remove(db: D1Database, guildId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM reminders WHERE guild_id = ?1 AND id = ?2')
    .bind(guildId, id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** 毎分の cron が発火対象を引く。LIMIT は subrequest 上限に対する安全弁 */
export async function findDue(db: D1Database, now: number, limit: number): Promise<Reminder[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM reminders
       WHERE status = 'active'
         AND next_fire_at IS NOT NULL
         AND next_fire_at <= ?1
         AND (lease_until IS NULL OR lease_until < ?1)
       ORDER BY next_fire_at ASC
       LIMIT ?2`,
    )
    .bind(now, limit)
    .all<ReminderRow>();
  return (results ?? []).map(toReminder);
}

/**
 * 配信の所有権を取る（楽観ロック）。
 * 読んだときから next_fire_at が変わっていないことを条件にし、
 * UPDATE の影響行数が 1 のときだけ送信に進む。これで二重送信を防ぐ。
 */
export async function claim(
  db: D1Database,
  id: string,
  observedNextFireAt: number,
  now: number,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE reminders
          SET lease_until = ?3, updated_at = ?2
        WHERE id = ?1
          AND status = 'active'
          AND next_fire_at = ?4
          AND (lease_until IS NULL OR lease_until < ?2)`,
    )
    .bind(id, now, now + leaseSeconds, observedNextFireAt)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function finishDelivery(
  db: D1Database,
  id: string,
  params: {
    nextFireAt: number | null;
    firedIncrement: number;
    status: ReminderStatus;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE reminders
          SET fired_count  = fired_count + ?2,
              last_fired_at = ?3,
              next_fire_at = ?4,
              status       = ?5,
              lease_until  = NULL,
              last_error   = NULL,
              updated_at   = ?3
        WHERE id = ?1`,
    )
    .bind(id, params.firedIncrement, params.now, params.nextFireAt, params.status)
    .run();
}

/** 一時的な失敗: リースだけ外して次の分に再試行させる */
export async function releaseWithError(
  db: D1Database,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reminders SET lease_until = NULL, last_error = ?2, updated_at = ?3 WHERE id = ?1`,
    )
    .bind(id, error.slice(0, 500), now)
    .run();
}

/** 回復不能な失敗: 以後発火させない */
export async function markFailed(
  db: D1Database,
  id: string,
  error: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reminders
          SET status = 'failed', next_fire_at = NULL, lease_until = NULL,
              last_error = ?2, updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(id, error.slice(0, 500), now)
    .run();
}
