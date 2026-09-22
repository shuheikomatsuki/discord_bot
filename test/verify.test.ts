import { describe, expect, it } from 'vitest';
import { verifyDiscordSignature } from '../src/core/verify';

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeSigner() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyHex = toHex((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const sign = async (timestamp: string, body: string): Promise<string> =>
    toHex(await crypto.subtle.sign('Ed25519', pair.privateKey, encoder.encode(timestamp + body)));
  return { publicKeyHex, sign };
}

describe('verifyDiscordSignature', () => {
  const now = 1_800_000_000_000;
  const timestamp = String(Math.floor(now / 1000));
  const body = JSON.stringify({ type: 1 });

  it('正しい署名を受理する', async () => {
    const { publicKeyHex, sign } = await makeSigner();
    const signature = await sign(timestamp, body);
    await expect(
      verifyDiscordSignature({ publicKeyHex, signature, timestamp, rawBody: body, now }),
    ).resolves.toBe(true);
  });

  it('本文が改竄されていたら拒否する', async () => {
    const { publicKeyHex, sign } = await makeSigner();
    const signature = await sign(timestamp, body);
    await expect(
      verifyDiscordSignature({
        publicKeyHex,
        signature,
        timestamp,
        rawBody: JSON.stringify({ type: 2 }),
        now,
      }),
    ).resolves.toBe(false);
  });

  it('別の鍵で署名されていたら拒否する', async () => {
    const a = await makeSigner();
    const b = await makeSigner();
    const signature = await b.sign(timestamp, body);
    await expect(
      verifyDiscordSignature({
        publicKeyHex: a.publicKeyHex,
        signature,
        timestamp,
        rawBody: body,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('古いタイムスタンプはリプレイとみなして拒否する', async () => {
    const { publicKeyHex, sign } = await makeSigner();
    const old = String(Math.floor(now / 1000) - 600);
    const signature = await sign(old, body);
    await expect(
      verifyDiscordSignature({ publicKeyHex, signature, timestamp: old, rawBody: body, now }),
    ).resolves.toBe(false);
  });

  it('ヘッダが欠けていたら拒否する', async () => {
    const { publicKeyHex } = await makeSigner();
    await expect(
      verifyDiscordSignature({ publicKeyHex, signature: null, timestamp, rawBody: body, now }),
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature({
        publicKeyHex,
        signature: 'zz',
        timestamp: null,
        rawBody: body,
        now,
      }),
    ).resolves.toBe(false);
  });

  it('署名が hex として壊れていたら拒否する', async () => {
    const { publicKeyHex } = await makeSigner();
    await expect(
      verifyDiscordSignature({
        publicKeyHex,
        signature: 'not-hex!',
        timestamp,
        rawBody: body,
        now,
      }),
    ).resolves.toBe(false);
  });
});
