import {
  type APIApplicationCommandAutocompleteResponse,
  type APIInteractionResponse,
  type APIInteractionResponseCallbackData,
  InteractionResponseType,
  MessageFlags,
} from 'discord-api-types/v10';

export function text(content: string): APIInteractionResponseCallbackData {
  return { content };
}

/** 本人にしか見えない返信。管理系コマンドはチャンネルを汚さないようこれを既定にする */
export function ephemeralText(content: string): APIInteractionResponseCallbackData {
  return { content, flags: MessageFlags.Ephemeral };
}

export function reply(data: APIInteractionResponseCallbackData): APIInteractionResponse {
  return { type: InteractionResponseType.ChannelMessageWithSource, data };
}

export function updateMessage(data: APIInteractionResponseCallbackData): APIInteractionResponse {
  return { type: InteractionResponseType.UpdateMessage, data };
}

export function deferred(ephemeral: boolean): APIInteractionResponse {
  return {
    type: InteractionResponseType.DeferredChannelMessageWithSource,
    data: ephemeral ? { flags: MessageFlags.Ephemeral } : {},
  };
}

export function pong(): APIInteractionResponse {
  return { type: InteractionResponseType.Pong };
}

export function autocomplete(
  choices: { name: string; value: string }[],
): APIApplicationCommandAutocompleteResponse {
  return {
    type: InteractionResponseType.ApplicationCommandAutocompleteResult,
    // Discord の上限は 25 件
    data: { choices: choices.slice(0, 25) },
  };
}
