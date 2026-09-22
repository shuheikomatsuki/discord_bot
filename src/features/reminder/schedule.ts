import { fromZonedParts, toZonedParts } from '../../core/time';

/**
 * スケジュールの表現は2系統に分ける。
 *  - interval: 周期を「秒」で持ち、単純な加算で次回を求める（DST も月末も考えなくてよい）
 *  - cron    : 暦ベース（毎週月曜、毎月1日）はこちらで表現する
 * この線引きを崩すと「毎月」の実装で必ず破綻する。
 */
export type ScheduleKind = 'once' | 'interval' | 'cron';

export class ScheduleError extends Error {}

export const MIN_INTERVAL_SECONDS = 60; // cron が毎分なのでこれより短くはできない
export const MAX_INTERVAL_SECONDS = 365 * 24 * 60 * 60;

// ---------------------------------------------------------------- interval

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
};

const DURATION_PATTERN = /(\d+)\s*([smhdw])/gi;

/** "1h30m" / "10m" / "1d" -> 秒。解釈できなければ null */
export function parseDuration(input: string): number | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === '') return null;

  // 単位なしの数値は「分」とみなす（"30" -> 30分）
  if (/^\d+$/.test(normalized)) return Number(normalized) * 60;

  let total = 0;
  let matched = 0;
  DURATION_PATTERN.lastIndex = 0;
  for (const match of normalized.matchAll(DURATION_PATTERN)) {
    const amount = Number(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    const seconds = UNIT_SECONDS[unit];
    if (seconds === undefined || !Number.isFinite(amount)) return null;
    total += amount * seconds;
    matched += match[0].length;
  }
  // 余計な文字が混ざっていたら拒否する（"1h x" のような入力を通さない）
  if (matched !== normalized.replace(/\s/g, '').length) return null;
  return total > 0 ? total : null;
}

export function parseInterval(input: string): number {
  const seconds = parseDuration(input);
  if (seconds === null) {
    throw new ScheduleError(
      `頻度を解釈できませんでした: \`${input}\`\n例: \`10m\` \`1h\` \`1d\` \`1w\` \`1h30m\``,
    );
  }
  if (seconds < MIN_INTERVAL_SECONDS) {
    throw new ScheduleError('頻度は1分以上にしてください。');
  }
  if (seconds > MAX_INTERVAL_SECONDS) {
    throw new ScheduleError('頻度は1年以内にしてください。');
  }
  return seconds;
}

export function formatDuration(seconds: number): string {
  const units: [number, string][] = [
    [UNIT_SECONDS.w as number, '週間'],
    [UNIT_SECONDS.d as number, '日'],
    [UNIT_SECONDS.h as number, '時間'],
    [UNIT_SECONDS.m as number, '分'],
  ];
  let rest = seconds;
  const out: string[] = [];
  for (const [size, label] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      out.push(`${count}${label}`);
      rest -= count * size;
    }
  }
  return out.length > 0 ? out.join('') : `${seconds}秒`;
}

// -------------------------------------------------------------------- at

const ABSOLUTE_PATTERNS: {
  re: RegExp;
  pick: (m: RegExpMatchArray, nowYear: number) => number[];
}[] = [
  // 2026-10-01 09:00 / 2026/10/01 09:00
  {
    re: /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})$/,
    pick: (m) => [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])],
  },
  // 10/01 09:00
  {
    re: /^(\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})$/,
    pick: (m, nowYear) => [nowYear, Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])],
  },
];

const TIME_ONLY = /^(\d{1,2}):(\d{2})$/;

/**
 * `at` オプションの解釈。
 *  - 相対: "30m" "2h" "1d"
 *  - 時刻のみ: "09:00" → 次に来るその時刻
 *  - 日付付き: "10/01 09:00" / "2026-10-01 09:00"
 */
export function parseAt(input: string, timeZone: string, nowSeconds: number): number {
  const raw = input.trim();
  if (raw === '') throw new ScheduleError('日時が空です。');

  // 相対指定
  const duration = parseDuration(raw);
  if (duration !== null && !raw.includes(':')) {
    return nowSeconds + duration;
  }

  const now = toZonedParts(nowSeconds, timeZone);

  const timeOnly = raw.match(TIME_ONLY);
  if (timeOnly) {
    const hour = Number(timeOnly[1]);
    const minute = Number(timeOnly[2]);
    assertClock(hour, minute);
    let at = fromZonedParts({ ...now, hour, minute, second: 0 }, timeZone);
    if (at <= nowSeconds) {
      const tomorrow = addDays(now.year, now.month, now.day, 1);
      at = fromZonedParts({ ...tomorrow, hour, minute, second: 0 }, timeZone);
    }
    return at;
  }

  for (const { re, pick } of ABSOLUTE_PATTERNS) {
    const match = raw.match(re);
    if (!match) continue;
    const [year, month, day, hour, minute] = pick(match, now.year) as [
      number,
      number,
      number,
      number,
      number,
    ];
    assertCalendar(year, month, day);
    assertClock(hour, minute);
    let at = fromZonedParts({ year, month, day, hour, minute, second: 0 }, timeZone);
    // 年を省略した指定が過去になったら来年とみなす
    if (at <= nowSeconds && !/^\d{4}/.test(raw)) {
      at = fromZonedParts({ year: year + 1, month, day, hour, minute, second: 0 }, timeZone);
    }
    return at;
  }

  throw new ScheduleError(
    `日時を解釈できませんでした: \`${input}\`\n` +
      '例: `09:00` `10/01 09:00` `2026-10-01 09:00` `30m`（30分後）',
  );
}

function assertClock(hour: number, minute: number): void {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new ScheduleError('時刻は 00:00〜23:59 の範囲で指定してください。');
  }
}

function assertCalendar(year: number, month: number, day: number): void {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1970 || year > 2200) {
    throw new ScheduleError('日付が不正です。');
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ScheduleError(`存在しない日付です: ${year}-${month}-${day}`);
  }
}

function addDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + delta);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

// ------------------------------------------------------------------ cron

export interface CronExpression {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number, label: string): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new ScheduleError(`cron の ${label} のステップが不正です: \`${part}\``);
    }

    let from: number;
    let to: number;
    if (rangePart === '*' || rangePart === '') {
      from = min;
      to = max;
    } else if (rangePart?.includes('-')) {
      const [a, b] = rangePart.split('-');
      from = Number(a);
      to = Number(b);
    } else {
      from = Number(rangePart);
      to = stepPart === undefined ? from : max;
    }

    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new ScheduleError(`cron の ${label} が範囲外です: \`${part}\`（${min}〜${max}）`);
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  if (values.size === 0) throw new ScheduleError(`cron の ${label} が空です`);
  return [...values].sort((a, b) => a - b);
}

/** 標準5フィールド（分 時 日 月 曜）。曜日は 0=日曜、7も日曜として許容 */
export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleError(
      `cron 式は「分 時 日 月 曜」の5つで指定してください: \`${expression}\`\n` +
        '例: `0 9 * * 1`（毎週月曜9時） `0 9 1 * *`（毎月1日9時） `30 8 * * 1-5`（平日8:30）',
    );
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseField(dow, 0, 7, '曜').map((d) => (d === 7 ? 0 : d));

  return {
    minutes: parseField(minute, 0, 59, '分'),
    hours: parseField(hour, 0, 23, '時'),
    daysOfMonth: parseField(dom, 1, 31, '日'),
    months: parseField(month, 1, 12, '月'),
    daysOfWeek: [...new Set(daysOfWeek)].sort((a, b) => a - b),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  };
}

function matchesDay(expr: CronExpression, year: number, month: number, day: number): boolean {
  if (!expr.months.includes(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const domHit = expr.daysOfMonth.includes(day);
  const dowHit = expr.daysOfWeek.includes(weekday);

  // 標準 cron の仕様: 日と曜の両方が指定されている場合は OR
  if (expr.domRestricted && expr.dowRestricted) return domHit || dowHit;
  if (expr.domRestricted) return domHit;
  if (expr.dowRestricted) return dowHit;
  return true;
}

/**
 * `after` より後の最初の発火時刻。分単位で総当たりすると最大52万回ループするので、
 * 日単位で回して一致した日の中だけ 時×分 を走査する。
 */
export function nextCronFire(expr: CronExpression, timeZone: string, after: number): number | null {
  // after より厳密に後の、次の分境界から探す
  const cursor = Math.floor(after / 60) * 60 + 60;
  const start = toZonedParts(cursor, timeZone);
  let { year, month, day } = start;

  for (let i = 0; i < 400; i++) {
    if (matchesDay(expr, year, month, day)) {
      for (const hour of expr.hours) {
        for (const minute of expr.minutes) {
          const at = fromZonedParts({ year, month, day, hour, minute, second: 0 }, timeZone);
          if (at >= cursor) return at;
        }
      }
    }
    ({ year, month, day } = addDays(year, month, day, 1));
  }
  return null;
}

// -------------------------------------------------------- 共通インターフェース

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** once: 発火時刻(UNIX秒) / interval: 周期(秒) / cron: cron式 */
  expr: string;
  timeZone: string;
}

/** 作成時の初回発火時刻 */
export function firstFireAt(spec: ScheduleSpec, nowSeconds: number): number {
  switch (spec.kind) {
    case 'once': {
      const at = Number(spec.expr);
      if (!Number.isFinite(at)) throw new ScheduleError('発火時刻が不正です。');
      return at;
    }
    case 'interval':
      return nowSeconds + Number(spec.expr);
    case 'cron': {
      const at = nextCronFire(parseCron(spec.expr), spec.timeZone, nowSeconds);
      if (at === null)
        throw new ScheduleError('この cron 式に一致する日時が見つかりませんでした。');
      return at;
    }
  }
}

export interface AdvanceResult {
  /** 次回の発火時刻。もう発火しないなら null */
  next: number | null;
  /** 障害などで取りこぼし、送らずに飛ばした回数 */
  skipped: number;
}

const MAX_CATCH_UP_STEPS = 500;

/**
 * 発火後に次回を決める。取りこぼしぶんは「送らずに飛ばす」。
 * 復旧時に毎時リマインダーが6連投されるのは事故なので、必ず now より後まで進める。
 */
export function advanceSchedule(
  spec: ScheduleSpec,
  firedAt: number,
  nowSeconds: number,
): AdvanceResult {
  switch (spec.kind) {
    case 'once':
      return { next: null, skipped: 0 };

    case 'interval': {
      const interval = Number(spec.expr);
      if (!Number.isFinite(interval) || interval <= 0) return { next: null, skipped: 0 };
      let next = firedAt + interval;
      let skipped = 0;
      while (next <= nowSeconds && skipped < MAX_CATCH_UP_STEPS) {
        next += interval;
        skipped++;
      }
      return { next, skipped };
    }

    case 'cron': {
      const expr = parseCron(spec.expr);
      let next = nextCronFire(expr, spec.timeZone, firedAt);
      let skipped = 0;
      while (next !== null && next <= nowSeconds && skipped < MAX_CATCH_UP_STEPS) {
        next = nextCronFire(expr, spec.timeZone, next);
        skipped++;
      }
      return { next, skipped };
    }
  }
}

export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'once':
      return '1回のみ';
    case 'interval':
      return `${formatDuration(Number(spec.expr))}ごと`;
    case 'cron':
      return `cron \`${spec.expr}\``;
  }
}
