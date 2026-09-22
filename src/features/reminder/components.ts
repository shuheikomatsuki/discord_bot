import { MessageFlags } from 'discord-api-types/v10';
import { ephemeralText, reply, updateMessage } from '../../core/respond';
import { nowSeconds } from '../../core/time';
import type { ComponentContext, ComponentHandler } from '../../core/types';
import * as repo from './repository';
import { advanceSchedule } from './schedule';
import { reminderButtons, reminderEmbed, scheduleSpecOf } from './service';

/**
 * ボタンの custom_id には ID しか入れず、実体は D1 から引き直す。
 * custom_id は 100 文字上限なので、この方針を崩さないこと。
 */
async function load(c: ComponentContext) {
  const guildId = c.interaction.guild_id;
  const id = c.args[0];
  if (!guildId || !id) return null;
  return repo.findByIdish(c.env.DB, guildId, id);
}

const setStatus =
  (paused: boolean): ComponentHandler =>
  async (c) => {
    const reminder = await load(c);
    if (!reminder) return reply(ephemeralText('このリマインダーはもうありません。'));
    if (reminder.status === 'completed' || reminder.status === 'failed') {
      return reply(ephemeralText('このリマインダーは既に終了しています。'));
    }

    const now = nowSeconds();
    const patch: repo.ReminderPatch = { status: paused ? 'paused' : 'active' };

    if (!paused && reminder.nextFireAt !== null && reminder.nextFireAt <= now) {
      const spec = scheduleSpecOf(reminder);
      if (spec.kind === 'once') {
        return reply(
          ephemeralText('この1回限りのリマインダーは予定時刻を過ぎています。作り直してください。'),
        );
      }
      patch.nextFireAt = advanceSchedule(spec, reminder.nextFireAt, now).next;
    }

    await repo.update(c.env.DB, reminder.guildId, reminder.id, patch, now);
    const updated = await repo.findByIdish(c.env.DB, reminder.guildId, reminder.id);
    if (!updated) return reply(ephemeralText('更新後の取得に失敗しました。'));

    return updateMessage({
      content: paused ? '⏸️ 一時停止しました。' : '▶️ 再開しました。',
      embeds: [reminderEmbed(updated)],
      components: reminderButtons(updated),
      flags: MessageFlags.Ephemeral,
    });
  };

const remove: ComponentHandler = async (c) => {
  const reminder = await load(c);
  if (!reminder) return reply(ephemeralText('このリマインダーはもうありません。'));
  await repo.remove(c.env.DB, reminder.guildId, reminder.id);
  return updateMessage({
    content: `🗑️ 削除しました: \`${reminder.id}\``,
    embeds: [],
    components: [],
    flags: MessageFlags.Ephemeral,
  });
};

export const components: Record<string, ComponentHandler> = {
  pause: setStatus(true),
  resume: setStatus(false),
  delete: remove,
};
