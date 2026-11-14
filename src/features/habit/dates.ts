/**
 * 習慣で使う「暦日」の計算。1日の区切りは深夜0時（ユーザーのタイムゾーン）。
 * 日付は 'YYYY-MM-DD' の文字列で扱う。辞書順 = 時系列順なので SQL でもそのまま比較できる。
 */
import { fromZonedParts, toZonedParts } from '../../core/time';

export class HabitInputError extends Error {}

const PAD = (n: number): string => String(n).padStart(2, '0');

/** UNIX 秒 -> そのタイムゾーンでの日付 */
export function dateKeyOf(epochSeconds: number, timeZone: string): string {
  const p = toZonedParts(epochSeconds, timeZone);
  return `${p.year}-${PAD(p.month)}-${PAD(p.day)}`;
}

function parseKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split('-').map(Number);
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}

/** 日付の加減算（タイムゾーンに依存しない純粋な暦計算） */
export function addDays(key: string, days: number): string {
  const { year, month, day } = parseKey(key);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${PAD(date.getUTCMonth() + 1)}-${PAD(date.getUTCDate())}`;
}

/** 0=日 … 6=土 */
export function weekdayOf(key: string): number {
  const { year, month, day } = parseKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function diffDays(from: string, to: string): number {
  const a = parseKey(from);
  const b = parseKey(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
  );
}

/** その週の月曜日 */
export function weekStartOf(key: string): string {
  return addDays(key, -((weekdayOf(key) + 6) % 7));
}

export function monthKeyOf(key: string): string {
  return key.slice(0, 7);
}

export function monthStartOf(key: string): string {
  return `${key.slice(0, 7)}-01`;
}

export function daysInMonth(monthKey: string): number {
  const { year, month } = parseKey(`${monthKey}-01`);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 日付 + 0:00 からの分 -> UNIX 秒 */
export function epochOf(key: string, minuteOfDay: number, timeZone: string): number {
  const { year, month, day } = parseKey(key);
  return fromZonedParts(
    { year, month, day, hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 },
    timeZone,
  );
}

export function formatDateJa(key: string): string {
  const { month, day } = parseKey(key);
  return `${month}/${day}(${WEEKDAY_JA[weekdayOf(key)]})`;
}

// --------------------------------------------------------------- 時刻

/** "21:00" / "21時" / "9:30" / "2130" -> 0:00 からの分 */
export function parseTimeOfDay(input: string): number {
  const s = input
    .trim()
    .replace(/[０-９：]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  const m =
    s.match(/^(\d{1,2}):(\d{2})$/) ??
    s.match(/^(\d{1,2})時(?:(\d{1,2})分?)?$/) ??
    s.match(/^(\d{2})(\d{2})$/) ??
    s.match(/^(\d{1,2})$/);
  if (!m) throw new HabitInputError(`時刻を解釈できません: \`${input}\`（例: 21:00）`);
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (hour > 23 || minute > 59) throw new HabitInputError(`時刻が範囲外です: \`${input}\``);
  return hour * 60 + minute;
}

/** 再通知の時刻。「なし」「off」などで無効（null） */
export function parseRemindTime(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (['なし', '無し', 'off', 'no', 'none', '-', '0'].includes(s)) return null;
  return parseTimeOfDay(input);
}

/** 新しい習慣の再通知の既定値。23時より前に聞く習慣だけ 23:00 に知らせる */
export const DEFAULT_REMIND_MINUTE = 23 * 60;
export function defaultRemindMinute(checkMinute: number): number | null {
  return checkMinute < DEFAULT_REMIND_MINUTE ? DEFAULT_REMIND_MINUTE : null;
}

/** 量の入力。"30" / "１．５" / "2,000" / "30分" のような単位付きも受け付ける */
export function parseAmount(input: string): number {
  const s = input
    .trim()
    .replace(/[０-９．，]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/,/g, '');
  const m = s.match(/^(\d+(?:\.\d+)?)\s*[^\d\s]{0,10}$/);
  const value = m ? Number(m[1]) : Number.NaN;
  if (!Number.isFinite(value))
    throw new HabitInputError(`数値を解釈できません: \`${input.slice(0, 30)}\`（例: 30）`);
  if (value > 1_000_000) throw new HabitInputError('数値が大きすぎます。');
  return value;
}

export function formatMinute(minuteOfDay: number): string {
  return `${PAD(Math.floor(minuteOfDay / 60))}:${PAD(minuteOfDay % 60)}`;
}

// --------------------------------------------------------------- 曜日

export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;
export const EVERY_DAY = 0b1111111;
const WEEKDAYS = 0b0111110;
const WEEKENDS = 0b1000001;

const DAY_ALIASES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

/** "毎日" / "平日" / "土日" / "月水金" / "mon,wed,fri" -> ビットマスク */
export function parseDays(input: string | undefined): number {
  const s = (input ?? '').trim().toLowerCase();
  if (s === '' || s === '毎日' || s === 'daily' || s === 'everyday') return EVERY_DAY;
  if (s === '平日' || s === 'weekdays') return WEEKDAYS;
  if (s === '土日' || s === '週末' || s === 'weekends') return WEEKENDS;

  let mask = 0;
  for (const token of s.split(/[\s,、・]+/).filter(Boolean)) {
    const alias = DAY_ALIASES[token.slice(0, 3)];
    if (alias !== undefined) {
      mask |= 1 << alias;
      continue;
    }
    for (const ch of token.replace(/曜日?/g, '')) {
      const index = WEEKDAY_JA.indexOf(ch as (typeof WEEKDAY_JA)[number]);
      if (index < 0) {
        throw new HabitInputError(`曜日を解釈できません: \`${input}\`（例: 毎日 / 平日 / 月水金）`);
      }
      mask |= 1 << index;
    }
  }
  if (mask === 0) throw new HabitInputError('曜日が1つも指定されていません。');
  return mask;
}

export function describeDays(mask: number): string {
  if (mask === EVERY_DAY) return '毎日';
  if (mask === WEEKDAYS) return '平日';
  if (mask === WEEKENDS) return '土日';
  // 月曜始まりで並べる
  return [1, 2, 3, 4, 5, 6, 0]
    .filter((d) => mask & (1 << d))
    .map((d) => WEEKDAY_JA[d])
    .join('');
}

export function isScheduled(mask: number, key: string): boolean {
  return (mask & (1 << weekdayOf(key))) !== 0;
}

// --------------------------------------------------------------- 次回

/** now より後で、予定曜日に当たる最初の check_minute */
export function nextPromptAt(
  now: number,
  checkMinute: number,
  mask: number,
  timeZone: string,
): { at: number; date: string } {
  const today = dateKeyOf(now, timeZone);
  for (let i = 0; i <= 7; i++) {
    const date = addDays(today, i);
    if (!isScheduled(mask, date)) continue;
    const at = epochOf(date, checkMinute, timeZone);
    if (at > now) return { at, date };
  }
  // mask が 0 でない限り到達しない
  throw new HabitInputError('次の予定日を計算できませんでした。');
}

/** 期間 [from, to] の日付を列挙する */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// --------------------------------------------------------------- 日付入力

/** "2026-12-31" / "12/31" / "明日" / "今日" / "+3"（3日後）/ "30d" -> 日付。年なしは今日以降で最も近い日 */
export function parseDateInput(input: string, today: string): string {
  const s = input
    .trim()
    .replace(/[０-９／－]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (s === '今日' || s === 'today') return today;
  if (s === '明日' || s === 'tomorrow') return addDays(today, 1);
  if (s === '明後日') return addDays(today, 2);

  const relative = s.match(/^\+?(\d{1,4})\s*(?:d|日後?)$/) ?? s.match(/^\+(\d{1,4})$/);
  if (relative) return addDays(today, Number(relative[1]));

  const full = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  const short = s.match(/^(\d{1,2})[-/](\d{1,2})$/);
  let year: number;
  let month: number;
  let day: number;
  if (full) {
    year = Number(full[1]);
    month = Number(full[2]);
    day = Number(full[3]);
  } else if (short) {
    year = Number(today.slice(0, 4));
    month = Number(short[1]);
    day = Number(short[2]);
  } else {
    throw new HabitInputError(
      `日付を解釈できません: \`${input}\`（例: 2026-12-31 / 12/31 / 明日 / 30d）`,
    );
  }

  const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (addDays(key, 0) !== key) throw new HabitInputError(`存在しない日付です: \`${input}\``);
  if (short && key < today) return `${year + 1}${key.slice(4)}`;
  return key;
}
