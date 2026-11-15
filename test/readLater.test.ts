import type { APIMessage } from 'discord-api-types/v10';
import { describe, expect, it } from 'vitest';
import { fromZonedParts } from '../src/core/time';
import type { Env } from '../src/env';
import { loadConfig, type ReadLaterConfig } from '../src/features/readLater/config';
import { digestDateIfDue } from '../src/features/readLater/schedule';
import { pickItems, weightOf } from '../src/features/readLater/select';
import {
  compareSnowflakes,
  itemsFrom,
  looksLikeMissingContent,
} from '../src/features/readLater/sync';
import { extractTitle } from '../src/features/readLater/title';
import {
  extractNote,
  extractUrls,
  isXStatusUrl,
  normalizeUrl,
} from '../src/features/readLater/urls';

const DAY = 24 * 60 * 60;

describe('extractUrls', () => {
  it('本文中の URL をすべて取り出す（文末の句読点・括弧は含めない）', () => {
    expect(
      extractUrls('これ読む https://zenn.dev/a/articles/b 。あと（https://qiita.com/x/items/y）'),
    ).toEqual(['https://zenn.dev/a/articles/b', 'https://qiita.com/x/items/y']);
  });

  it('埋め込み抑止の <URL> 記法でも取れる', () => {
    expect(extractUrls('<https://example.com/post>')).toEqual(['https://example.com/post']);
  });

  it('同じ URL は1回だけ', () => {
    expect(extractUrls('https://a.com/x https://a.com/x/')).toEqual(['https://a.com/x']);
  });

  it('URL が無ければ空', () => {
    expect(extractUrls('今日は雨')).toEqual([]);
  });
});

describe('normalizeUrl', () => {
  it('twitter.com とシェア用クエリを x.com に統一する', () => {
    expect(normalizeUrl('https://twitter.com/foo/status/123?s=20&t=abc')).toBe(
      'https://x.com/foo/status/123',
    );
    expect(normalizeUrl('https://mobile.x.com/foo/status/123')).toBe(
      'https://x.com/foo/status/123',
    );
  });

  it('utm_* などのトラッキング用クエリとハッシュを落とす', () => {
    expect(normalizeUrl('https://example.com/a?id=1&utm_source=x&fbclid=y#top')).toBe(
      'https://example.com/a?id=1',
    );
  });

  it('http(s) 以外は null', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('isXStatusUrl', () => {
  it('ポストの URL だけ true', () => {
    expect(isXStatusUrl('https://x.com/foo/status/123')).toBe(true);
    expect(isXStatusUrl('https://x.com/foo')).toBe(false);
    expect(isXStatusUrl('https://zenn.dev/foo/status/1')).toBe(false);
  });
});

describe('extractNote', () => {
  it('URL を除いた本文をメモにする', () => {
    expect(extractNote('CI のキャッシュの話\nhttps://x.com/a/status/1')).toBe(
      'CI のキャッシュの話',
    );
    expect(extractNote('https://x.com/a/status/1')).toBeNull();
  });
});

describe('extractTitle', () => {
  it('og:title を優先し、実体参照を戻す', () => {
    const html =
      '<head><title>サイト名</title><meta property="og:title" content="Rust &amp; 非同期"></head>';
    expect(extractTitle(html)).toBe('Rust & 非同期');
  });

  it('og:title が無ければ <title>', () => {
    expect(extractTitle('<title>\n  記事タイトル | Zenn \n</title>')).toBe('記事タイトル | Zenn');
  });

  it('どちらも無ければ null', () => {
    expect(extractTitle('<html></html>')).toBeNull();
  });
});

describe('pickItems', () => {
  const now = 1_800_000_000;
  const old = { id: 'a', savedAt: now - 100 * DAY, notifyCount: 0 };
  const fresh = { id: 'b', savedAt: now - 1 * DAY, notifyCount: 0 };
  const repeated = { id: 'c', savedAt: now - 10 * DAY, notifyCount: 4 };
  const items = [old, fresh, repeated];

  it('指定件数を重複なく選ぶ', () => {
    const picked = pickItems(items, 2, now, () => 0.5);
    expect(picked).toHaveLength(2);
    expect(new Set(picked.map((p) => p.id)).size).toBe(2);
  });

  it('候補より多く頼まれたら全部', () => {
    expect(
      pickItems(items, 10, now)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['a', 'b', 'c']);
  });

  it('古い記事・未紹介の記事ほど重い', () => {
    expect(weightOf(old, now)).toBeGreaterThan(weightOf(fresh, now));
    expect(weightOf(fresh, now)).toBeGreaterThan(weightOf(repeated, now));
  });

  it('乱数が 0 なら一番手前、1 に近ければ一番奥', () => {
    expect(pickItems(items, 1, now, () => 0)[0]?.id).toBe('a');
    expect(pickItems(items, 1, now, () => 0.999999)[0]?.id).toBe('c');
  });
});

describe('digestDateIfDue', () => {
  const config = { digestHour: 8, digestMinute: 0, timeZone: 'Asia/Tokyo' } as ReadLaterConfig;
  const at = (hour: number, minute: number) =>
    fromZonedParts({ year: 2026, month: 11, day: 15, hour, minute }, 'Asia/Tokyo');

  it('時刻前は null、過ぎたらその日の日付', () => {
    expect(digestDateIfDue(at(7, 59), config)).toBeNull();
    expect(digestDateIfDue(at(8, 0), config)).toBe('2026-11-15');
    expect(digestDateIfDue(at(23, 30), config)).toBe('2026-11-15');
  });
});

describe('loadConfig', () => {
  const base = { DEFAULT_TIMEZONE: 'Asia/Tokyo' } as Env;

  it('監視チャンネルか持ち主が空なら無効', () => {
    expect(loadConfig(base)).toBeNull();
    expect(loadConfig({ ...base, READ_LATER_SOURCE_CHANNEL_ID: '1' })).toBeNull();
  });

  it('既定値と上限', () => {
    const config = loadConfig({
      ...base,
      READ_LATER_SOURCE_CHANNEL_ID: '1',
      READ_LATER_OWNER_ID: '2',
      READ_LATER_DIGEST_COUNT: '99',
      READ_LATER_DIGEST_TIME: '21:30',
    });
    expect(config).toMatchObject({
      sourceChannelId: '1',
      notifyChannelId: '1',
      ownerId: '2',
      digestHour: 21,
      digestMinute: 30,
      digestCount: 5,
      snoozeDays: 7,
    });
  });
});

describe('sync helpers', () => {
  const message = (overrides: Partial<APIMessage>): APIMessage =>
    ({
      id: '1300000000000000000',
      content: '',
      timestamp: '2026-11-01T00:00:00.000Z',
      author: { id: 'owner', username: 'me' },
      attachments: [],
      embeds: [],
      ...overrides,
    }) as unknown as APIMessage;

  it('1つの投稿に複数 URL があれば別の記事にする', () => {
    const items = itemsFrom(
      message({ content: 'あとで https://a.com/1 https://b.com/2' }),
      'ch',
      'g',
    );
    expect(items.map((i) => i.url)).toEqual(['https://a.com/1', 'https://b.com/2']);
    expect(items[0]).toMatchObject({ note: 'あとで', messageId: '1300000000000000000' });
  });

  it('転送されたメッセージの URL も拾う', () => {
    const forwarded = message({
      message_snapshots: [{ message: { content: 'https://a.com/fw' } }],
    } as Partial<APIMessage>);
    expect(itemsFrom(forwarded, 'ch', null).map((i) => i.url)).toEqual(['https://a.com/fw']);
  });

  it('本文も添付も空なら Message Content Intent が OFF とみなす', () => {
    expect(looksLikeMissingContent(message({}))).toBe(true);
    expect(looksLikeMissingContent(message({ content: 'hi' }))).toBe(false);
  });

  it('snowflake は桁が違っても数値として比べる', () => {
    expect(compareSnowflakes('999', '1000')).toBe(-1);
    expect(compareSnowflakes('1300000000000000001', '1300000000000000000')).toBe(1);
  });
});
