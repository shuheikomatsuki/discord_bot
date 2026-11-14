import {
  type APIInteractionResponseCallbackData,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
} from 'discord-api-types/v10';
import { getBoolean, getChannelId, getInteger, getString } from '../../core/options';
import { autocomplete } from '../../core/respond';
import { nowSeconds } from '../../core/time';
import type { AutocompleteContext, Command, CommandContext } from '../../core/types';
import { ulid } from '../../core/ulid';
import { actor, confirmDelete, currentChannel, ephemeral, guarded, idOption } from './context';
import {
  addDays,
  eachDay,
  formatDateJa,
  isScheduled,
  nextPromptAt,
  parseDateInput,
  parseDays,
  parseTimeOfDay,
} from './dates';
import { levelInfo } from './gamification';
import { habitAutocompleteLabel, habitLine, habitSchedule, levelLine } from './render';
import * as repo from './repository';
import type { Habit } from './schema';
import {
  answer,
  HabitUserError,
  refreshHabitStats,
  syncCheckinMessage,
  timeZoneOf,
  todayOf,
} from './service';

const MAX_HABITS = 20;
const MAX_FREEZE_DAYS = 7;

const channelOption = {
  type: ApplicationCommandOptionType.Channel,
  name: 'channel',
  description: 'チェックインを投稿するチャンネル（未指定ならこのチャンネル）',
  channel_types: [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread],
} as const;

const timeOption = (required: boolean) =>
  ({
    type: ApplicationCommandOptionType.String,
    name: 'time',
    description: '聞いてほしい時刻。例: 21:00 / 7:30',
    required,
  }) as const;

const daysOption = {
  type: ApplicationCommandOptionType.String,
  name: 'days',
  description: '曜日。例: 毎日 / 平日 / 土日 / 月水金（未指定なら毎日）',
  autocomplete: true,
} as const;

const autoFreezeOption = {
  type: ApplicationCommandOptionType.Boolean,
  name: 'auto_freeze',
  description: '未回答のまま日付が変わったら、在庫があれば自動でフリーズを使う（既定: オン）',
} as const;

const habitId = idOption('対象の習慣');

const definition = {
  name: 'habit',
  description: '習慣を登録して、毎日のチェックインで続ける',
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'add',
      description: '習慣を登録する（決まった時刻にチャンネルで「やった？」と聞きます）',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'name',
          description: '習慣の名前。例: 筋トレ30分',
          required: true,
          max_length: 50,
        },
        timeOption(true),
        daysOption,
        channelOption,
        autoFreezeOption,
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'list',
      description: '自分の習慣の一覧',
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'done',
      description: '今日の分を今すぐ「やった」と記録する',
      options: [
        habitId,
        {
          type: ApplicationCommandOptionType.String,
          name: 'note',
          description: 'メモ',
          max_length: 300,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'freeze',
      description: '休む日を前もってフリーズする（在庫を使う / 記録は途切れない）',
      options: [
        habitId,
        {
          type: ApplicationCommandOptionType.Integer,
          name: 'days',
          description: '何日分（既定 1）',
          min_value: 1,
          max_value: MAX_FREEZE_DAYS,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'start',
          description: '開始日。例: 今日 / 明日 / 12/24（既定: 今日）',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'edit',
      description: '習慣を編集する',
      options: [
        habitId,
        {
          type: ApplicationCommandOptionType.String,
          name: 'name',
          description: '新しい名前',
          max_length: 50,
        },
        timeOption(false),
        daysOption,
        channelOption,
        autoFreezeOption,
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'pause',
      description: 'チェックインを一時停止する',
      options: [habitId],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'resume',
      description: '一時停止を解除する',
      options: [habitId],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'delete',
      description: '習慣と記録を削除する',
      options: [habitId],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'settings',
      description: 'まとめの投稿先やランキング表示を設定する',
      options: [
        {
          type: ApplicationCommandOptionType.Channel,
          name: 'summary_channel',
          description: '週次・月次まとめを投稿するチャンネル',
          channel_types: [
            ChannelType.GuildText,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
          ],
        },
        {
          type: ApplicationCommandOptionType.Boolean,
          name: 'hide_ranking',
          description: 'ランキングに自分を表示しない',
        },
      ],
    },
  ],
} as const;

// --------------------------------------------------------------- ヘルパ

async function requireHabit(c: CommandContext): Promise<Habit> {
  const { guildId, userId, options } = actor(c.interaction);
  const idish = getString(options, 'id') ?? '';
  const habit = await repo.findHabit(c.env.DB, guildId, userId, idish);
  if (!habit) {
    throw new HabitUserError(
      `習慣が見つかりません: \`${idish.slice(0, 50)}\`\n\`id\` 欄は入力中に出る候補から選んでください（自分の習慣だけが対象です）。`,
    );
  }
  return habit;
}

function nextLine(h: Habit): string {
  return h.status === 'active' && h.nextPromptAt
    ? `次のチェックイン: <t:${h.nextPromptAt}:F>（<t:${h.nextPromptAt}:R>）`
    : '⏸️ 一時停止中';
}

// --------------------------------------------------------------- サブコマンド

async function add(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId, options } = actor(c.interaction);
  const now = nowSeconds();
  const timeZone = timeZoneOf(c.env);

  const name = (getString(options, 'name') ?? '').trim();
  if (!name) throw new HabitUserError('名前が空です。');
  const checkMinute = parseTimeOfDay(getString(options, 'time') ?? '');
  const daysMask = parseDays(getString(options, 'days'));
  const channelId = getChannelId(options, 'channel') ?? currentChannel(c.interaction);

  const existing = await repo.listHabits(c.env.DB, guildId, userId);
  if (existing.length >= MAX_HABITS)
    throw new HabitUserError(`習慣は1人 ${MAX_HABITS} 個までです。`);

  const id = ulid(now * 1000);
  const next = nextPromptAt(now, checkMinute, daysMask, timeZone);
  await repo.insertHabit(c.env.DB, {
    id,
    guildId,
    userId,
    channelId,
    name,
    timeZone,
    checkMinute,
    daysMask,
    autoFreeze: getBoolean(options, 'auto_freeze') ?? true,
    nextPromptAt: next.at,
    now,
  });
  // 最初の習慣のチャンネルを、まとめの投稿先にしておく
  await repo.ensureProfile(c.env.DB, guildId, userId, now, channelId);

  const habit = await repo.getHabit(c.env.DB, id);
  if (!habit) throw new Error('作成した習慣を取得できませんでした');
  return ephemeral(
    [
      `✅ 習慣を登録しました。\n${habitLine(habit)}`,
      nextLine(habit),
      '',
      `時刻になると <#${channelId}> で「やった？」と聞きます。ボタンで答えてください。`,
      '-# 先にやり終えたら `/habit done` でも記録できます。1日の区切りは深夜0時です。',
    ].join('\n'),
  );
}

async function list(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId } = actor(c.interaction);
  const now = nowSeconds();
  const [habits, profile] = await Promise.all([
    repo.listHabits(c.env.DB, guildId, userId),
    repo.ensureProfile(c.env.DB, guildId, userId, now),
  ]);
  const head = `${levelLine(levelInfo(profile.xp), profile.xp)} · 🧊フリーズ ×${profile.freezes}`;
  if (habits.length === 0) {
    return ephemeral(`${head}\n\nまだ習慣がありません。\`/habit add\` で登録しましょう。`);
  }
  return ephemeral(
    `${head}\n\n📋 **習慣（${habits.length}件）**\n${habits.map(habitLine).join('\n')}`,
  );
}

async function done(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const habit = await requireHabit(c);
  const { options } = actor(c.interaction);
  const now = nowSeconds();
  const today = todayOf(c.env, now);
  const note = getString(options, 'note')?.trim() || null;

  const result = await answer(c.env, habit, today, 'done', note, now);
  await syncCheckinMessage(c.env, result.habit, result.checkin, result.summary, false);

  const s = result.summary;
  const lines = [
    `✅ **${habit.name}**（${formatDateJa(today)}）を記録しました。`,
    `🔥 ${s.streak}日連続${s.xpGained > 0 ? ` · +${s.xpGained}XP` : ''}`,
  ];
  if (s.leveledUpTo !== null) lines.push(`⬆️ レベル${s.leveledUpTo} になりました！`);
  if (s.freezeEarned) lines.push(`🧊 フリーズを1個獲得（在庫 ${s.freezesLeft}）`);
  if (s.newBadges.length > 0) lines.push('🎖️ 新しいバッジを獲得しました（`/stats profile`）');
  return ephemeral(lines.join('\n'));
}

async function freeze(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const habit = await requireHabit(c);
  const { options } = actor(c.interaction);
  const db = c.env.DB;
  const now = nowSeconds();
  const today = todayOf(c.env, now);
  const start = parseDateInput(getString(options, 'start') ?? '今日', today);
  if (start < today) throw new HabitUserError('過去の日はフリーズできません。');
  const days = getInteger(options, 'days') ?? 1;

  // 予定日のうち、まだ回答していない日だけが対象
  const targets: { date: string; existingId: string | null }[] = [];
  for (const date of eachDay(start, addDays(start, days - 1))) {
    if (!isScheduled(habit.daysMask, date)) continue;
    const existing = await repo.getCheckin(db, habit.id, date);
    if (!existing) targets.push({ date, existingId: null });
    else if (existing.status === 'pending') targets.push({ date, existingId: existing.id });
  }
  if (targets.length === 0) {
    return ephemeral('フリーズが必要な日はありません（予定外の曜日か、回答済みです）。');
  }

  const profile = await repo.ensureProfile(db, habit.guildId, habit.userId, now);
  if (!(await repo.consumeFreezes(db, habit.guildId, habit.userId, targets.length, now))) {
    throw new HabitUserError(
      `フリーズが足りません（必要 ${targets.length} / 在庫 ${profile.freezes}）。7日連続ごとに1個もらえます。`,
    );
  }

  let applied = 0;
  for (const t of targets) {
    const ok = t.existingId
      ? (
          await repo.setCheckinStatus(db, {
            id: t.existingId,
            status: 'frozen',
            expected: ['pending'],
            now,
          })
        ).updated
      : await repo.insertCheckin(db, {
          id: ulid(now * 1000),
          habit,
          date: t.date,
          status: 'frozen',
          now,
        });
    if (ok) applied += 1;
  }
  if (applied < targets.length)
    await repo.refundFreezes(db, habit.guildId, habit.userId, targets.length - applied, now);

  const refreshed = await refreshHabitStats(db, habit, now);
  // 今日の投稿が既にあれば、表示もフリーズに変える
  const todays = await repo.getCheckin(db, habit.id, today);
  if (todays?.status === 'frozen') await syncCheckinMessage(c.env, refreshed, todays, null, false);

  return ephemeral(
    `🧊 **${habit.name}** を ${applied}日分フリーズしました: ${targets.map((t) => formatDateJa(t.date)).join(' ')}\n在庫 ${profile.freezes - applied}個 · 🔥 ${refreshed.currentStreak}日連続はそのまま続きます。`,
  );
}

async function edit(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const habit = await requireHabit(c);
  const { options } = actor(c.interaction);
  const now = nowSeconds();
  const patch: repo.HabitPatch = {};

  const name = getString(options, 'name');
  if (name !== undefined) {
    if (!name.trim()) throw new HabitUserError('名前が空です。');
    patch.name = name.trim();
  }
  const time = getString(options, 'time');
  if (time !== undefined) patch.checkMinute = parseTimeOfDay(time);
  const days = getString(options, 'days');
  if (days !== undefined) patch.daysMask = parseDays(days);
  const channelId = getChannelId(options, 'channel');
  if (channelId !== undefined) patch.channelId = channelId;
  const autoFreeze = getBoolean(options, 'auto_freeze');
  if (autoFreeze !== undefined) patch.autoFreeze = autoFreeze;

  if (
    (patch.checkMinute !== undefined || patch.daysMask !== undefined) &&
    habit.status === 'active'
  ) {
    patch.nextPromptAt = nextPromptAt(
      now,
      patch.checkMinute ?? habit.checkMinute,
      patch.daysMask ?? habit.daysMask,
      habit.timeZone,
    ).at;
  }

  if (!(await repo.updateHabit(c.env.DB, habit.id, patch, now))) {
    throw new HabitUserError('変更する項目がありません。');
  }
  const updated = await repo.getHabit(c.env.DB, habit.id);
  if (!updated) throw new Error('更新後の取得に失敗しました');
  return ephemeral(`✏️ 更新しました。\n${habitLine(updated)}\n${nextLine(updated)}`);
}

async function setPaused(
  c: CommandContext,
  paused: boolean,
): Promise<APIInteractionResponseCallbackData> {
  const habit = await requireHabit(c);
  const now = nowSeconds();
  await repo.updateHabit(
    c.env.DB,
    habit.id,
    paused
      ? { status: 'paused', nextPromptAt: null }
      : {
          status: 'active',
          nextPromptAt: nextPromptAt(now, habit.checkMinute, habit.daysMask, habit.timeZone).at,
        },
    now,
  );
  const updated = await repo.getHabit(c.env.DB, habit.id);
  if (!updated) throw new Error('更新後の取得に失敗しました');
  return ephemeral(
    paused
      ? `⏸️ **${habit.name}** を一時停止しました。停止中の日は記録に影響しません。`
      : `▶️ **${habit.name}** を再開しました（${habitSchedule(updated)}）。\n${nextLine(updated)}`,
  );
}

async function remove(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const habit = await requireHabit(c);
  return confirmDelete('delhabit', habit.id, `習慣「${habit.name}」（累計 ${habit.totalDone}回）`);
}

async function settings(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId, options } = actor(c.interaction);
  const now = nowSeconds();
  await repo.ensureProfile(c.env.DB, guildId, userId, now);
  const summaryChannelId = getChannelId(options, 'summary_channel');
  const hideRanking = getBoolean(options, 'hide_ranking');
  await repo.updateProfileSettings(
    c.env.DB,
    guildId,
    userId,
    { summaryChannelId, hideRanking },
    now,
  );
  const profile = await repo.getProfile(c.env.DB, guildId, userId);
  return ephemeral(
    [
      '⚙️ 設定',
      `まとめの投稿先: ${profile?.summaryChannelId ? `<#${profile.summaryChannelId}>` : '未設定'}（月曜9時に先週分、毎月1日9時に先月分）`,
      `ランキング: ${profile?.hideRanking ? '表示しない' : '表示する'}`,
    ].join('\n'),
  );
}

// --------------------------------------------------------------- 入口

const handler = guarded('habit', async (c) => {
  switch (c.sub) {
    case 'add':
      return add(c);
    case 'list':
      return list(c);
    case 'done':
      return done(c);
    case 'freeze':
      return freeze(c);
    case 'edit':
      return edit(c);
    case 'pause':
      return setPaused(c, true);
    case 'resume':
      return setPaused(c, false);
    case 'delete':
      return remove(c);
    case 'settings':
      return settings(c);
    default:
      return ephemeral('未対応のサブコマンドです。');
  }
});

const DAY_SUGGESTIONS = ['毎日', '平日', '土日', '月水金', '火木', '月火水木金土'];

async function autocompleteHandler(c: AutocompleteContext) {
  if (c.focused === 'days') {
    const value = c.value.trim();
    const choices = DAY_SUGGESTIONS.filter((s) => s.includes(value)).map((s) => ({
      name: s,
      value: s,
    }));
    if (value && !DAY_SUGGESTIONS.includes(value)) {
      try {
        parseDays(value);
        choices.unshift({ name: `${value}（そのまま使う）`, value });
      } catch {
        // 解釈できない入力は候補に出さない
      }
    }
    return autocomplete(choices);
  }
  if (c.focused === 'id') {
    const guildId = c.interaction.guild_id;
    const userId = c.interaction.member?.user.id ?? c.interaction.user?.id;
    if (!guildId || !userId) return autocomplete([]);
    const habits = await repo.listHabits(c.env.DB, guildId, userId);
    const needle = c.value.trim().toLowerCase();
    return autocomplete(
      habits
        .filter(
          (h) =>
            !needle || h.name.toLowerCase().includes(needle) || h.id.toLowerCase().includes(needle),
        )
        .map((h) => ({ name: habitAutocompleteLabel(h), value: h.id })),
    );
  }
  return autocomplete([]);
}

export const habitCommand: Command = {
  definition: definition as unknown as Command['definition'],
  deferred: true,
  ephemeral: true,
  handler,
  autocomplete: autocompleteHandler,
};
