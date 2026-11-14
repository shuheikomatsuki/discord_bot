/**
 * チェックインのボタン、メモ・振り返りのモーダル、削除確認ボタン。
 * custom_id には ID と日付だけを入れ、実体は D1 から引き直す。
 */
import {
  type APIInteractionResponse,
  type APIModalInteractionResponseCallbackData,
  type APIModalSubmitInteraction,
  ComponentType,
  InteractionResponseType,
  MessageFlags,
  TextInputStyle,
} from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { ephemeralText, reply, updateMessage } from '../../core/respond';
import { nowSeconds } from '../../core/time';
import type {
  ComponentContext,
  ComponentHandler,
  ModalContext,
  ModalHandler,
} from '../../core/types';
import { createFollowupMessage, editOriginalInteractionResponse } from '../../discord/rest';
import type { Env } from '../../env';
import { HabitInputError, parseAmount } from './dates';
import { XP } from './gamification';
import { answeredContent, formatNumber } from './render';
import type { SummaryKind } from './repository';
import * as repo from './repository';
import {
  answer,
  checkBadges,
  checkinButtons,
  FEATURE_NAME,
  grantXp,
  HabitUserError,
  todayOf,
} from './service';

function actorOf(interaction: {
  member?: { user: { id: string } };
  user?: { id: string };
}): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

const deferUpdate = (): APIInteractionResponse => ({
  type: InteractionResponseType.DeferredMessageUpdate,
});

function modal(data: APIModalInteractionResponseCallbackData): APIInteractionResponse {
  return { type: InteractionResponseType.Modal, data };
}

/** モーダルの入力値を custom_id で引く（Label / ActionRow のどちらの形でも読む） */
export function modalValues(interaction: APIModalSubmitInteraction): Map<string, string> {
  const values = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      custom_id?: string;
      value?: unknown;
      component?: unknown;
      components?: unknown[];
    };
    if (n.custom_id && typeof n.value === 'string') values.set(n.custom_id, n.value);
    if (n.component) visit(n.component);
    for (const child of n.components ?? []) visit(child);
  };
  for (const c of interaction.data.components ?? []) visit(c);
  return values;
}

function textField(
  id: string,
  label: string,
  opts: { required?: boolean; max?: number; paragraph?: boolean; value?: string | null } = {},
) {
  return {
    type: ComponentType.Label as const,
    label,
    component: {
      type: ComponentType.TextInput as const,
      custom_id: id,
      style: opts.paragraph === false ? TextInputStyle.Short : TextInputStyle.Paragraph,
      required: opts.required ?? false,
      max_length: opts.max ?? 500,
      ...(opts.value ? { value: opts.value } : {}),
    },
  };
}

// ================================================================ チェックイン

type Answer = 'done' | 'missed' | 'frozen';

/**
 * 本人確認と日付チェックをして、後続処理を waitUntil に回す。
 * D1 を何度も触るので、3秒ルールに引っかからないよう先に「処理中」を返しておく。
 */
async function loadForAnswer(
  env: Env,
  args: string[],
  userId: string | undefined,
): Promise<{ habitId: string; date: string } | string> {
  const [habitId, date] = args;
  if (!habitId || !date) return 'このボタンは古い形式です。';
  const habit = await repo.getHabit(env.DB, habitId);
  if (!habit) return 'この習慣はもう削除されています。';
  if (habit.userId !== userId) return `これは <@${habit.userId}> さんの習慣です。`;
  if (date !== todayOf(env, nowSeconds()))
    return 'この日の受付は締め切りました（1日の区切りは深夜0時です）。';
  return { habitId, date };
}

function runAnswer(
  c: ComponentContext | ModalContext,
  target: { habitId: string; date: string },
  status: Answer,
  note: string | null,
  amount: number | null = null,
): void {
  const { env, interaction } = c;
  c.ctx.waitUntil(
    (async () => {
      try {
        const habit = await repo.getHabit(env.DB, target.habitId);
        if (!habit) throw new HabitUserError('この習慣はもう削除されています。');
        const result = await answer(env, habit, target.date, status, note, nowSeconds(), amount);
        await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
          content: answeredContent(
            result.habit,
            target.date,
            result.checkin.status,
            result.checkin.note,
            result.summary,
            false,
            result.checkin.amount,
          ),
          components: checkinButtons(habit, target.date),
          allowed_mentions: { parse: [] },
        });
      } catch (error) {
        const message =
          error instanceof HabitUserError
            ? error.message
            : '記録に失敗しました。もう一度お試しください。';
        if (!(error instanceof HabitUserError)) console.error('habit answer failed', error);
        await createFollowupMessage(
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          ephemeralText(`⚠️ ${message}`),
        ).catch(() => {});
      }
    })(),
  );
}

const answerButton =
  (status: Answer): ComponentHandler =>
  async (c) => {
    const target = await loadForAnswer(c.env, c.args, actorOf(c.interaction));
    if (typeof target === 'string') return reply(ephemeralText(`⚠️ ${target}`));
    runAnswer(c, target, status, null);
    return deferUpdate();
  };

/** メモのフォーム。量を記録する習慣では量の欄を先頭に出し、メモは任意にする */
const noteButton: ComponentHandler = async (c) => {
  const target = await loadForAnswer(c.env, c.args, actorOf(c.interaction));
  if (typeof target === 'string') return reply(ephemeralText(`⚠️ ${target}`));
  const [habit, existing] = await Promise.all([
    repo.getHabit(c.env.DB, target.habitId),
    repo.getCheckin(c.env.DB, target.habitId, target.date),
  ]);
  const unit = habit?.unit ?? null;
  const fields = unit
    ? [
        textField(
          'amount',
          `量（${unit}）${habit?.dailyTarget != null ? ` 目安 ${formatNumber(habit.dailyTarget)}${unit}` : ''}`.slice(
            0,
            45,
          ),
          {
            required: true,
            max: 20,
            paragraph: false,
            value: existing?.amount != null ? formatNumber(existing.amount) : null,
          },
        ),
        textField('note', 'メモ（任意）', { max: 300, value: existing?.note }),
      ]
    : [textField('note', '今日のメモ', { required: true, max: 300, value: existing?.note })];
  return modal({
    custom_id: encodeCustomId(FEATURE_NAME, 'note', target.habitId, target.date),
    title: unit ? '📏 量を記録（達成）' : '📝 メモして記録（達成）',
    components: fields,
  });
};

const noteSubmit: ModalHandler = async (c) => {
  const target = await loadForAnswer(c.env, c.args, actorOf(c.interaction));
  if (typeof target === 'string') return reply(ephemeralText(`⚠️ ${target}`));
  const values = modalValues(c.interaction);
  const note = (values.get('note') ?? '').trim() || null;
  const rawAmount = (values.get('amount') ?? '').trim();
  let amount: number | null = null;
  if (rawAmount) {
    try {
      amount = parseAmount(rawAmount);
    } catch (error) {
      if (error instanceof HabitInputError) return reply(ephemeralText(`⚠️ ${error.message}`));
      throw error;
    }
  }
  runAnswer(c, target, 'done', note, amount);
  // ボタンのメッセージから開いたモーダルなので、元のメッセージを書き換えられる
  return deferUpdate();
};

// ================================================================ 振り返り

/** custom_id: v1:habit:reflect:<week|month>:<periodKey>:<userId> */
const reflectButton: ComponentHandler = async (c) => {
  const [period, key, ownerId] = c.args;
  if ((period !== 'week' && period !== 'month') || !key || !ownerId) {
    return reply(ephemeralText('このボタンは古い形式です。'));
  }
  if (actorOf(c.interaction) !== ownerId) {
    return reply(ephemeralText(`これは <@${ownerId}> さんの振り返りです。`));
  }
  const guildId = c.interaction.guild_id ?? '';
  const existing = await repo.getReflection(c.env.DB, guildId, ownerId, period, key);
  return modal({
    custom_id: encodeCustomId(FEATURE_NAME, 'reflect', period, key, ownerId),
    title: period === 'week' ? '📝 今週の振り返り' : '📝 今月の振り返り',
    components: [
      textField('good', 'うまくいったこと', { value: existing?.good }),
      textField('bad', 'うまくいかなかったこと・改善点', { value: existing?.bad }),
      textField('next', '次の期間にやること', { value: existing?.next }),
    ],
  });
};

const reflectSubmit: ModalHandler = async (c) => {
  const [period, key, ownerId] = c.args;
  const guildId = c.interaction.guild_id;
  if ((period !== 'week' && period !== 'month') || !key || !ownerId || !guildId) {
    return reply(ephemeralText('このフォームは古い形式です。'));
  }
  if (actorOf(c.interaction) !== ownerId) return reply(ephemeralText('本人だけが書けます。'));

  const values = modalValues(c.interaction);
  const pick = (k: string): string | null => (values.get(k) ?? '').trim() || null;
  const now = nowSeconds();
  const db = c.env.DB;
  await repo.ensureProfile(db, guildId, ownerId, now);
  const first = await repo.upsertReflection(db, {
    guildId,
    userId: ownerId,
    period: period as SummaryKind,
    periodKey: key,
    good: pick('good'),
    bad: pick('bad'),
    next: pick('next'),
    now,
  });

  const lines = ['📝 振り返りを保存しました。'];
  if (first) {
    const { leveledUpTo } = await grantXp(db, guildId, ownerId, XP.reflection, now);
    lines.push(`+${XP.reflection}XP`);
    if (leveledUpTo !== null) lines.push(`⬆️ レベル${leveledUpTo} になりました！`);
    const badges = await checkBadges(
      db,
      guildId,
      ownerId,
      { reflections: await repo.countReflections(db, guildId, ownerId) },
      now,
    );
    if (badges.length > 0) lines.push(`🎖️ 新しいバッジを獲得しました（/stats profile で確認）`);
  }
  return reply(ephemeralText(lines.join('\n')));
};

// ================================================================ 削除確認

const deleteHabit: ComponentHandler = async (c) => {
  const [id] = c.args;
  const guildId = c.interaction.guild_id;
  const userId = actorOf(c.interaction);
  if (!id || !guildId || !userId) return reply(ephemeralText('このボタンは古い形式です。'));
  const habit = await repo.findHabit(c.env.DB, guildId, userId, id);
  if (!habit)
    return updateMessage({
      content: 'この習慣はもうありません。',
      components: [],
      flags: MessageFlags.Ephemeral,
    });
  await repo.deleteHabit(c.env.DB, habit.id);
  return updateMessage({
    content: `🗑️ 習慣「${habit.name}」と記録を削除しました。`,
    components: [],
    flags: MessageFlags.Ephemeral,
  });
};

const deleteGoal: ComponentHandler = async (c) => {
  const [id] = c.args;
  const guildId = c.interaction.guild_id;
  const userId = actorOf(c.interaction);
  if (!id || !guildId || !userId) return reply(ephemeralText('このボタンは古い形式です。'));
  const goal = await repo.findGoal(c.env.DB, guildId, userId, id);
  if (!goal)
    return updateMessage({
      content: 'この目標はもうありません。',
      components: [],
      flags: MessageFlags.Ephemeral,
    });
  await repo.deleteGoal(c.env.DB, goal.id);
  return updateMessage({
    content: `🗑️ 目標「${goal.name}」と記録を削除しました。`,
    components: [],
    flags: MessageFlags.Ephemeral,
  });
};

const cancel: ComponentHandler = async () =>
  updateMessage({ content: 'キャンセルしました。', components: [], flags: MessageFlags.Ephemeral });

export const components: Record<string, ComponentHandler> = {
  done: answerButton('done'),
  miss: answerButton('missed'),
  freeze: answerButton('frozen'),
  note: noteButton,
  reflect: reflectButton,
  delhabit: deleteHabit,
  delgoal: deleteGoal,
  cancel,
};

export const modals: Record<string, ModalHandler> = {
  note: noteSubmit,
  reflect: reflectSubmit,
};
