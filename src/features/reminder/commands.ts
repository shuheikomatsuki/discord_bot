import {
  type APIApplicationCommandOption,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponseCallbackData,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  MessageFlags,
} from 'discord-api-types/v10';
import {
  getBoolean,
  getChannelId,
  getInteger,
  getMentionable,
  getString,
  resolveOptions,
} from '../../core/options';
import { autocomplete, ephemeralText } from '../../core/respond';
import { nowSeconds } from '../../core/time';
import type { AutocompleteContext, Command, CommandContext } from '../../core/types';
import { ulid } from '../../core/ulid';
import type { MentionType } from '../../discord/mentions';
import * as repo from './repository';
import {
  advanceSchedule,
  describeSchedule,
  firstFireAt,
  parseAt,
  parseCron,
  parseDuration,
  parseInterval,
  ScheduleError,
  type ScheduleKind,
} from './schedule';
import type { Reminder } from './schema';
import {
  autocompleteLabel,
  listLines,
  reminderButtons,
  reminderEmbed,
  scheduleSpecOf,
} from './service';

const MAX_MESSAGE_LENGTH = 1500;

// ------------------------------------------------------------- 共通オプション

const messageOption: APIApplicationCommandOption = {
  type: ApplicationCommandOptionType.String,
  name: 'message',
  description: '通知する本文',
  required: true,
  max_length: MAX_MESSAGE_LENGTH,
};

/** 複数人メンション用に mention, mention2 … mention5 を並べる（MENTIONABLE は1つ1人なので） */
const MENTION_OPTION_NAMES = ['mention', 'mention2', 'mention3', 'mention4', 'mention5'] as const;

const mentionOptions: APIApplicationCommandOption[] = MENTION_OPTION_NAMES.map((name, i) => ({
  type: ApplicationCommandOptionType.Mentionable,
  name,
  description:
    i === 0
      ? 'メンションするユーザーまたはロール（mention2〜5 で追加できる）'
      : '追加でメンションするユーザーまたはロール',
}));

const everyoneOption: APIApplicationCommandOption = {
  type: ApplicationCommandOptionType.Boolean,
  name: 'everyone',
  description: '@everyone を付ける（mention より優先）',
};

const channelOption: APIApplicationCommandOption = {
  type: ApplicationCommandOptionType.Channel,
  name: 'channel',
  description: '投稿先（未指定ならこのチャンネル）',
};

const countOption: APIApplicationCommandOption = {
  type: ApplicationCommandOptionType.Integer,
  name: 'count',
  description: '繰り返し回数（未指定なら無限）',
  min_value: 1,
  max_value: 1000,
};

const idOption: APIApplicationCommandOption = {
  type: ApplicationCommandOptionType.String,
  name: 'id',
  description: '対象のリマインダー',
  required: true,
  autocomplete: true,
};

// ----------------------------------------------------------------- 定義

const definition = {
  name: 'remind',
  description: 'リマインダーを作成・確認・編集・削除する',
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'once',
      description: '1回だけ通知する',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'at',
          description: '日時。例: 09:00 / 10/01 09:00 / 2026-10-01 09:00 / 30m（30分後）',
          required: true,
        },
        messageOption,
        ...mentionOptions,
        everyoneOption,
        channelOption,
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'every',
      description: '一定の間隔で繰り返し通知する',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'interval',
          description: '頻度。例: 10m / 1h / 1d / 1w / 1h30m',
          required: true,
          autocomplete: true,
        },
        messageOption,
        countOption,
        {
          type: ApplicationCommandOptionType.String,
          name: 'start',
          description: '初回の日時（未指定なら「今から1周期後」）',
        },
        ...mentionOptions,
        everyoneOption,
        channelOption,
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'cron',
      description: '毎週月曜9時のような暦ベースの繰り返しを設定する',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'expr',
          description: 'cron式「分 時 日 月 曜」。例: 0 9 * * 1（毎週月曜9時）',
          required: true,
        },
        messageOption,
        countOption,
        ...mentionOptions,
        everyoneOption,
        channelOption,
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'list',
      description: 'リマインダーの一覧を表示する',
      options: [
        {
          type: ApplicationCommandOptionType.Boolean,
          name: 'mine',
          description: '自分が作ったものだけ表示する',
        },
        {
          type: ApplicationCommandOptionType.Boolean,
          name: 'all',
          description: '完了・失敗したものも含める',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'show',
      description: 'リマインダーの詳細を表示する',
      options: [idOption],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'edit',
      description: 'リマインダーを編集する',
      options: [
        idOption,
        { ...messageOption, required: false, description: '本文を差し替える' },
        {
          type: ApplicationCommandOptionType.String,
          name: 'when',
          description: 'スケジュールを差し替える（once=日時 / every=頻度 / cron=cron式）',
        },
        { ...countOption, description: '繰り返し回数を差し替える（0 で無限）', min_value: 0 },
        ...mentionOptions,
        everyoneOption,
        {
          type: ApplicationCommandOptionType.Boolean,
          name: 'mention_clear',
          description: 'メンションを外す',
        },
        channelOption,
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'pause',
      description: 'リマインダーを一時停止する',
      options: [idOption],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'resume',
      description: '一時停止したリマインダーを再開する',
      options: [idOption],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'delete',
      description: 'リマインダーを削除する',
      options: [idOption],
    },
  ],
} as const;

// --------------------------------------------------------------- ヘルパ

class UserError extends Error {}

function requireGuild(interaction: APIChatInputApplicationCommandInteraction): string {
  if (!interaction.guild_id) {
    throw new UserError('このコマンドはサーバー内でのみ使えます。');
  }
  return interaction.guild_id;
}

function actorId(interaction: APIChatInputApplicationCommandInteraction): string {
  const id = interaction.member?.user.id ?? interaction.user?.id;
  if (!id) throw new UserError('ユーザーを特定できませんでした。');
  return id;
}

function currentChannelId(interaction: APIChatInputApplicationCommandInteraction): string {
  const id = interaction.channel_id ?? interaction.channel?.id;
  if (!id) throw new UserError('チャンネルを特定できませんでした。');
  return id;
}

interface MentionInput {
  mentionType: MentionType;
  mentionUserIds: string[];
  mentionRoleIds: string[];
}

function readMention(
  interaction: APIChatInputApplicationCommandInteraction,
  options: Parameters<typeof getString>[0],
): MentionInput | undefined {
  const everyone = getBoolean(options, 'everyone');
  if (everyone) {
    return { mentionType: 'everyone', mentionUserIds: [], mentionRoleIds: [] };
  }
  const userIds = new Set<string>();
  const roleIds = new Set<string>();
  for (const name of MENTION_OPTION_NAMES) {
    const mentionable = getMentionable(interaction, options, name);
    if (!mentionable) continue;
    (mentionable.kind === 'role' ? roleIds : userIds).add(mentionable.id);
  }
  if (userIds.size === 0 && roleIds.size === 0) return undefined;
  return {
    mentionType: userIds.size > 0 ? 'users' : 'roles',
    mentionUserIds: [...userIds],
    mentionRoleIds: [...roleIds],
  };
}

function timeZoneOf(env: { DEFAULT_TIMEZONE: string }): string {
  return env.DEFAULT_TIMEZONE || 'Asia/Tokyo';
}

async function requireReminder(c: CommandContext, guildId: string): Promise<Reminder> {
  const { options } = resolveOptions(c.interaction.data.options);
  const idish = getString(options, 'id') ?? '';
  const reminder = await repo.findByIdish(c.env.DB, guildId, idish);
  if (!reminder)
    throw new UserError(
      `リマインダーが見つかりません: \`${idish.slice(0, 100)}\`\n\`id\` 欄は入力中に出る候補から選んでください（\`/remind list\` の ID 末尾6文字でも可）。`,
    );
  return reminder;
}

function ok(reminder: Reminder, heading: string): APIInteractionResponseCallbackData {
  return {
    content: heading,
    embeds: [reminderEmbed(reminder)],
    components: reminderButtons(reminder),
    flags: MessageFlags.Ephemeral,
  };
}

// --------------------------------------------------------------- 作成

async function create(
  c: CommandContext,
  kind: ScheduleKind,
): Promise<APIInteractionResponseCallbackData> {
  const guildId = requireGuild(c.interaction);
  const { options } = resolveOptions(c.interaction.data.options);
  const timeZone = timeZoneOf(c.env);
  const now = nowSeconds();

  const message = getString(options, 'message');
  if (!message || message.trim() === '') throw new UserError('本文が空です。');

  let expr: string;
  let nextFireAt: number;

  switch (kind) {
    case 'once': {
      const at = parseAt(getString(options, 'at') ?? '', timeZone, now);
      expr = String(at);
      nextFireAt = at;
      break;
    }
    case 'interval': {
      const interval = parseInterval(getString(options, 'interval') ?? '');
      expr = String(interval);
      const start = getString(options, 'start');
      nextFireAt = start ? parseAt(start, timeZone, now) : now + interval;
      break;
    }
    case 'cron': {
      const raw = (getString(options, 'expr') ?? '').trim();
      parseCron(raw); // 妥当性の検証
      expr = raw;
      nextFireAt = firstFireAt({ kind: 'cron', expr: raw, timeZone }, now);
      break;
    }
  }

  if (nextFireAt <= now) {
    throw new UserError('指定された日時が過去です。未来の日時を指定してください。');
  }

  const mention = readMention(c.interaction, options) ?? {
    mentionType: 'none' as const,
    mentionUserIds: [],
    mentionRoleIds: [],
  };

  const id = ulid(now * 1000);
  await repo.insert(c.env.DB, {
    id,
    guildId,
    channelId: getChannelId(options, 'channel') ?? currentChannelId(c.interaction),
    createdBy: actorId(c.interaction),
    message,
    mentionType: mention.mentionType,
    mentionUserIds: mention.mentionUserIds,
    mentionRoleIds: mention.mentionRoleIds,
    timeZone,
    scheduleKind: kind,
    scheduleExpr: expr,
    nextFireAt,
    maxCount: kind === 'once' ? 1 : (getInteger(options, 'count') ?? null),
    now,
  });

  const created = await repo.findByIdish(c.env.DB, guildId, id);
  if (!created) throw new UserError('作成に失敗しました。');
  return ok(created, '✅ リマインダーを作成しました。');
}

// --------------------------------------------------------------- 参照・編集

async function listReminders(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const guildId = requireGuild(c.interaction);
  const { options } = resolveOptions(c.interaction.data.options);
  const reminders = await repo.list(c.env.DB, {
    guildId,
    createdBy: getBoolean(options, 'mine') ? actorId(c.interaction) : undefined,
    includeInactive: getBoolean(options, 'all') ?? false,
    limit: 25,
  });
  return {
    content: `📋 リマインダー (${reminders.length}件)\n\n${listLines(reminders)}`,
    flags: MessageFlags.Ephemeral,
  };
}

async function show(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const guildId = requireGuild(c.interaction);
  const reminder = await requireReminder(c, guildId);
  return ok(reminder, '');
}

async function edit(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const guildId = requireGuild(c.interaction);
  const reminder = await requireReminder(c, guildId);
  const { options } = resolveOptions(c.interaction.data.options);
  const now = nowSeconds();

  const patch: repo.ReminderPatch = {};

  const message = getString(options, 'message');
  if (message !== undefined) {
    if (message.trim() === '') throw new UserError('本文が空です。');
    patch.message = message;
  }

  const channelId = getChannelId(options, 'channel');
  if (channelId !== undefined) patch.channelId = channelId;

  const count = getInteger(options, 'count');
  if (count !== undefined) patch.maxCount = count === 0 ? null : count;

  if (getBoolean(options, 'mention_clear')) {
    patch.mentionType = 'none';
    patch.mentionUserIds = [];
    patch.mentionRoleIds = [];
  } else {
    const mention = readMention(c.interaction, options);
    if (mention) {
      patch.mentionType = mention.mentionType;
      patch.mentionUserIds = mention.mentionUserIds;
      patch.mentionRoleIds = mention.mentionRoleIds;
    }
  }

  // スケジュールの差し替えは、既存の schedule_kind の意味で解釈する
  const when = getString(options, 'when');
  if (when !== undefined) {
    switch (reminder.scheduleKind) {
      case 'once': {
        const at = parseAt(when, reminder.timeZone, now);
        if (at <= now) throw new UserError('指定された日時が過去です。');
        patch.scheduleExpr = String(at);
        patch.nextFireAt = at;
        break;
      }
      case 'interval': {
        const interval = parseInterval(when);
        patch.scheduleExpr = String(interval);
        patch.nextFireAt = now + interval;
        break;
      }
      case 'cron': {
        const raw = when.trim();
        patch.scheduleExpr = raw;
        patch.nextFireAt = firstFireAt(
          { kind: 'cron', expr: raw, timeZone: reminder.timeZone },
          now,
        );
        break;
      }
    }
  }

  const changed = await repo.update(c.env.DB, guildId, reminder.id, patch, now);
  if (!changed) throw new UserError('変更する項目がありません。');

  const updated = await repo.findByIdish(c.env.DB, guildId, reminder.id);
  if (!updated) throw new UserError('更新後の取得に失敗しました。');
  return ok(updated, '✏️ 更新しました。');
}

async function setPaused(
  c: CommandContext,
  paused: boolean,
): Promise<APIInteractionResponseCallbackData> {
  const guildId = requireGuild(c.interaction);
  const reminder = await requireReminder(c, guildId);
  const now = nowSeconds();

  if (reminder.status === 'completed' || reminder.status === 'failed') {
    throw new UserError('このリマインダーは既に終了しています。');
  }

  const patch: repo.ReminderPatch = { status: paused ? 'paused' : 'active' };

  // 停止中に発火予定を過ぎていた場合、再開時は次の予定まで進めておく
  if (!paused) {
    const spec = scheduleSpecOf(reminder);
    if (reminder.nextFireAt !== null && reminder.nextFireAt <= now) {
      if (spec.kind === 'once') {
        throw new UserError(
          'この1回限りのリマインダーは予定時刻を過ぎています。作り直してください。',
        );
      }
      patch.nextFireAt = advanceSchedule(spec, reminder.nextFireAt, now).next;
    }
  }

  await repo.update(c.env.DB, guildId, reminder.id, patch, now);
  const updated = await repo.findByIdish(c.env.DB, guildId, reminder.id);
  if (!updated) throw new UserError('更新後の取得に失敗しました。');
  return ok(updated, paused ? '⏸️ 一時停止しました。' : '▶️ 再開しました。');
}

async function remove(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const guildId = requireGuild(c.interaction);
  const reminder = await requireReminder(c, guildId);
  await repo.remove(c.env.DB, guildId, reminder.id);
  return ephemeralText(
    `🗑️ 削除しました: \`${reminder.id}\`\n> ${reminder.message.slice(0, 200).replace(/\n/g, ' ')}`,
  );
}

// --------------------------------------------------------------- 入口

async function handler(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  try {
    switch (c.sub) {
      case 'once':
        return await create(c, 'once');
      case 'every':
        return await create(c, 'interval');
      case 'cron':
        return await create(c, 'cron');
      case 'list':
        return await listReminders(c);
      case 'show':
        return await show(c);
      case 'edit':
        return await edit(c);
      case 'pause':
        return await setPaused(c, true);
      case 'resume':
        return await setPaused(c, false);
      case 'delete':
        return await remove(c);
      default:
        return ephemeralText('未対応のサブコマンドです。');
    }
  } catch (error) {
    if (error instanceof UserError || error instanceof ScheduleError) {
      return ephemeralText(`⚠️ ${error.message}`);
    }
    console.error('/remind failed', c.sub, error);
    // 詳細は利用者に見せず、ログ（wrangler tail / ダッシュボード）で確認する
    return ephemeralText('予期しないエラーが発生しました。ログを確認してください。');
  }
}

// --------------------------------------------------------- オートコンプリート

const INTERVAL_SUGGESTIONS = ['10m', '30m', '1h', '3h', '6h', '12h', '1d', '1w', '1h30m'];

async function autocompleteHandler(c: AutocompleteContext) {
  if (c.focused === 'interval') {
    const value = c.value.trim();
    const matches = INTERVAL_SUGGESTIONS.filter((s) => s.startsWith(value.toLowerCase()));
    const choices = matches.map((s) => ({ name: s, value: s }));
    // 候補に無くても解釈できる入力ならそのまま採用できるようにする
    if (value !== '' && parseDuration(value) !== null && !matches.includes(value)) {
      choices.unshift({ name: `${value}（そのまま使う）`, value });
    }
    return autocomplete(choices);
  }

  if (c.focused === 'id') {
    const guildId = c.interaction.guild_id;
    if (!guildId) return autocomplete([]);
    const reminders = await repo.list(c.env.DB, { guildId, includeInactive: true, limit: 25 });
    const needle = c.value.trim().toLowerCase();
    const filtered = needle
      ? reminders.filter(
          (r) => r.id.toLowerCase().includes(needle) || r.message.toLowerCase().includes(needle),
        )
      : reminders;
    return autocomplete(filtered.map((r) => ({ name: autocompleteLabel(r), value: r.id })));
  }

  return autocomplete([]);
}

export const remindCommand: Command = {
  definition: definition as unknown as Command['definition'],
  // D1 の読み書きを伴うので defer してから PATCH する
  deferred: true,
  ephemeral: true,
  handler,
  autocomplete: autocompleteHandler,
};

export { describeSchedule };
