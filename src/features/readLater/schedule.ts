import { toZonedParts } from '../../core/time';
import type { ReadLaterConfig } from './config';

const PAD = (n: number): string => String(n).padStart(2, '0');

/**
 * 今日の紹介時刻を過ぎていれば、その日付（"YYYY-MM-DD"）を返す。過ぎていなければ null。
 * 「今日もう送ったか」は D1 にこの日付を記録して判定する。
 * ちょうどの分だけで判定しないのは、cron が1分取りこぼしても送れるようにするため。
 */
export function digestDateIfDue(now: number, config: ReadLaterConfig): string | null {
  const p = toZonedParts(now, config.timeZone);
  const minutes = p.hour * 60 + p.minute;
  if (minutes < config.digestHour * 60 + config.digestMinute) return null;
  return `${p.year}-${PAD(p.month)}-${PAD(p.day)}`;
}
