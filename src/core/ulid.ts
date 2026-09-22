/**
 * ULID（26文字・時系列でソート可能）。
 * 依存を増やさないための最小実装。暗号用途ではない。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

function encodeTime(now: number): string {
  let out = '';
  let value = now;
  for (let i = TIME_LENGTH - 1; i >= 0; i--) {
    out = ENCODING.charAt(value % 32) + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ENCODING.charAt(byte % 32);
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** 表示・入力用の短縮形。先頭は時刻由来なので、末尾のほうが衝突しにくい */
export function shortId(id: string): string {
  return id.slice(-6);
}
