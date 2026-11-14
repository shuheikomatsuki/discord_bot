/**
 * 回答・締め切り・投稿・まとめを、本物の SQLite（migrations 適用済み）で通しで確かめる。
 * Discord への送信は fetch をモックして記録する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromZonedParts } from '../src/core/time';
import type { Env } from '../src/env';
import {
  closeStaleCheckins,
  promptDueHabits,
  remindUnanswered,
  sendSummaries,
} from '../src/features/habit/cron';
import { nextPromptAt, parseDays } from '../src/features/habit/dates';
import { buildReport, weekPeriod } from '../src/features/habit/report';
import * as repo from '../src/features/habit/repository';
import { answer, checkinButtons, HabitUserError } from '../src/features/habit/service';
import { createTestD1 } from './helpers/d1';

const TZ = 'Asia/Tokyo';
const jst = (d: number, h = 12, mi = 0) =>
  fromZonedParts({ year: 2026, month: 11, day: d, hour: h, minute: mi }, TZ);

interface SentRequest {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

let env: Env;
let sent: SentRequest[];

beforeEach(() => {
  env = {
    DB: createTestD1(),
    DISCORD_APPLICATION_ID: 'app',
    DISCORD_PUBLIC_KEY: 'pk',
    DISCORD_GUILD_ID: 'g1',
    DEFAULT_TIMEZONE: TZ,
    DISCORD_BOT_TOKEN: 'token',
  };
  sent = [];
  let n = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    sent.push({
      method: init.method ?? 'GET',
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    n += 1;
    return new Response(JSON.stringify({ id: `msg${n}` }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function createHabit(opts: {
  now: number;
  days?: string;
  autoFreeze?: boolean;
  userId?: string;
  remindMinute?: number | null;
  unit?: string | null;
  dailyTarget?: number | null;
}) {
  const id = `01HABIT${(opts.userId ?? 'u1').toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const daysMask = parseDays(opts.days);
  await repo.insertHabit(env.DB, {
    id,
    guildId: 'g1',
    userId: opts.userId ?? 'u1',
    channelId: 'c1',
    name: '筋トレ',
    timeZone: TZ,
    checkMinute: 21 * 60,
    daysMask,
    autoFreeze: opts.autoFreeze ?? true,
    nextPromptAt: nextPromptAt(opts.now, 21 * 60, daysMask, TZ).at,
    remindMinute: opts.remindMinute ?? null,
    unit: opts.unit ?? null,
    dailyTarget: opts.dailyTarget ?? null,
    now: opts.now,
  });
  await repo.ensureProfile(env.DB, 'g1', opts.userId ?? 'u1', opts.now, 'c1');
  const habit = await repo.getHabit(env.DB, id);
  if (!habit) throw new Error('habit not created');
  return habit;
}

describe('answer', () => {
  it('初回の達成で XP とバッジ。押し直しでは XP が増えない', async () => {
    const habit = await createHabit({ now: jst(1) });
    const first = await answer(env, habit, '2026-11-01', 'done', null, jst(1, 21));
    expect(first.summary.streak).toBe(1);
    expect(first.summary.xpGained).toBe(10);
    expect(first.summary.newBadges).toContain('first_step');

    await answer(env, first.habit, '2026-11-01', 'missed', null, jst(1, 21, 1));
    const again = await answer(env, first.habit, '2026-11-01', 'done', null, jst(1, 21, 2));
    expect(again.summary.xpGained).toBe(0);
    expect((await repo.getProfile(env.DB, 'g1', 'u1'))?.xp).toBe(10);
  });

  it('フリーズは在庫を使い、外すと返ってくる。在庫が無ければエラー', async () => {
    const habit = await createHabit({ now: jst(1) });
    expect((await repo.getProfile(env.DB, 'g1', 'u1'))?.freezes).toBe(1);

    await answer(env, habit, '2026-11-01', 'frozen', null, jst(1, 21));
    expect((await repo.getProfile(env.DB, 'g1', 'u1'))?.freezes).toBe(0);

    await expect(
      answer(env, habit, '2026-11-02', 'frozen', null, jst(2, 21)),
    ).rejects.toBeInstanceOf(HabitUserError);

    await answer(env, habit, '2026-11-01', 'done', null, jst(1, 22));
    expect((await repo.getProfile(env.DB, 'g1', 'u1'))?.freezes).toBe(1);
  });

  it('7日連続でボーナスとフリーズ獲得、フリーズを挟んでも記録は続く', async () => {
    let habit = await createHabit({ now: jst(1) });
    for (let d = 1; d <= 6; d++) {
      habit = (await answer(env, habit, `2026-11-0${d}`, 'done', null, jst(d, 21))).habit;
    }
    // 7日目: 在庫1 → 使って0。8日目に達成すると 7日連続（フリーズの日は数えない）
    habit = (await answer(env, habit, '2026-11-07', 'frozen', null, jst(7, 21))).habit;
    expect(habit.currentStreak).toBe(6);
    const day8 = await answer(env, habit, '2026-11-08', 'done', null, jst(8, 21));
    expect(day8.summary.streak).toBe(7);
    expect(day8.summary.xpGained).toBe(10 + 20);
    expect(day8.summary.freezeEarned).toBe(true);
    expect(day8.summary.newBadges).toEqual(expect.arrayContaining(['streak_7']));
    expect((await repo.getProfile(env.DB, 'g1', 'u1'))?.freezes).toBe(1);
  });

  it('ユーザーごとにデータが分かれる', async () => {
    const a = await createHabit({ now: jst(1), userId: 'u1' });
    await createHabit({ now: jst(1), userId: 'u2' });
    await answer(env, a, '2026-11-01', 'done', null, jst(1, 21));
    expect(await repo.listHabits(env.DB, 'g1', 'u1')).toHaveLength(1);
    expect(await repo.findHabit(env.DB, 'g1', 'u2', a.id)).toBeNull();
    expect((await repo.getProfile(env.DB, 'g1', 'u2'))?.xp).toBe(0);
  });
});

describe('cron', () => {
  it('時刻になったらチャンネルに投稿し、同じ日に2回は聞かない', async () => {
    const habit = await createHabit({ now: jst(13, 20) });
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 21) * 1000);
    await promptDueHabits(env);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain('/channels/c1/messages');
    expect(String(sent[0]?.body?.content)).toContain('<@u1>');
    const checkin = await repo.getCheckin(env.DB, habit.id, '2026-11-13');
    expect(checkin).toMatchObject({ status: 'pending', messageId: 'msg1' });
    const after = await repo.getHabit(env.DB, habit.id);
    expect(after?.nextPromptAt).toBe(jst(14, 21));

    await promptDueHabits(env);
    expect(sent).toHaveLength(1);
  });

  it('先に記録済みの日は聞かない', async () => {
    const habit = await createHabit({ now: jst(13, 8) });
    await answer(env, habit, '2026-11-13', 'done', null, jst(13, 9));
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 21) * 1000);
    await promptDueHabits(env);
    expect(sent).toHaveLength(0);
    expect((await repo.getHabit(env.DB, habit.id))?.nextPromptAt).toBe(jst(14, 21));
  });

  it('深夜0時を過ぎた未回答は、自動フリーズ（在庫あり）→ 未達（在庫なし）で締まる', async () => {
    const habit = await createHabit({ now: jst(11, 8) });
    for (const date of ['2026-11-11', '2026-11-12']) {
      await repo.insertCheckin(env.DB, {
        id: `01CK${date.replace(/-/g, '')}`,
        habit,
        date,
        status: 'pending',
        now: jst(11),
      });
    }
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 0, 2) * 1000); // close は偶数分に回る
    await closeStaleCheckins(env);

    expect((await repo.getCheckin(env.DB, habit.id, '2026-11-11'))?.status).toBe('frozen');
    expect((await repo.getCheckin(env.DB, habit.id, '2026-11-12'))?.status).toBe('missed');
    expect((await repo.getProfile(env.DB, 'g1', 'u1'))?.freezes).toBe(0);
  });

  it('当日の未回答はまだ締めない', async () => {
    const habit = await createHabit({ now: jst(13, 8) });
    await repo.insertCheckin(env.DB, {
      id: '01CKTODAY',
      habit,
      date: '2026-11-13',
      status: 'pending',
      now: jst(13, 21),
    });
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 23, 58) * 1000);
    await closeStaleCheckins(env);
    expect((await repo.getCheckin(env.DB, habit.id, '2026-11-13'))?.status).toBe('pending');
  });

  it('月曜9時に先週のまとめを1回だけ送る（記録が無い人には送らない）', async () => {
    const habit = await createHabit({ now: jst(9, 8) });
    await createHabit({ now: jst(9, 8), userId: 'u2' });
    for (const d of [9, 10, 11])
      await answer(env, habit, `2026-11-${String(d).padStart(2, '0')}`, 'done', null, jst(d, 21));

    vi.useFakeTimers();
    const at = (minute: number) =>
      vi.setSystemTime(
        fromZonedParts({ year: 2026, month: 11, day: 16, hour: 9, minute }, TZ) * 1000,
      );
    // summary は奇数分に1人ずつ。2人 × (週・月) を処理しきるまで回す
    for (const minute of [1, 3, 5, 7, 9]) {
      at(minute);
      await sendSummaries(env);
    }
    const summaries = sent.filter((s) => Array.isArray(s.body?.embeds));
    expect(summaries).toHaveLength(1);
    expect(String(summaries[0]?.body?.content)).toContain('<@u1>');
    const embeds = (summaries[0]?.body?.embeds ?? []) as { title: string; description: string }[];
    const embed = embeds[0];
    expect(embed?.title).toContain('週次まとめ');
    expect(embed?.description).toContain('達成率 100%');

    at(11);
    await sendSummaries(env);
    expect(sent.filter((s) => Array.isArray(s.body?.embeds))).toHaveLength(1);
    // 3回以上すべて達成したのでパーフェクトウィーク
    expect(await repo.listBadges(env.DB, 'g1', 'u1')).toContain('perfect_week');
  });
});

describe('cron の負荷分散', () => {
  it('close は奇数分には何もしない', async () => {
    const habit = await createHabit({ now: jst(11, 8) });
    await repo.insertCheckin(env.DB, {
      id: '01CKODD',
      habit,
      date: '2026-11-11',
      status: 'pending',
      now: jst(11),
    });
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 0, 1) * 1000);
    await closeStaleCheckins(env);
    expect((await repo.getCheckin(env.DB, habit.id, '2026-11-11'))?.status).toBe('pending');
  });
});

describe('投稿の失敗', () => {
  it('401 は毎分やり直し、日付が変わって諦めてもエラー理由は残す', async () => {
    const habit = await createHabit({ now: jst(13, 20, 59) }); // 21:00 の習慣
    vi.stubGlobal(
      'fetch',
      async () => new Response('{"message": "401: Unauthorized"}', { status: 401 }),
    );
    vi.useFakeTimers();

    vi.setSystemTime(jst(13, 21) * 1000);
    await promptDueHabits(env);
    let after = await repo.getHabit(env.DB, habit.id);
    expect(after?.status).toBe('active');
    expect(after?.nextPromptAt).toBe(jst(13, 21)); // 進めずに次の分で再試行
    expect(after?.lastError).toContain('401');
    expect(await repo.getCheckin(env.DB, habit.id, '2026-11-13')).toBeNull();

    // 日付が変わったら前日分は聞かずに次へ進むが、失敗理由は消さない
    vi.setSystemTime(jst(14, 0, 1) * 1000);
    await promptDueHabits(env);
    after = await repo.getHabit(env.DB, habit.id);
    expect(after?.nextPromptAt).toBe(jst(14, 21));
    expect(after?.lastError).toContain('401');
  });
});

describe('未回答の再通知', () => {
  it('再通知の時刻に未回答なら、元の投稿に1回だけ返信する', async () => {
    const habit = await createHabit({ now: jst(13, 20), remindMinute: 23 * 60 });
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 21) * 1000);
    await promptDueHabits(env);
    expect(sent).toHaveLength(1);

    vi.setSystemTime(jst(13, 22, 59) * 1000);
    await remindUnanswered(env);
    expect(sent).toHaveLength(1);

    vi.setSystemTime(jst(13, 23) * 1000);
    await remindUnanswered(env);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.url).toContain('/channels/c1/messages');
    expect(sent[1]?.body?.message_reference).toMatchObject({ message_id: 'msg1' });
    expect(String(sent[1]?.body?.content)).toContain('<@u1>');
    expect(sent[1]?.body?.components).toBeUndefined();

    vi.setSystemTime(jst(13, 23, 30) * 1000);
    await remindUnanswered(env);
    expect(sent).toHaveLength(2);
    expect((await repo.getCheckin(env.DB, habit.id, '2026-11-13'))?.status).toBe('pending');
  });

  it('回答済み・再通知なし・チェックインより前の時刻なら送らない', async () => {
    const answered = await createHabit({ now: jst(13, 20), remindMinute: 23 * 60 });
    await createHabit({ now: jst(13, 20), remindMinute: null, userId: 'u2' });
    await createHabit({ now: jst(13, 20), remindMinute: 20 * 60, userId: 'u3' });
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 21) * 1000);
    await promptDueHabits(env);
    expect(sent).toHaveLength(3);

    await answer(env, answered, '2026-11-13', 'done', null, jst(13, 22));
    vi.setSystemTime(jst(13, 23, 10) * 1000);
    await remindUnanswered(env);
    expect(sent).toHaveLength(3);
  });

  it('前日の未回答には再通知しない', async () => {
    const habit = await createHabit({ now: jst(12, 8), remindMinute: 23 * 60 });
    await repo.insertCheckin(env.DB, {
      id: '01CKYESTERDAY',
      habit,
      date: '2026-11-12',
      status: 'pending',
      now: jst(12, 21),
    });
    await repo.attachMessage(env.DB, '01CKYESTERDAY', 'c1', 'old');
    vi.useFakeTimers();
    vi.setSystemTime(jst(13, 23, 5) * 1000);
    await remindUnanswered(env);
    expect(sent).toHaveLength(0);
  });
});

describe('量の記録', () => {
  it('量を記録し、done 以外にすると消え、まとめに合計が出る', async () => {
    let habit = await createHabit({ now: jst(9, 8), unit: '分', dailyTarget: 30 });
    habit = (await answer(env, habit, '2026-11-09', 'done', null, jst(9, 21), 20)).habit;
    const day10 = await answer(env, habit, '2026-11-10', 'done', 'がんばった', jst(10, 21), 40);
    expect(day10.checkin.amount).toBe(40);
    expect(day10.checkin.note).toBe('がんばった');

    // メモだけ直しても量は残る
    const edited = await answer(env, habit, '2026-11-10', 'done', '修正', jst(10, 22));
    expect(edited.checkin.amount).toBe(40);

    await answer(env, habit, '2026-11-11', 'done', null, jst(11, 21), 15);
    const missed = await answer(env, habit, '2026-11-11', 'missed', null, jst(11, 22));
    expect(missed.checkin.amount).toBeNull();

    const report = await buildReport(env, 'g1', 'u1', weekPeriod('2026-11-09'), '2026-11-15');
    expect(report.embed.description).toContain('合計 60分（平均 30分/回）');
  });

  it('量を記録する習慣は「記録する」ボタン（量の入力フォーム）を出す', () => {
    const buttons = (habit: { unit: string | null }) =>
      (checkinButtons({ id: 'H1', ...habit }, '2026-11-13')[0]?.components ?? []).map((b) =>
        'custom_id' in b ? b.custom_id : '',
      );
    expect(buttons({ unit: '分' })).toEqual([
      'v1:habit:note:H1:2026-11-13',
      'v1:habit:freeze:H1:2026-11-13',
      'v1:habit:miss:H1:2026-11-13',
    ]);
    expect(buttons({ unit: null })).toHaveLength(4);
  });
});
