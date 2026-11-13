import {
  type APIApplicationCommandInteractionDataBasicOption,
  type APIApplicationCommandOption,
  type APIChatInputApplicationCommandInteraction,
  type APIInteractionResponseCallbackData,
  ApplicationCommandOptionType,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} from 'discord-api-types/v10';
import { encodeCustomId } from '../../core/customId';
import { resolveOptions } from '../../core/options';
import { ephemeralText } from '../../core/respond';
import type { CommandContext } from '../../core/types';
import { HabitInputError } from './dates';
import { FEATURE_NAME, HabitUserError } from './service';

export interface Actor {
  guildId: string;
  userId: string;
  options: APIApplicationCommandInteractionDataBasicOption[];
}

export function actor(interaction: APIChatInputApplicationCommandInteraction): Actor {
  const guildId = interaction.guild_id;
  if (!guildId) throw new HabitUserError('このコマンドはサーバー内でのみ使えます。');
  const userId = interaction.member?.user.id ?? interaction.user?.id;
  if (!userId) throw new HabitUserError('ユーザーを特定できませんでした。');
  return { guildId, userId, options: resolveOptions(interaction.data.options).options };
}

export function currentChannel(interaction: APIChatInputApplicationCommandInteraction): string {
  const id = interaction.channel_id ?? interaction.channel?.id;
  if (!id) throw new HabitUserError('チャンネルを特定できませんでした。');
  return id;
}

export function idOption(description: string): APIApplicationCommandOption {
  return {
    type: ApplicationCommandOptionType.String,
    name: 'id',
    description,
    required: true,
    autocomplete: true,
  };
}

export function ephemeral(
  content: string,
  extra: Partial<APIInteractionResponseCallbackData> = {},
) {
  return { content, flags: MessageFlags.Ephemeral, ...extra };
}

export function confirmDelete(action: string, id: string, label: string) {
  return ephemeral(
    `⚠️ ${label}を削除します。これまでの記録も消え、元に戻せません。よろしいですか？`,
    {
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Danger,
              label: '削除する',
              custom_id: encodeCustomId(FEATURE_NAME, action, id),
            },
            {
              type: ComponentType.Button,
              style: ButtonStyle.Secondary,
              label: 'やめる',
              custom_id: encodeCustomId(FEATURE_NAME, 'cancel'),
            },
          ],
        },
      ],
    },
  );
}

/** 想定内の入力ミスは本人にだけ表示し、それ以外はログに回す */
export function guarded(
  name: string,
  run: (c: CommandContext) => Promise<APIInteractionResponseCallbackData>,
): (c: CommandContext) => Promise<APIInteractionResponseCallbackData> {
  return async (c) => {
    try {
      return await run(c);
    } catch (error) {
      if (error instanceof HabitUserError || error instanceof HabitInputError) {
        return ephemeralText(`⚠️ ${error.message}`);
      }
      console.error(`/${name} failed`, c.sub, error);
      return ephemeralText('予期しないエラーが発生しました。ログを確認してください。');
    }
  };
}
