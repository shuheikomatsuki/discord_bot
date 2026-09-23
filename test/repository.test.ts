import { describe, expect, it } from 'vitest';
import { normalizeIdish } from '../src/features/reminder/repository';

describe('normalizeIdish', () => {
  it('ID そのものや末尾だけならそのまま（大文字化）', () => {
    expect(normalizeIdish('01K5ABCDEFGHJKMNPQRSTVWXYZ')).toBe('01K5ABCDEFGHJKMNPQRSTVWXYZ');
    expect(normalizeIdish(' 145ft1 ')).toBe('145FT1');
  });

  it('候補の表示名が送られてきても先頭の ID を取り出す', () => {
    expect(
      normalizeIdish('145FT1 | 30分ごと | もしかしてまだ起きてる？ <:emoji_1:1211165473484312576>'),
    ).toBe('145FT1');
    expect(normalizeIdish('145FT1|1回のみ|本文')).toBe('145FT1');
  });

  it('ID の形でなければ null', () => {
    expect(normalizeIdish('')).toBeNull();
    expect(normalizeIdish('明日の会議')).toBeNull();
    expect(normalizeIdish('50%')).toBeNull();
    expect(normalizeIdish('A'.repeat(27))).toBeNull();
  });
});
