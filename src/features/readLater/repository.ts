import type { Item, ItemRow, ItemStatus } from './schema';
import { toItem } from './schema';

const COLUMNS = `id, url, note, title, guild_id, channel_id, message_id, author_id, saved_at,
  status, snooze_until, snooze_count, notify_count, last_notified_at, resolved_at,
  created_at, updated_at`;

export interface NewItem {
  id: string;
  url: string;
  note: string | null;
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  savedAt: number;
}

/** 同じ URL が既にあれば黙って無視する（UNIQUE 制約 + OR IGNORE） */
export async function insertItems(db: D1Database, items: NewItem[], now: number): Promise<void> {
  if (items.length === 0) return;
  const statement = db.prepare(
    `INSERT OR IGNORE INTO read_later_items
       (id, url, note, guild_id, channel_id, message_id, author_id, saved_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  );
  await db.batch(
    items.map((i) =>
      statement.bind(
        i.id,
        i.url,
        i.note,
        i.guildId,
        i.channelId,
        i.messageId,
        i.authorId,
        i.savedAt,
        now,
      ),
    ),
  );
}

export async function findById(db: D1Database, id: string): Promise<Item | null> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM read_later_items WHERE id = ?1`)
    .bind(id)
    .first<ItemRow>();
  return row ? toItem(row) : null;
}

export async function findByIds(db: D1Database, ids: string[]): Promise<Item[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(', ');
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM read_later_items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<ItemRow>();
  const byId = new Map((results ?? []).map((row) => [row.id, toItem(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * 今日の紹介候補。未読で、スヌーズ明けで、最近流したばかりではないもの。
 * 選ぶのは JS 側（select.ts）なので、ここでは重み計算に要る列だけ返す。
 */
export async function findCandidates(
  db: D1Database,
  now: number,
  notifiedBefore: number,
): Promise<{ id: string; savedAt: number; notifyCount: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT id, saved_at, notify_count FROM read_later_items
        WHERE status = 'unread'
          AND (snooze_until IS NULL OR snooze_until <= ?1)
          AND (last_notified_at IS NULL OR last_notified_at <= ?2 OR snooze_until IS NOT NULL)`,
    )
    .bind(now, notifiedBefore)
    .all<{ id: string; saved_at: number; notify_count: number }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    savedAt: r.saved_at,
    notifyCount: r.notify_count,
  }));
}

export async function countUnread(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM read_later_items WHERE status = 'unread'`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function setTitle(db: D1Database, id: string, title: string): Promise<void> {
  await db.prepare('UPDATE read_later_items SET title = ?2 WHERE id = ?1').bind(id, title).run();
}

/** 紹介した記録。スヌーズは「明けて紹介された」時点で消化済みにする */
export async function markNotified(db: D1Database, ids: string[], now: number): Promise<void> {
  if (ids.length === 0) return;
  const statement = db.prepare(
    `UPDATE read_later_items
        SET notify_count = notify_count + 1, last_notified_at = ?2,
            snooze_until = NULL, updated_at = ?2
      WHERE id = ?1`,
  );
  await db.batch(ids.map((id) => statement.bind(id, now)));
}

export async function resolve(
  db: D1Database,
  id: string,
  status: Exclude<ItemStatus, 'unread'>,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE read_later_items
          SET status = ?2, snooze_until = NULL, resolved_at = ?3, updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(id, status, now)
    .run();
}

export async function snooze(
  db: D1Database,
  id: string,
  until: number,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE read_later_items
          SET status = 'unread', snooze_until = ?2, snooze_count = snooze_count + 1,
              resolved_at = NULL, updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(id, until, now)
    .run();
}

/** 押し間違いの取り消し。未読に戻し、スヌーズしていたならその回数も戻す */
export async function reopen(
  db: D1Database,
  id: string,
  undoSnooze: boolean,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE read_later_items
          SET status = 'unread', snooze_until = NULL, resolved_at = NULL,
              snooze_count = CASE WHEN ?2 = 1 AND snooze_count > 0 THEN snooze_count - 1 ELSE snooze_count END,
              updated_at = ?3
        WHERE id = ?1`,
    )
    .bind(id, undoSnooze ? 1 : 0, now)
    .run();
}

export async function getState(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT value FROM read_later_state WHERE key = ?1')
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(
  db: D1Database,
  key: string,
  value: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO read_later_state (key, value, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, now)
    .run();
}

/**
 * 今日の紹介を「取る」（楽観ロック）。記録済みの日付と違うときだけ書き換え、
 * 書き換えられた（changes = 1）ときだけ送信に進む。これで二重送信を防ぐ。
 */
export async function claimDigest(db: D1Database, date: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO read_later_state (key, value, updated_at) VALUES ('digest:last', ?1, ?2)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        WHERE read_later_state.value <> excluded.value`,
    )
    .bind(date, now)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
