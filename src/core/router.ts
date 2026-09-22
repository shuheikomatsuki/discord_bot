import {
  type APIInteraction,
  type APIInteractionResponse,
  InteractionType,
} from 'discord-api-types/v10';
import { editOriginalInteractionResponse } from '../discord/rest';
import type { Env } from '../env';
import { parseCustomId } from './customId';
import { getFocused, resolveOptions } from './options';
import { commandMap, componentMap, modalMap } from './registry';
import { autocomplete, deferred, ephemeralText, pong, reply } from './respond';

export async function handleInteraction(
  interaction: APIInteraction,
  env: Env,
  ctx: ExecutionContext,
): Promise<APIInteractionResponse> {
  switch (interaction.type) {
    case InteractionType.Ping:
      return pong();

    case InteractionType.ApplicationCommand: {
      if (!('options' in interaction.data) && interaction.data.type !== 1) {
        return reply(ephemeralText('このコマンドの種類には未対応です。'));
      }
      const command = commandMap.get(interaction.data.name);
      if (!command) {
        return reply(ephemeralText(`未知のコマンドです: /${interaction.data.name}`));
      }
      // biome-ignore lint/suspicious/noExplicitAny: ChatInput であることは commandMap 側で保証している
      const chatInput = interaction as any;
      const { sub } = resolveOptions(chatInput.data.options);
      const context = { env, ctx, interaction: chatInput, sub };

      if (!command.deferred) {
        return reply(await command.handler(context));
      }

      // 3秒ルール対策: 先に「考え中…」を返し、本処理は waitUntil で継続する
      ctx.waitUntil(
        (async () => {
          try {
            const data = await command.handler(context);
            await editOriginalInteractionResponse(
              env.DISCORD_APPLICATION_ID,
              interaction.token,
              data,
            );
          } catch (error) {
            console.error('deferred command failed', interaction.data.name, error);
            await editOriginalInteractionResponse(env.DISCORD_APPLICATION_ID, interaction.token, {
              content: `エラーが発生しました: ${errorMessage(error)}`,
            }).catch(() => {});
          }
        })(),
      );
      return deferred(command.ephemeral ?? true);
    }

    case InteractionType.ApplicationCommandAutocomplete: {
      const command = commandMap.get(interaction.data.name);
      if (!command?.autocomplete) return autocomplete([]);
      const { sub } = resolveOptions(interaction.data.options);
      const focused = getFocused(interaction);
      try {
        return await command.autocomplete({
          env,
          ctx,
          interaction,
          sub,
          focused: focused.name,
          value: focused.value,
        });
      } catch (error) {
        console.error('autocomplete failed', error);
        return autocomplete([]);
      }
    }

    case InteractionType.MessageComponent: {
      const parsed = parseCustomId(interaction.data.custom_id);
      if (!parsed)
        return reply(
          ephemeralText('このボタンは古い形式です。もう一度コマンドを実行してください。'),
        );
      const handler = componentMap.get(`${parsed.feature}:${parsed.action}`);
      if (!handler) return reply(ephemeralText('このボタンはもう使えません。'));
      return handler({ env, ctx, interaction, args: parsed.args });
    }

    case InteractionType.ModalSubmit: {
      const parsed = parseCustomId(interaction.data.custom_id);
      if (!parsed) return reply(ephemeralText('このフォームは古い形式です。'));
      const handler = modalMap.get(`${parsed.feature}:${parsed.action}`);
      if (!handler) return reply(ephemeralText('このフォームはもう使えません。'));
      return handler({ env, ctx, interaction, args: parsed.args });
    }

    default:
      return reply(ephemeralText('未対応の interaction です。'));
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
