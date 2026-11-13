import {
  type APIInteractionResponseCallbackData,
  ApplicationCommandOptionType,
  ApplicationCommandType,
} from 'discord-api-types/v10';
import { getBoolean, getNumber, getString } from '../../core/options';
import { autocomplete } from '../../core/respond';
import { nowSeconds } from '../../core/time';
import type { AutocompleteContext, Command, CommandContext } from '../../core/types';
import { ulid } from '../../core/ulid';
import { actor, confirmDelete, ephemeral, guarded, idOption } from './context';
import { parseDateInput } from './dates';
import { levelInfo, XP } from './gamification';
import { formatNumber, goalAutocompleteLabel, goalDetail, goalLine } from './render';
import * as repo from './repository';
import { type Goal, goalReached } from './schema';
import { checkBadges, grantXp, HabitUserError, todayOf } from './service';

const MAX_GOALS = 20;
const goalId = idOption('対象の目標');

const definition = {
  name: 'goal',
  description: '目標を立てて進捗を記録する',
  type: ApplicationCommandType.ChatInput,
  options: [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'add',
      description: '目標を登録する（数値目標にも、達成/未達成だけの目標にもできる）',
      options: [
        {
          type: ApplicationCommandOptionType.String,
          name: 'name',
          description: '目標の名前。例: TOEIC 800点',
          required: true,
          max_length: 80,
        },
        {
          type: ApplicationCommandOptionType.Number,
          name: 'target',
          description: '目標値。例: 800（未指定なら達成/未達成だけの目標）',
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'unit',
          description: '単位。例: 点 / km / 冊 / 時間',
          max_length: 10,
        },
        {
          type: ApplicationCommandOptionType.Number,
          name: 'start',
          description: '開始値（既定 0）。減らす目標なら現在の値。例: 体重 70',
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'deadline',
          description: '期限。例: 2027-03-31 / 12/31 / 90d',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'log',
      description: '進捗を記録する',
      options: [
        goalId,
        {
          type: ApplicationCommandOptionType.Number,
          name: 'value',
          description: '記録する値',
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'mode',
          description: '足すか、現在値として上書きするか（既定: 足す）',
          choices: [
            { name: '足す（例: 今日 5km 走った）', value: 'add' },
            { name: '現在値にする（例: 体重 68.5kg / 模試 720点）', value: 'set' },
          ],
        },
        {
          type: ApplicationCommandOptionType.String,
          name: 'note',
          description: 'メモ',
          max_length: 200,
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'list',
      description: '目標の一覧',
      options: [
        {
          type: ApplicationCommandOptionType.Boolean,
          name: 'all',
          description: '達成済みも表示する',
        },
      ],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'show',
      description: '目標の詳細と推移',
      options: [goalId],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'complete',
      description: '目標を達成にする',
      options: [goalId],
    },
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: 'delete',
      description: '目標と記録を削除する',
      options: [goalId],
    },
  ],
} as const;

async function requireGoal(c: CommandContext): Promise<Goal> {
  const { guildId, userId, options } = actor(c.interaction);
  const idish = getString(options, 'id') ?? '';
  const goal = await repo.findGoal(c.env.DB, guildId, userId, idish);
  if (!goal) {
    throw new HabitUserError(
      `目標が見つかりません: \`${idish.slice(0, 50)}\`\n\`id\` 欄は入力中に出る候補から選んでください。`,
    );
  }
  return goal;
}

/** 目標を達成にして XP とバッジを付ける。既に達成済みなら null */
async function celebrate(c: CommandContext, goal: Goal, now: number): Promise<string[] | null> {
  const db = c.env.DB;
  if (!(await repo.completeGoal(db, goal.id, now))) return null;
  const { xp, leveledUpTo } = await grantXp(db, goal.guildId, goal.userId, XP.goalComplete, now);
  const badges = await checkBadges(
    db,
    goal.guildId,
    goal.userId,
    {
      goalsCompleted: await repo.countCompletedGoals(db, goal.guildId, goal.userId),
      level: levelInfo(xp).level,
    },
    now,
  );
  const lines = [`🎉 **目標達成おめでとう！** +${XP.goalComplete}XP`];
  if (leveledUpTo !== null) lines.push(`⬆️ レベル${leveledUpTo} になりました！`);
  if (badges.length > 0) lines.push('🎖️ 新しいバッジを獲得しました（`/stats profile`）');
  return lines;
}

async function add(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId, options } = actor(c.interaction);
  const now = nowSeconds();
  const name = (getString(options, 'name') ?? '').trim();
  if (!name) throw new HabitUserError('名前が空です。');
  const targetValue = getNumber(options, 'target') ?? null;
  const startValue = getNumber(options, 'start') ?? 0;
  if (targetValue !== null && targetValue === startValue) {
    throw new HabitUserError('目標値と開始値が同じです。');
  }
  const deadlineInput = getString(options, 'deadline');
  const today = todayOf(c.env, now);
  const deadline = deadlineInput ? parseDateInput(deadlineInput, today) : null;
  if (deadline && deadline < today) throw new HabitUserError('期限が過去です。');

  const existing = await repo.listGoals(c.env.DB, guildId, userId, false);
  if (existing.length >= MAX_GOALS)
    throw new HabitUserError(`進行中の目標は1人 ${MAX_GOALS} 個までです。`);

  const id = ulid(now * 1000);
  await repo.ensureProfile(c.env.DB, guildId, userId, now);
  await repo.insertGoal(c.env.DB, {
    id,
    guildId,
    userId,
    name,
    unit: getString(options, 'unit')?.trim() ?? '',
    startValue,
    targetValue,
    deadline,
    now,
  });
  const goal = await repo.findGoal(c.env.DB, guildId, userId, id);
  if (!goal) throw new Error('作成した目標を取得できませんでした');
  const hint =
    targetValue === null
      ? '達成したら `/goal complete` で記録しましょう。'
      : '進んだら `/goal log` で記録しましょう。目標値に届くと自動で達成になります。';
  return ephemeral(`🚩 目標を登録しました。\n${goalLine(goal)}\n\n${hint}`);
}

async function log(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const goal = await requireGoal(c);
  const { options } = actor(c.interaction);
  if (goal.status === 'completed') throw new HabitUserError('この目標は達成済みです。');
  const value = getNumber(options, 'value');
  if (value === undefined) throw new HabitUserError('値を指定してください。');
  const mode = getString(options, 'mode') === 'set' ? 'set' : 'add';
  const note = getString(options, 'note')?.trim() || null;

  const db = c.env.DB;
  const now = nowSeconds();
  const today = todayOf(c.env, now);
  const after = mode === 'add' ? goal.current + value : value;

  // XP は 1目標につき1日1回まで（連打で稼げないように）
  const firstToday = (await repo.countGoalLogsOn(db, goal.id, today)) === 0;
  await repo.insertGoalLog(db, {
    id: ulid(now * 1000),
    goal,
    date: today,
    mode,
    value,
    after,
    note,
    now,
  });
  await repo.setGoalCurrent(db, goal.id, after, now);
  const updated: Goal = { ...goal, current: after };

  const lines = [
    `📈 記録しました: ${mode === 'add' ? `+${formatNumber(value)}` : `=${formatNumber(value)}`}${goal.unit}`,
  ];
  if (firstToday) {
    const { leveledUpTo } = await grantXp(db, goal.guildId, goal.userId, XP.goalLog, now);
    lines[0] += ` · +${XP.goalLog}XP`;
    if (leveledUpTo !== null) lines.push(`⬆️ レベル${leveledUpTo} になりました！`);
  }
  lines.push(goalLine(updated));

  if (goalReached(updated)) {
    const party = await celebrate(c, updated, now);
    if (party) lines.push('', ...party);
  }
  return ephemeral(lines.join('\n'));
}

async function list(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const { guildId, userId, options } = actor(c.interaction);
  const goals = await repo.listGoals(
    c.env.DB,
    guildId,
    userId,
    getBoolean(options, 'all') ?? false,
  );
  if (goals.length === 0) return ephemeral('目標はまだありません。`/goal add` で登録しましょう。');
  return ephemeral(`🚩 **目標（${goals.length}件）**\n${goals.map(goalLine).join('\n')}`);
}

async function show(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const goal = await requireGoal(c);
  const logs = await repo.goalLogs(c.env.DB, goal.id, 30);
  return ephemeral(goalDetail(goal, logs, todayOf(c.env, nowSeconds())));
}

async function complete(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const goal = await requireGoal(c);
  const party = await celebrate(c, goal, nowSeconds());
  if (!party) throw new HabitUserError('この目標は既に達成済みです。');
  return ephemeral([`🏁 **${goal.name}**`, ...party].join('\n'));
}

async function remove(c: CommandContext): Promise<APIInteractionResponseCallbackData> {
  const goal = await requireGoal(c);
  return confirmDelete('delgoal', goal.id, `目標「${goal.name}」`);
}

const handler = guarded('goal', async (c) => {
  switch (c.sub) {
    case 'add':
      return add(c);
    case 'log':
      return log(c);
    case 'list':
      return list(c);
    case 'show':
      return show(c);
    case 'complete':
      return complete(c);
    case 'delete':
      return remove(c);
    default:
      return ephemeral('未対応のサブコマンドです。');
  }
});

async function autocompleteHandler(c: AutocompleteContext) {
  if (c.focused !== 'id') return autocomplete([]);
  const guildId = c.interaction.guild_id;
  const userId = c.interaction.member?.user.id ?? c.interaction.user?.id;
  if (!guildId || !userId) return autocomplete([]);
  // log / complete は進行中だけ、show / delete は達成済みも候補に出す
  const includeCompleted = c.sub === 'show' || c.sub === 'delete';
  const goals = await repo.listGoals(c.env.DB, guildId, userId, includeCompleted);
  const needle = c.value.trim().toLowerCase();
  return autocomplete(
    goals
      .filter(
        (g) =>
          !needle || g.name.toLowerCase().includes(needle) || g.id.toLowerCase().includes(needle),
      )
      .map((g) => ({ name: goalAutocompleteLabel(g), value: g.id })),
  );
}

export const goalCommand: Command = {
  definition: definition as unknown as Command['definition'],
  deferred: true,
  ephemeral: true,
  handler,
  autocomplete: autocompleteHandler,
};
