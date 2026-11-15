import type { Env } from '../../env';

/** 1回の紹介で出す件数の上限。Workers の subrequest / D1 クエリ上限に対する安全弁 */
const MAX_DIGEST_COUNT = 5;

export interface ReadLaterConfig {
  /** URL を貼るチャンネル（ここだけを読む） */
  sourceChannelId: string;
  /** 紹介を投稿するチャンネル */
  notifyChannelId: string;
  /** この人の投稿だけを記事として扱い、ボタンもこの人だけが押せる */
  ownerId: string;
  digestHour: number;
  digestMinute: number;
  digestCount: number;
  snoozeDays: number;
  /** ボタンを押さずに流した記事を、次に紹介するまで空ける日数 */
  ignoreCooldownDays: number;
  timeZone: string;
}

function intOr(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * wrangler.jsonc の vars から設定を読む。
 * 監視チャンネルか持ち主が未設定なら null（＝この機能は何もしない）。
 * 友人サーバーで使っている既存機能には影響させないため、既定は「無効」にしている。
 */
export function loadConfig(env: Env): ReadLaterConfig | null {
  const sourceChannelId = env.READ_LATER_SOURCE_CHANNEL_ID?.trim();
  const ownerId = env.READ_LATER_OWNER_ID?.trim();
  if (!sourceChannelId || !ownerId) return null;

  const time = /^(\d{1,2}):(\d{2})$/.exec(env.READ_LATER_DIGEST_TIME?.trim() ?? '');
  const hour = time ? Number(time[1]) : 8;
  const minute = time ? Number(time[2]) : 0;

  return {
    sourceChannelId,
    notifyChannelId: env.READ_LATER_NOTIFY_CHANNEL_ID?.trim() || sourceChannelId,
    ownerId,
    digestHour: hour >= 0 && hour <= 23 ? hour : 8,
    digestMinute: minute >= 0 && minute <= 59 ? minute : 0,
    digestCount: intOr(env.READ_LATER_DIGEST_COUNT, 3, 1, MAX_DIGEST_COUNT),
    snoozeDays: intOr(env.READ_LATER_SNOOZE_DAYS, 7, 1, 365),
    ignoreCooldownDays: 3,
    timeZone: env.DEFAULT_TIMEZONE || 'Asia/Tokyo',
  };
}
