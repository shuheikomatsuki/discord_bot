/**
 * タイムゾーンを跨ぐ時刻計算。Workers は完全な ICU を積んでいるので
 * Intl.DateTimeFormat だけで完結し、追加ライブラリは要らない。
 * 保存は常に UNIX 秒 (UTC)、表示と解釈のときだけタイムゾーンを当てる。
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0=日曜 ... 6=土曜 */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

/** UNIX 秒 -> そのタイムゾーンでの壁時計 */
export function toZonedParts(epochSeconds: number, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';

  const hour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // 一部の環境で真夜中が 24 になることがあるため正規化する
    hour: hour === 24 ? 0 : hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** そのタイムゾーンにおける UTC からのオフセット（秒） */
function offsetSeconds(epochMillis: number, timeZone: string): number {
  const p = toZonedParts(Math.floor(epochMillis / 1000), timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asIfUtc - epochMillis) / 1000);
}

/**
 * そのタイムゾーンでの壁時計 -> UNIX 秒。
 * オフセット自体が時刻に依存する（DST）ため、一度求めてから補正し直す。
 * Asia/Tokyo は DST が無いので実質1回で決まるが、汎用に書いておく。
 */
export function fromZonedParts(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second?: number;
  },
  timeZone: string,
): number {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );
  let epochMillis = naive - offsetSeconds(naive, timeZone) * 1000;
  epochMillis = naive - offsetSeconds(epochMillis, timeZone) * 1000;
  return Math.floor(epochMillis / 1000);
}

/** Discord のタイムスタンプ記法。ユーザーそれぞれのローカル時刻で表示される */
export function discordTimestamp(
  epochSeconds: number,
  style: 'f' | 'F' | 'R' | 't' | 'D' = 'f',
): string {
  return `<t:${Math.floor(epochSeconds)}:${style}>`;
}

const PAD = (n: number): string => String(n).padStart(2, '0');

export function formatZoned(epochSeconds: number, timeZone: string): string {
  const p = toZonedParts(epochSeconds, timeZone);
  return `${p.year}-${PAD(p.month)}-${PAD(p.day)} ${PAD(p.hour)}:${PAD(p.minute)}`;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
