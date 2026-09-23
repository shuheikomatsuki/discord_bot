import { describe, expect, it } from 'vitest';
import { encodeCustomId, parseCustomId } from '../src/core/customId';
import { formatZoned, fromZonedParts, toZonedParts } from '../src/core/time';
import { buildMention, describeMention } from '../src/discord/mentions';

describe('customId', () => {
  it('往復できる', () => {
    const id = encodeCustomId('reminder', 'pause', '01JBX7K2ZQ');
    expect(parseCustomId(id)).toEqual({
      feature: 'reminder',
      action: 'pause',
      args: ['01JBX7K2ZQ'],
    });
  });

  it('100文字を超えたら投げる（Discord の上限）', () => {
    expect(() => encodeCustomId('reminder', 'pause', 'x'.repeat(200))).toThrow();
  });

  it('区切り文字を含む断片は拒否する', () => {
    expect(() => encodeCustomId('reminder', 'pa:use', 'x')).toThrow();
  });

  it('未知の形式は null', () => {
    expect(parseCustomId('v0:reminder:pause:1')).toBeNull();
    expect(parseCustomId('nonsense')).toBeNull();
  });
});

describe('buildMention', () => {
  it('メンションなしでも parse を明示して本文の @everyone を無効化する', () => {
    const built = buildMention({ type: 'none', userIds: [], roleIds: [] });
    expect(built.prefix).toBe('');
    expect(built.allowedMentions).toEqual({ parse: [] });
  });

  it('everyone は parse で許可する', () => {
    const built = buildMention({ type: 'everyone', userIds: [], roleIds: [] });
    expect(built.prefix).toBe('@everyone ');
    expect(built.allowedMentions.parse).toEqual(['everyone']);
  });

  it('ユーザー指定は users のみを許可する', () => {
    const built = buildMention({ type: 'users', userIds: ['1', '2'], roleIds: [] });
    expect(built.prefix).toBe('<@1> <@2> ');
    expect(built.allowedMentions).toEqual({ parse: [], users: ['1', '2'] });
  });

  it('ロール指定は roles のみを許可する', () => {
    const built = buildMention({ type: 'roles', userIds: [], roleIds: ['9'] });
    expect(built.prefix).toBe('<@&9> ');
    expect(built.allowedMentions).toEqual({ parse: [], roles: ['9'] });
  });

  it('ユーザーとロールを混在させて複数人メンションできる', () => {
    const built = buildMention({ type: 'users', userIds: ['1', '2'], roleIds: ['9'] });
    expect(built.prefix).toBe('<@1> <@2> <@&9> ');
    expect(built.allowedMentions).toEqual({ parse: [], users: ['1', '2'], roles: ['9'] });
    expect(describeMention({ type: 'users', userIds: ['1'], roleIds: ['9'] })).toBe('<@1> <@&9>');
  });
});

describe('time', () => {
  it('壁時計 <-> UNIX 秒 を往復できる', () => {
    const at = fromZonedParts({ year: 2026, month: 9, day: 22, hour: 9, minute: 0 }, 'Asia/Tokyo');
    expect(formatZoned(at, 'Asia/Tokyo')).toBe('2026-09-22 09:00');
    // JST は UTC+9
    expect(formatZoned(at, 'UTC')).toBe('2026-09-22 00:00');
  });

  it('曜日を返す', () => {
    const monday = fromZonedParts({ year: 2026, month: 9, day: 21, hour: 0, minute: 0 }, 'UTC');
    expect(toZonedParts(monday, 'UTC').weekday).toBe(new Date('2026-09-21T00:00:00Z').getUTCDay());
  });

  it('DST のあるタイムゾーンでも往復できる', () => {
    const at = fromZonedParts(
      { year: 2026, month: 7, day: 1, hour: 12, minute: 0 },
      'America/New_York',
    );
    expect(formatZoned(at, 'America/New_York')).toBe('2026-07-01 12:00');
  });
});
