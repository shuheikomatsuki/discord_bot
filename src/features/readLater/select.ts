/** 今日紹介する記事を選ぶ純粋関数。D1 に依存しないのでテストしやすい */

const DAY = 24 * 60 * 60;

export interface Candidate {
  id: string;
  savedAt: number;
  notifyCount: number;
}

/**
 * 重み付きランダムで count 件を選ぶ（重複なし）。
 * - まだ一度も紹介していない記事を優先（×3）
 * - 保存してから時間が経っているほど少しずつ優先（30日で +1）
 * - 何度も流された記事は少しずつ出にくくする
 * 完全に古い順だと「毎日同じ顔ぶれ」になりがちなので、ランダム性を残している。
 */
export function pickItems<T extends Candidate>(
  candidates: T[],
  count: number,
  now: number,
  random: () => number = Math.random,
): T[] {
  const pool = candidates.map((item) => ({ item, weight: weightOf(item, now) }));
  const picked: T[] = [];

  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, entry) => sum + entry.weight, 0);
    let target = random() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      target -= pool[i]?.weight ?? 0;
      if (target < 0) {
        index = i;
        break;
      }
    }
    const [entry] = pool.splice(index, 1);
    if (entry) picked.push(entry.item);
  }
  return picked;
}

export function weightOf(item: Candidate, now: number): number {
  const ageDays = Math.max(0, (now - item.savedAt) / DAY);
  const freshness = item.notifyCount === 0 ? 3 : 1 / (1 + item.notifyCount);
  return (1 + ageDays / 30) * freshness;
}
