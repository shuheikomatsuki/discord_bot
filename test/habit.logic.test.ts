import { describe, expect, it } from 'vitest';
import { fromZonedParts } from '../src/core/time';
import { duePeriods } from '../src/features/habit/cron';
import {
  addDays,
  dateKeyOf,
  defaultRemindMinute,
  describeDays,
  EVERY_DAY,
  HabitInputError,
  nextPromptAt,
  parseAmount,
  parseDateInput,
  parseDays,
  parseRemindTime,
  parseTimeOfDay,
  weekStartOf,
} from '../src/features/habit/dates';
import {
  levelInfo,
  newlyEarnedBadges,
  streakBonus,
  xpForLevel,
} from '../src/features/habit/gamification';
import {
  CELL,
  calendarGrid,
  dayCell,
  indexByDate,
  progressBar,
  sparkline,
} from '../src/features/habit/render';
import {
  amountSummary,
  monthPeriod,
  previousPeriod,
  weekPeriod,
} from '../src/features/habit/report';
import { type Goal, goalProgress, goalReached } from '../src/features/habit/schema';
import { achievementRate, computeStreak } from '../src/features/habit/streak';

const TZ = 'Asia/Tokyo';
const jst = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  fromZonedParts({ year: y, month: mo, day: d, hour: h, minute: mi }, TZ);

describe('dates', () => {
  it('時刻をいろいろな書き方で読める', () => {
    expect(parseTimeOfDay('21:00')).toBe(1260);
    expect(parseTimeOfDay('7:05')).toBe(425);
    expect(parseTimeOfDay('２１：３０')).toBe(1290);
    expect(parseTimeOfDay('21時')).toBe(1260);
    expect(parseTimeOfDay('6時30分')).toBe(390);
    expect(parseTimeOfDay('0730')).toBe(450);
    expect(() => parseTimeOfDay('25:00')).toThrow(HabitInputError);
    expect(() => parseTimeOfDay('夜')).toThrow(HabitInputError);
  });

  it('曜日を読める', () => {
    expect(parseDays(undefined)).toBe(EVERY_DAY);
    expect(parseDays('毎日')).toBe(EVERY_DAY);
    expect(describeDays(parseDays('平日'))).toBe('平日');
    expect(describeDays(parseDays('土日'))).toBe('土日');
    expect(describeDays(parseDays('月水金'))).toBe('月水金');
    expect(describeDays(parseDays('mon, wed, fri'))).toBe('月水金');
    expect(describeDays(parseDays('日曜 土曜'))).toBe('土日');
    expect(() => parseDays('あいう')).toThrow(HabitInputError);
  });

  it('日付の計算', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekStartOf('2026-11-15')).toBe('2026-11-09'); // 日曜 -> その週の月曜
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09');
    // 1日の区切りは JST の深夜0時
    expect(dateKeyOf(jst(2026, 11, 13, 23, 59), TZ)).toBe('2026-11-13');
    expect(dateKeyOf(jst(2026, 11, 14, 0, 0), TZ)).toBe('2026-11-14');
  });

  it('次のチェックイン時刻', () => {
    // 2026-11-13 は金曜
    const fri20 = jst(2026, 11, 13, 20, 0);
    expect(nextPromptAt(fri20, 1260, EVERY_DAY, TZ)).toEqual({
      at: jst(2026, 11, 13, 21),
      date: '2026-11-13',
    });
    const fri22 = jst(2026, 11, 13, 22, 0);
    expect(nextPromptAt(fri22, 1260, EVERY_DAY, TZ).date).toBe('2026-11-14');
    // 平日のみなら金曜夜の次は月曜
    expect(nextPromptAt(fri22, 1260, parseDays('平日'), TZ).date).toBe('2026-11-16');
    // ちょうどの時刻は「次」ではない
    expect(nextPromptAt(jst(2026, 11, 13, 21), 1260, EVERY_DAY, TZ).date).toBe('2026-11-14');
  });

  it('日付の入力', () => {
    const today = '2026-11-13';
    expect(parseDateInput('今日', today)).toBe(today);
    expect(parseDateInput('明日', today)).toBe('2026-11-14');
    expect(parseDateInput('30d', today)).toBe('2026-12-13');
    expect(parseDateInput('12/24', today)).toBe('2026-12-24');
    expect(parseDateInput('3/31', today)).toBe('2027-03-31'); // 過ぎていれば来年
    expect(parseDateInput('2027-01-05', today)).toBe('2027-01-05');
    expect(() => parseDateInput('2026-02-30', today)).toThrow(HabitInputError);
    expect(() => parseDateInput('そのうち', today)).toThrow(HabitInputError);
  });
});

describe('streak', () => {
  it('done で伸び、frozen で保たれ、missed で切れる', () => {
    const r = computeStreak([
      { date: '2026-11-01', status: 'done' },
      { date: '2026-11-02', status: 'done' },
      { date: '2026-11-03', status: 'done' },
      { date: '2026-11-04', status: 'missed' },
      { date: '2026-11-05', status: 'done' },
      { date: '2026-11-06', status: 'frozen' },
      { date: '2026-11-07', status: 'done' },
      { date: '2026-11-08', status: 'pending' },
    ]);
    expect(r).toEqual({ current: 2, best: 3, totalDone: 5 });
  });

  it('並び順に依存しない', () => {
    const r = computeStreak([
      { date: '2026-11-03', status: 'done' },
      { date: '2026-11-01', status: 'missed' },
      { date: '2026-11-02', status: 'done' },
    ]);
    expect(r.current).toBe(2);
  });

  it('達成率はフリーズと回答待ちを分母に含めない', () => {
    expect(
      achievementRate([
        { date: 'a', status: 'done' },
        { date: 'b', status: 'missed' },
        { date: 'c', status: 'frozen' },
        { date: 'd', status: 'pending' },
      ]),
    ).toEqual({ done: 1, missed: 1, frozen: 1, rate: 0.5 });
    expect(achievementRate([]).rate).toBeNull();
  });
});

describe('gamification', () => {
  it('レベルは XP の平方根で上がる', () => {
    expect(levelInfo(0)).toEqual({ level: 1, into: 0, span: 25 });
    expect(levelInfo(24).level).toBe(1);
    expect(levelInfo(25).level).toBe(2);
    expect(levelInfo(100).level).toBe(3);
    expect(levelInfo(xpForLevel(10)).level).toBe(10);
  });

  it('節目のボーナス', () => {
    expect(streakBonus(1)).toBe(0);
    expect(streakBonus(7)).toBe(20);
    expect(streakBonus(30)).toBe(50);
    expect(streakBonus(28)).toBe(20);
  });

  it('持っていないバッジだけ返す', () => {
    expect(newlyEarnedBadges({ streak: 7, totalDone: 7 }, ['first_step'])).toEqual([
      'streak_3',
      'streak_7',
    ]);
    expect(newlyEarnedBadges({ perfectWeek: true }, [])).toEqual(['perfect_week']);
    expect(newlyEarnedBadges({}, [])).toEqual([]);
  });
});

describe('render', () => {
  it('1日のセル', () => {
    expect(dayCell([], false)).toBe(CELL.none);
    expect(dayCell(['done'], true)).toBe(CELL.future);
    expect(dayCell(['done', 'frozen'], false)).toBe(CELL.done);
    expect(dayCell(['done', 'missed'], false)).toBe(CELL.partial);
    expect(dayCell(['frozen'], false)).toBe(CELL.frozen);
    expect(dayCell(['pending'], false)).toBe(CELL.pending);
    expect(dayCell(['missed'], false)).toBe(CELL.missed);
  });

  it('月のカレンダーは月曜始まりで週ごとに7マス', () => {
    const index = indexByDate([{ date: '2026-11-02', status: 'done' }]);
    const grid = calendarGrid(index, '2026-11-01', '2026-11-30', '2026-11-13').split('\n');
    // 見出し + 6週（11/1 は日曜なので 10/26 の週から 11/30 の週まで）
    expect(grid).toHaveLength(7);
    expect([...(grid[1] ?? '')].filter((ch) => ch !== '　')).toHaveLength(1); // 11/1 だけ
    expect(grid[2]?.startsWith(CELL.done)).toBe(true); // 11/2(月)
  });

  it('バーと推移', () => {
    expect(progressBar(0.5, 4)).toBe('▰▰▱▱');
    expect(progressBar(2, 3)).toBe('▰▰▰');
    expect(sparkline([1, 2, 3])).toBe('▁▅█');
    expect(sparkline([5, 5])).toBe('▄▄');
  });
});

describe('goal', () => {
  const base: Goal = {
    id: 'x',
    guildId: 'g',
    userId: 'u',
    name: 'n',
    unit: 'kg',
    startValue: 70,
    targetValue: 65,
    current: 70,
    deadline: null,
    status: 'active',
    completedAt: null,
    createdAt: 0,
  };

  it('減らす目標にも対応する', () => {
    expect(goalReached({ ...base, current: 66 })).toBe(false);
    expect(goalReached({ ...base, current: 65 })).toBe(true);
    expect(goalProgress({ ...base, current: 67.5 })).toBe(0.5);
  });

  it('増やす目標', () => {
    const g = { ...base, startValue: 0, targetValue: 800, current: 800 };
    expect(goalReached(g)).toBe(true);
    expect(goalProgress({ ...g, current: 1000 })).toBe(1);
  });
});

describe('periods', () => {
  it('週と月の範囲', () => {
    expect(weekPeriod('2026-11-13')).toEqual({
      kind: 'week',
      key: '2026-11-09',
      from: '2026-11-09',
      to: '2026-11-15',
    });
    expect(monthPeriod('2026-02-10')).toEqual({
      kind: 'month',
      key: '2026-02',
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(previousPeriod(monthPeriod('2026-01-10')).key).toBe('2025-12');
  });

  it('まとめは月曜9時以降に先週分、1日9時以降に先月分', () => {
    // 2026-11-16 は月曜
    const mon8 = jst(2026, 11, 16, 8, 59);
    expect(duePeriods(mon8, TZ, '2026-11-16').map((p) => p.key)).toEqual(['2026-10']);
    const mon9 = jst(2026, 11, 16, 9, 0);
    expect(duePeriods(mon9, TZ, '2026-11-16').map((p) => p.key)).toEqual(['2026-11-09', '2026-10']);
    // 12/1 の 8時は先月(11月)分はまだ
    const dec1 = jst(2026, 12, 1, 8, 0);
    expect(duePeriods(dec1, TZ, '2026-12-01').map((p) => p.key)).toEqual(['2026-11-23']);
  });
});

describe('再通知・量の入力', () => {
  it('parseRemindTime', () => {
    expect(parseRemindTime('23:00')).toBe(1380);
    expect(parseRemindTime('なし')).toBeNull();
    expect(parseRemindTime('off')).toBeNull();
    expect(() => parseRemindTime('あとで')).toThrow();
  });

  it('defaultRemindMinute は23時より前の習慣だけ', () => {
    expect(defaultRemindMinute(21 * 60)).toBe(1380);
    expect(defaultRemindMinute(23 * 60)).toBeNull();
    expect(defaultRemindMinute(23 * 60 + 30)).toBeNull();
  });

  it('parseAmount', () => {
    expect(parseAmount('30')).toBe(30);
    expect(parseAmount('１．５')).toBe(1.5);
    expect(parseAmount('2,000')).toBe(2000);
    expect(parseAmount('30分')).toBe(30);
    expect(parseAmount('5 km')).toBe(5);
    expect(() => parseAmount('たくさん')).toThrow();
    expect(() => parseAmount('-3')).toThrow();
    expect(() => parseAmount('3a0')).toThrow();
  });

  it('amountSummary', () => {
    expect(amountSummary(null, [{ status: 'done', amount: 3 }])).toBe('');
    expect(amountSummary('分', [{ status: 'missed', amount: null }])).toBe('');
    expect(
      amountSummary('km', [
        { status: 'done', amount: 3 },
        { status: 'done', amount: 4.5 },
        { status: 'done', amount: null },
      ]),
    ).toContain('合計 7.5km（平均 3.75km/回）');
  });
});
