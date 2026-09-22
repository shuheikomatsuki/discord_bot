import { describe, expect, it } from 'vitest';
import { formatZoned, fromZonedParts, toZonedParts } from '../src/core/time';
import {
  advanceSchedule,
  nextCronFire,
  parseAt,
  parseCron,
  parseDuration,
  parseInterval,
  ScheduleError,
} from '../src/features/reminder/schedule';

const TZ = 'Asia/Tokyo';

describe('parseDuration', () => {
  it('単位つきの指定を秒に変換する', () => {
    expect(parseDuration('10m')).toBe(600);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('1d')).toBe(86400);
    expect(parseDuration('1w')).toBe(604800);
    expect(parseDuration('1h30m')).toBe(5400);
  });

  it('単位なしの数値は分として扱う', () => {
    expect(parseDuration('30')).toBe(1800);
  });

  it('解釈できない入力は null', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('1h x')).toBeNull();
    expect(parseDuration('1y')).toBeNull();
  });
});

describe('parseInterval', () => {
  it('1分未満は拒否する（cron が毎分なので実現できない）', () => {
    expect(() => parseInterval('30s')).toThrow(ScheduleError);
  });

  it('1年を超える指定は拒否する', () => {
    expect(() => parseInterval('400d')).toThrow(ScheduleError);
  });
});

describe('parseAt', () => {
  // 2026-09-22 12:00 JST
  const now = fromZonedParts({ year: 2026, month: 9, day: 22, hour: 12, minute: 0 }, TZ);

  it('相対指定は現在時刻からの加算になる', () => {
    expect(parseAt('30m', TZ, now)).toBe(now + 1800);
    expect(parseAt('2h', TZ, now)).toBe(now + 7200);
  });

  it('時刻のみの指定は、今日それが未来ならその時刻になる', () => {
    expect(formatZoned(parseAt('18:30', TZ, now), TZ)).toBe('2026-09-22 18:30');
  });

  it('時刻のみの指定が過去なら翌日になる', () => {
    expect(formatZoned(parseAt('09:00', TZ, now), TZ)).toBe('2026-09-23 09:00');
  });

  it('日付つきの指定を解釈する', () => {
    expect(formatZoned(parseAt('2026-10-01 09:00', TZ, now), TZ)).toBe('2026-10-01 09:00');
    expect(formatZoned(parseAt('10/01 09:00', TZ, now), TZ)).toBe('2026-10-01 09:00');
  });

  it('年を省略した指定が過去なら翌年になる', () => {
    expect(formatZoned(parseAt('01/05 09:00', TZ, now), TZ)).toBe('2027-01-05 09:00');
  });

  it('存在しない日付や不正な時刻は拒否する', () => {
    expect(() => parseAt('2026-02-30 09:00', TZ, now)).toThrow(ScheduleError);
    expect(() => parseAt('25:00', TZ, now)).toThrow(ScheduleError);
    expect(() => parseAt('よろしく', TZ, now)).toThrow(ScheduleError);
  });
});

describe('parseCron', () => {
  it('5フィールド以外は拒否する', () => {
    expect(() => parseCron('0 9 * *')).toThrow(ScheduleError);
    expect(() => parseCron('0 9 * * * *')).toThrow(ScheduleError);
  });

  it('範囲・リスト・ステップを展開する', () => {
    const expr = parseCron('0,30 9-11 * * 1-5');
    expect(expr.minutes).toEqual([0, 30]);
    expect(expr.hours).toEqual([9, 10, 11]);
    expect(expr.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('*/n を展開する', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45]);
  });

  it('範囲外を拒否する', () => {
    expect(() => parseCron('60 * * * *')).toThrow(ScheduleError);
    expect(() => parseCron('* 24 * * *')).toThrow(ScheduleError);
  });

  it('曜日の 7 は日曜(0)として扱う', () => {
    expect(parseCron('0 9 * * 7').daysOfWeek).toEqual([0]);
  });
});

describe('nextCronFire', () => {
  const base = fromZonedParts({ year: 2026, month: 9, day: 22, hour: 12, minute: 0 }, TZ);

  it('毎週月曜9時は、次の月曜の JST 9時になる', () => {
    const at = nextCronFire(parseCron('0 9 * * 1'), TZ, base);
    expect(at).not.toBeNull();
    const parts = toZonedParts(at as number, TZ);
    expect(parts.weekday).toBe(1);
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    expect(at as number).toBeGreaterThan(base);
  });

  it('毎月1日9時は、翌月1日の JST 9時になる', () => {
    const at = nextCronFire(parseCron('0 9 1 * *'), TZ, base);
    expect(formatZoned(at as number, TZ)).toBe('2026-10-01 09:00');
  });

  it('UTC ではなく指定タイムゾーンで解釈する', () => {
    const jst = nextCronFire(parseCron('0 9 * * *'), TZ, base) as number;
    const utc = nextCronFire(parseCron('0 9 * * *'), 'UTC', base) as number;
    expect(jst).not.toBe(utc);
    expect(toZonedParts(jst, TZ).hour).toBe(9);
    expect(toZonedParts(utc, 'UTC').hour).toBe(9);
  });
});

describe('advanceSchedule', () => {
  const spec = { kind: 'interval' as const, expr: '3600', timeZone: TZ };

  it('1回限りは次回を持たない', () => {
    expect(advanceSchedule({ kind: 'once', expr: '123', timeZone: TZ }, 123, 200)).toEqual({
      next: null,
      skipped: 0,
    });
  });

  it('通常は1周期ぶん進む', () => {
    const firedAt = 1_000_000;
    expect(advanceSchedule(spec, firedAt, firedAt + 10)).toEqual({
      next: firedAt + 3600,
      skipped: 0,
    });
  });

  it('停止していた間の取りこぼしは送らずに飛ばす', () => {
    const firedAt = 1_000_000;
    // 6時間後に復旧した場合、連投せず次の1回だけを予定する
    const result = advanceSchedule(spec, firedAt, firedAt + 6 * 3600 + 1);
    expect(result.skipped).toBe(6);
    expect(result.next).toBeGreaterThan(firedAt + 6 * 3600 + 1);
    expect(result.next).toBe(firedAt + 7 * 3600);
  });

  it('cron でも現在時刻より後まで進む', () => {
    const cronSpec = { kind: 'cron' as const, expr: '0 9 * * *', timeZone: TZ };
    const firedAt = fromZonedParts({ year: 2026, month: 9, day: 22, hour: 9, minute: 0 }, TZ);
    const now = fromZonedParts({ year: 2026, month: 9, day: 25, hour: 12, minute: 0 }, TZ);
    const result = advanceSchedule(cronSpec, firedAt, now);
    expect(formatZoned(result.next as number, TZ)).toBe('2026-09-26 09:00');
    expect(result.skipped).toBe(3);
  });
});
