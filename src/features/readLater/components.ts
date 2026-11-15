import type { APIInteractionResponse } from 'discord-api-types/v10';
import { ephemeralText, reply, updateMessage } from '../../core/respond';
import { nowSeconds } from '../../core/time';
import type { ComponentContext, ComponentHandler } from '../../core/types';
import { loadConfig, type ReadLaterConfig } from './config';
import * as repo from './repository';
import type { Item } from './schema';
import { itemButtons, itemEmbed, resultLine, undoButtons } from './service';

const DAY = 24 * 60 * 60;
type Action = 'done' | 'snooze' | 'drop';

/**
 * ボタンの custom_id には ID しか入れず、実体は D1 から引き直す（reminder と同じ方針）。
 * 紹介メッセージは持ち主以外にも見えうるので、押せるのは持ち主だけにする。
 */
type Guarded = { error: APIInteractionResponse } | { config: ReadLaterConfig; item: Item };

async function guard(c: ComponentContext): Promise<Guarded> {
  const config = loadConfig(c.env);
  if (!config) return { error: reply(ephemeralText('「あとで読む」機能は無効になっています。')) };
  const userId = c.interaction.member?.user.id ?? c.interaction.user?.id;
  if (userId !== config.ownerId) {
    return { error: reply(ephemeralText('この記事を保存した人だけが操作できます。')) };
  }
  const id = c.args[0];
  const item = id ? await repo.findById(c.env.DB, id) : null;
  if (!item) return { error: reply(ephemeralText('この記事はもう見つかりません。')) };
  return { config, item };
}

const act =
  (action: Action): ComponentHandler =>
  async (c) => {
    const loaded = await guard(c);
    if ('error' in loaded) return loaded.error;
    const { config, item } = loaded;
    const now = nowSeconds();

    if (action === 'snooze') {
      await repo.snooze(c.env.DB, item.id, now + config.snoozeDays * DAY, now);
    } else {
      await repo.resolve(c.env.DB, item.id, action === 'done' ? 'done' : 'dropped', now);
    }

    const updated = (await repo.findById(c.env.DB, item.id)) ?? item;
    return updateMessage({
      content: resultLine(updated, action),
      embeds: [itemEmbed(updated, now)],
      components: undoButtons(updated, action),
    });
  };

const undo: ComponentHandler = async (c) => {
  const loaded = await guard(c);
  if ('error' in loaded) return loaded.error;
  const { config, item } = loaded;
  const now = nowSeconds();

  await repo.reopen(c.env.DB, item.id, c.args[1] === 'snooze', now);
  const updated = (await repo.findById(c.env.DB, item.id)) ?? item;
  return updateMessage({
    content: '↩️ 元に戻しました。',
    embeds: [itemEmbed(updated, now)],
    components: itemButtons(updated, config.snoozeDays),
  });
};

export const components: Record<string, ComponentHandler> = {
  done: act('done'),
  snooze: act('snooze'),
  drop: act('drop'),
  undo,
};
