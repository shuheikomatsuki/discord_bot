/**
 * 週次・月次のまとめ。cron の自動送信と /stats の両方から使う。
 */
import type { APIEmbed } from 'discord-api-types/v10';
import type { Env } from '../../env';
import {
  addDays,
  daysInMonth,
  epochOf,
  formatDateJa,
  monthKeyOf,
  monthStartOf,
  weekStartOf,
} from './dates';
import { levelInfo } from './gamification';
import {
  calendarGrid,
  formatNumber,
  goalLine,
  indexByDate,
  LEGEND,
  levelLine,
  percent,
  progressBar,
  weekRow,
} from './render';
import type { SummaryKind } from './repository';
import * as repo from './repository';
import { achievementRate } from './streak';

export interface Period {
  kind: SummaryKind;
  /** 週: 月曜の日付 / 月: 'YYYY-MM' */
  key: string;
  from: string;
  to: string;
}

export function weekPeriod(anyDay: string): Period {
  const from = weekStartOf(anyDay);
  return { kind: 'week', key: from, from, to: addDays(from, 6) };
}

export function monthPeriod(anyDay: string): Period {
  const key = monthKeyOf(anyDay);
  const from = monthStartOf(anyDay);
  return { kind: 'month', key, from, to: `${key}-${String(daysInMonth(key)).padStart(2, '0')}` };
}

export function previousPeriod(p: Period): Period {
  return p.kind === 'week' ? weekPeriod(addDays(p.from, -1)) : monthPeriod(addDays(p.from, -1));
}

export function periodTitle(p: Period): string {
  return p.kind === 'week'
    ? `週次まとめ ${formatDateJa(p.from)}〜${formatDateJa(p.to)}`
    : `月次まとめ ${Number(p.key.slice(0, 4))}年${Number(p.key.slice(5, 7))}月`;
}

export interface Report {
  embed: APIEmbed;
  /** その期間に何も記録が無い */
  empty: boolean;
  /** 予定（3回以上）をすべて達成した */
  perfect: boolean;
}

/** 量を記録する習慣の、期間内の合計と1回あたりの平均 */
export function amountSummary(
  unit: string | null,
  records: { status: string; amount: number | null }[],
): string {
  if (!unit) return '';
  const amounts = records
    .filter((r) => r.status === 'done' && r.amount !== null)
    .map((r) => r.amount as number);
  if (amounts.length === 0) return '';
  const total = amounts.reduce((a, b) => a + b, 0);
  return `\n　📏 合計 ${formatNumber(total)}${unit}（平均 ${formatNumber(total / amounts.length)}${unit}/回）`;
}

export async function buildReport(
  env: Env,
  guildId: string,
  userId: string,
  period: Period,
  today: string,
): Promise<Report> {
  const db = env.DB;
  const timeZone = env.DEFAULT_TIMEZONE || 'Asia/Tokyo';
  const prev = previousPeriod(period);

  const [habits, records, prevRecords, goals, profile, goalAct] = await Promise.all([
    repo.listHabits(db, guildId, userId),
    repo.userRecords(db, guildId, userId, period.from, period.to),
    repo.userRecords(db, guildId, userId, prev.from, prev.to),
    repo.listGoals(db, guildId, userId, false),
    repo.getProfile(db, guildId, userId),
    repo.goalActivity(db, guildId, userId, {
      from: period.from,
      to: period.to,
      fromEpoch: epochOf(period.from, 0, timeZone),
      toEpoch: epochOf(addDays(period.to, 1), 0, timeZone),
    }),
  ]);

  const overall = achievementRate(records);
  const prevOverall = achievementRate(prevRecords);
  const lines: string[] = [];

  // ---- 全体
  let diff = '';
  if (overall.rate !== null && prevOverall.rate !== null) {
    const pt = Math.round((overall.rate - prevOverall.rate) * 100);
    diff = pt === 0 ? '（前回と同じ）' : `（前回比 ${pt > 0 ? '+' : ''}${pt}pt）`;
  }
  lines.push(
    `**達成率 ${percent(overall.rate)}** ${diff}`,
    `${progressBar(overall.rate ?? 0)} 達成 ${overall.done} / 未達 ${overall.missed} / フリーズ ${overall.frozen}`,
  );

  // ---- カレンダー
  const index = indexByDate(records);
  lines.push('');
  if (period.kind === 'week') {
    lines.push(`月火水木金土日\n${weekRow(index, period.from, today)}`);
  } else {
    lines.push(calendarGrid(index, period.from, period.to, today));
  }

  // ---- 習慣ごと
  const byHabit = new Map<string, typeof records>();
  for (const r of records) {
    const list = byHabit.get(r.habitId) ?? [];
    list.push(r);
    byHabit.set(r.habitId, list);
  }
  const shown = habits.filter((h) => h.status === 'active' || byHabit.has(h.id));
  if (shown.length > 0) {
    lines.push('', '**習慣**');
    for (const h of shown) {
      const own = byHabit.get(h.id) ?? [];
      const rate = achievementRate(own);
      const row =
        period.kind === 'week' ? `\n　${weekRow(indexByDate(own), period.from, today)}` : '';
      lines.push(
        `**${h.name}** ${percent(rate.rate)}（${rate.done}/${rate.done + rate.missed}）🔥${h.currentStreak}${amountSummary(h.unit, own)}${row}`,
      );
    }
  }

  // ---- 目標
  if (goals.length > 0 || goalAct.completed > 0) {
    lines.push('', `**目標** 記録 ${goalAct.logs}回 · 達成 ${goalAct.completed}個`);
    for (const g of goals.slice(0, 5)) lines.push(goalLine(g));
  }

  // ---- レベル
  if (profile) {
    lines.push('', `${levelLine(levelInfo(profile.xp), profile.xp)} · 🧊×${profile.freezes}`);
  }

  lines.push('', `-# ${LEGEND}`);

  return {
    embed: {
      title: `📊 ${periodTitle(period)}`,
      description: lines.join('\n').slice(0, 4096),
      color: 0x57f287,
    },
    empty: records.length === 0 && goalAct.logs === 0,
    perfect:
      overall.done >= 3 && overall.missed === 0 && overall.done + overall.frozen === records.length,
  };
}
