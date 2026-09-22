/**
 * Discord からのリクエストの Ed25519 署名検証。
 * これが正しく 401 を返せないと、Developer Portal でエンドポイント登録が通らない。
 */

/** 署名タイムスタンプの許容ズレ（秒）。リプレイ対策 */
const MAX_TIMESTAMP_SKEW_SECONDS = 300;

/** workers-types には AlgorithmIdentifier が無いので、実際のシグネチャから借りる */
type VerifyAlgorithm = Parameters<SubtleCrypto['verify']>[0];
type ImportAlgorithm = Parameters<SubtleCrypto['importKey']>[2];

interface CachedKey {
  key: CryptoKey;
  algorithm: VerifyAlgorithm;
}

const keyCache = new Map<string, CachedKey>();

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex の長さが奇数です');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hex として解釈できません');
    bytes[i] = byte;
  }
  return bytes;
}

async function importPublicKey(publicKeyHex: string): Promise<CachedKey> {
  const cached = keyCache.get(publicKeyHex);
  if (cached) return cached;

  const raw = hexToBytes(publicKeyHex);
  let result: CachedKey;
  try {
    // 現行の Workers / WebCrypto 標準
    result = {
      key: await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']),
      algorithm: { name: 'Ed25519' },
    };
  } catch {
    // 旧 Workers 互換（NODE-ED25519 エイリアス）
    const legacy = {
      name: 'NODE-ED25519',
      namedCurve: 'NODE-ED25519',
    } as unknown as ImportAlgorithm & VerifyAlgorithm;
    result = {
      key: await crypto.subtle.importKey('raw', raw, legacy, false, ['verify']),
      algorithm: legacy,
    };
  }
  keyCache.set(publicKeyHex, result);
  return result;
}

export interface VerifyInput {
  publicKeyHex: string;
  signature: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string;
  /** テスト用。省略時は現在時刻 */
  now?: number;
}

export async function verifyDiscordSignature(input: VerifyInput): Promise<boolean> {
  const { publicKeyHex, signature, timestamp, rawBody } = input;
  if (!signature || !timestamp || !publicKeyHex) return false;

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) return false;
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(now - sentAt) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  try {
    const { key, algorithm } = await importPublicKey(publicKeyHex);
    return await crypto.subtle.verify(
      algorithm,
      key,
      hexToBytes(signature),
      new TextEncoder().encode(timestamp + rawBody),
    );
  } catch {
    return false;
  }
}
