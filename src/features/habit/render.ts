/**
 * 表示の組み立て（純粋関数）。Workers では画像を作りにくいので、可視化は絵文字で行う。
 */
import { addDays, describeDays, eachDay, formatDateJa, formatMinute, weekStartOf } from './dates';
import { badgeLabel, type LevelInfo } from './gamification';
import { type Goal, type GoalLog, goalProgress, type Habit } from './schema';
import type { CheckinStatus } from './streak';

export const CELL = {
  done: '🟩',
  partial: '🟨',
  missed: '🟥',
  frozen: '🧊',
  pending: '🟦',
  none: '⬜',
  future: '⬛',
} as const;

export const LEGEND = `${CELL.done}達成 ${CELL.partial}一部 ${CELL.missed}未達 ${CELL.frozen}フリーズ ${CELL.pending}回答待ち ${CELL.none}予定なし`;

/** 1日分のセル。複数習慣をまとめて表示するときは集計した色にする */
export function dayCell(statuses: CheckinStatus[], isFuture: boolean): string {
  if (isFuture) return CELL.future;
  if (statuses.length === 0) return CELL.none;
  const done = statuses.filter((s) => s === 'done').length;
  const frozen = statuses.filter((s) => s === 'frozen').length;
  const pending = statuses.filter((s) => s === 'pending').length;
  if (done > 0 && done + frozen === statuses.length) return CELL.done;
  if (frozen === statuses.length) return CELL.frozen;
  if (done > 0) return CELL.partial;
  if (pending > 0) return CELL.pending;
  return CELL.missed;
}

export type DayIndex = Map<string, CheckinStatus[]>;

export function indexByDate(records: { date: string; status: CheckinStatus }[]): DayIndex {
  const index: DayIndex = new Map();
  for (const r of records) {
    const list = index.get(r.date) ?? [];
    list.push(r.status);
    index.set(r.date, list);
  }
  return index;
}

/** 1行（7マス）。週次のまとめ用 */
export function weekRow(index: DayIndex, weekStart: string, today: string): string {
  return eachDay(weekStart, addDays(weekStart, 6))
    .map((d) => dayCell(index.get(d) ?? [], d > today))
    .join('');
}

/**
 * 月曜始まりのカレンダー。[from, to] を含む週をすべて描く。
 * 範囲外の日は空白にして、どこからどこまでの期間かが分かるようにする。
 */
export function calendarGrid(index: DayIndex, from: string, to: string, today: string): string {
  const lines = ['月 火 水 木 金 土 日'.split(' ').join('　')];
  for (let week = weekStartOf(from); week <= to; week = addDays(week, 7)) {
    lines.push(
      eachDay(week, addDays(week, 6))
        .map((d) => (d < from || d > to ? '　' : dayCell(index.get(d) ?? [], d > today)))
        .join(''),
    );
  }
  return lines.join('\n');
}

export function progressBar(ratio: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function percent(ratio: number | null): string {
  return ratio === null ? '—' : `${Math.round(ratio * 100)}%`;
}

const SPARK = '▁▂▃▄▅▆▇█';

/** 数値の推移を1行で */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  return values
    .map((v) => SPARK[span === 0 ? 3 : Math.round(((v - min) / span) * (SPARK.length - 1))])
    .join('');
}

export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function shortHabitId(id: string): string {
  return id.slice(-6);
}

// --------------------------------------------------------------- 習慣

export function habitSchedule(h: Habit): string {
  return `${describeDays(h.daysMask)} ${formatMinute(h.checkMinute)}`;
}

/** 量の表示。単位なしの習慣では null */
export function amountText(h: Habit, amount: number | null): string | null {
  if (!h.unit || amount === null) return null;
  const target =
    h.dailyTarget !== null
      ? `（目安 ${formatNumber(h.dailyTarget)}${h.unit}${amount >= h.dailyTarget ? ' 🎯' : ''}）`
      : '';
  return `📏 ${formatNumber(amount)}${h.unit}${target}`;
}

/** 再通知が実際に働く設定か（チェックインより後の時刻であること） */
export function remindActive(h: Habit): boolean {
  return h.remindMinute !== null && h.remindMinute > h.checkMinute;
}

export function habitLine(h: Habit): string {
  const paused = h.status === 'paused' ? ' ⏸️停止中' : '';
  // 投稿に失敗して止まった理由を本人に見せる（権限不足など、本人が直せるもの）
  const error =
    h.status === 'paused' && h.lastError
      ? `\n　⚠️ 投稿に失敗して停止しました: ${h.lastError.slice(0, 150)}`
      : '';
  const extras: string[] = [];
  if (remindActive(h) && h.remindMinute !== null)
    extras.push(`🔔 未回答なら ${formatMinute(h.remindMinute)} に再通知`);
  if (h.unit) {
    extras.push(
      `📏 量を記録（${h.unit}${h.dailyTarget !== null ? `・目安 ${formatNumber(h.dailyTarget)}${h.unit}` : ''}）`,
    );
  }
  const extra = extras.length > 0 ? `\n　${extras.join(' · ')}` : '';
  return `\`${shortHabitId(h.id)}\` **${h.name}** — ${habitSchedule(h)} <#${h.channelId}>${paused}\n　🔥 ${h.currentStreak}日連続（最高 ${h.bestStreak}日）・累計 ${h.totalDone}回${extra}${error}`;
}

export function habitAutocompleteLabel(h: Habit): string {
  const label = `${shortHabitId(h.id)} | ${h.name} | ${habitSchedule(h)}${h.status === 'paused' ? ' | 停止中' : ''}`;
  return label.slice(0, 100);
}

// --------------------------------------------------------------- チェックイン

export const STATUS_TEXT: Record<CheckinStatus, string> = {
  pending: '🟦 回答待ち',
  done: '✅ 達成！',
  missed: '❌ できなかった',
  frozen: '🧊 フリーズ（記録は途切れません）',
};

export function promptContent(h: Habit, date: string): string {
  const streak = h.currentStreak > 0 ? `\n🔥 いま ${h.currentStreak}日連続` : '';
  return `<@${h.userId}> ⏰ **${h.name}** の時間です（${formatDateJa(date)}）\n今日はできましたか？${streak}`;
}

/** 未回答のまま再通知の時刻になったとき、元の投稿に返信する文面 */
export function reminderContent(h: Habit): string {
  return `<@${h.userId}> 🔔 **${h.name}** がまだ未回答です。上のボタンから記録してください（受付は 0:00 まで）${h.currentStreak > 0 ? `\n🔥 ${h.currentStreak}日連続がかかっています` : ''}`;
}

export interface AnswerSummary {
  streak: number;
  xpGained: number;
  leveledUpTo: number | null;
  newBadges: string[];
  freezeEarned: boolean;
  freezesLeft: number;
}

export function answeredContent(
  h: Habit,
  date: string,
  status: CheckinStatus,
  note: string | null,
  summary: AnswerSummary | null,
  closed: boolean,
  amount: number | null = null,
): string {
  const lines = [`<@${h.userId}> **${h.name}**（${formatDateJa(date)}）`, STATUS_TEXT[status]];
  const measured = status === 'done' ? amountText(h, amount) : null;
  if (measured) lines.push(measured);
  if (note) lines.push(`> ${note.replace(/\n/g, '\n> ')}`);
  if (summary) {
    const parts = [`🔥 ${summary.streak}日連続`];
    if (summary.xpGained > 0) parts.push(`+${summary.xpGained}XP`);
    lines.push(parts.join(' · '));
    if (summary.leveledUpTo !== null) lines.push(`⬆️ レベル${summary.leveledUpTo} になりました！`);
    if (summary.freezeEarned) lines.push(`🧊 フリーズを1個獲得（在庫 ${summary.freezesLeft}）`);
    if (summary.newBadges.length > 0) {
      lines.push(`🎖️ 新しいバッジ: ${summary.newBadges.map(badgeLabel).join(' / ')}`);
    }
  }
  if (closed) lines.push('-# この日の受付は締め切りました');
  else lines.push('-# 今日中なら押し直して変更できます');
  return lines.join('\n');
}

// --------------------------------------------------------------- 目標

export function goalLine(g: Goal): string {
  const done = g.status === 'completed' ? '🏁 ' : '';
  const deadline = g.deadline ? ` · 期限 ${formatDateJa(g.deadline)}` : '';
  if (g.targetValue === null) {
    return `\`${shortHabitId(g.id)}\` ${done}**${g.name}**${deadline}`;
  }
  const ratio = goalProgress(g);
  return `\`${shortHabitId(g.id)}\` ${done}**${g.name}**${deadline}\n　${progressBar(ratio)} ${percent(ratio)}（${formatNumber(g.current)} / ${formatNumber(g.targetValue)}${g.unit}）`;
}

export function goalDetail(g: Goal, logs: GoalLog[], today: string): string {
  const lines = [goalLine(g)];
  if (g.deadline && g.status === 'active') {
    const left = Math.round(
      (Date.parse(`${g.deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
    );
    lines.push(left >= 0 ? `⏳ 期限まであと ${left}日` : `⚠️ 期限を ${-left}日過ぎています`);
  }
  if (g.targetValue !== null) {
    lines.push(
      `開始値 ${formatNumber(g.startValue)}${g.unit} → 目標 ${formatNumber(g.targetValue)}${g.unit}`,
    );
  }
  if (logs.length > 0) {
    lines.push(
      '',
      `📈 推移 ${sparkline([g.startValue, ...logs.map((l) => l.after)])}`,
      '',
      '**最近の記録**',
    );
    for (const l of logs.slice(-10).reverse()) {
      const change = l.mode === 'add' ? `+${formatNumber(l.value)}` : `=${formatNumber(l.value)}`;
      const note = l.note ? ` — ${l.note.slice(0, 80)}` : '';
      lines.push(
        `${formatDateJa(l.date)} ${change}${g.unit} → ${formatNumber(l.after)}${g.unit}${note}`,
      );
    }
  }
  return lines.join('\n');
}

export function goalAutocompleteLabel(g: Goal): string {
  return `${shortHabitId(g.id)} | ${g.name}${g.status === 'completed' ? ' | 達成済み' : ''}`.slice(
    0,
    100,
  );
}

// --------------------------------------------------------------- プロフィール

export function levelLine(info: LevelInfo, xp: number): string {
  return `Lv.${info.level} ${progressBar(info.into / info.span)} ${xp}XP（次まで ${info.span - info.into}XP）`;
}
