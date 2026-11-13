/**
 * 連続記録の計算（純粋関数）。
 *
 * - done   … 連続記録が +1
 * - frozen … 数は増えないが途切れもしない（フリーズ）
 * - missed … ここで途切れる
 * - pending … まだ回答待ち（今日の分など）。判定を保留して読み飛ばす
 * - 行が無い日（予定外の曜日・作成前）は数えない
 */
export type CheckinStatus = 'pending' | 'done' | 'missed' | 'frozen';

export interface DayRecord {
  date: string;
  status: CheckinStatus;
}

export interface StreakResult {
  current: number;
  best: number;
  totalDone: number;
}

export function computeStreak(records: DayRecord[]): StreakResult {
  const sorted = [...records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let run = 0;
  let best = 0;
  let totalDone = 0;
  for (const r of sorted) {
    switch (r.status) {
      case 'done':
        run += 1;
        totalDone += 1;
        best = Math.max(best, run);
        break;
      case 'missed':
        run = 0;
        break;
      case 'frozen':
      case 'pending':
        break;
    }
  }
  return { current: run, best, totalDone };
}

/** 期間内の達成率。分母は予定日として行がある日（pending は除く、frozen も除く） */
export function achievementRate(records: DayRecord[]): {
  done: number;
  missed: number;
  frozen: number;
  rate: number | null;
} {
  let done = 0;
  let missed = 0;
  let frozen = 0;
  for (const r of records) {
    if (r.status === 'done') done += 1;
    else if (r.status === 'missed') missed += 1;
    else if (r.status === 'frozen') frozen += 1;
  }
  const denominator = done + missed;
  return { done, missed, frozen, rate: denominator === 0 ? null : done / denominator };
}
