import {
  type APIApplicationCommandAutocompleteInteraction,
  type APIApplicationCommandInteractionDataBasicOption,
  type APIApplicationCommandInteractionDataOption,
  type APIChatInputApplicationCommandInteraction,
  ApplicationCommandOptionType,
} from 'discord-api-types/v10';

export interface ResolvedOptions {
  /** サブコマンド名。`/remind once` なら 'once' */
  sub: string | undefined;
  options: APIApplicationCommandInteractionDataBasicOption[];
}

/** サブコマンド / サブコマンドグループを剥がして、実際のオプション配列を取り出す */
export function resolveOptions(
  raw: APIApplicationCommandInteractionDataOption[] | undefined,
): ResolvedOptions {
  let sub: string | undefined;
  let current = raw ?? [];

  const group = current[0];
  if (group && group.type === ApplicationCommandOptionType.SubcommandGroup) {
    current = group.options ?? [];
  }

  const first = current[0];
  if (first && first.type === ApplicationCommandOptionType.Subcommand) {
    sub = first.name;
    current = first.options ?? [];
  }

  return { sub, options: current as APIApplicationCommandInteractionDataBasicOption[] };
}

function find(
  options: APIApplicationCommandInteractionDataBasicOption[],
  name: string,
): APIApplicationCommandInteractionDataBasicOption | undefined {
  return options.find((o) => o.name === name);
}

export function getString(
  options: APIApplicationCommandInteractionDataBasicOption[],
  name: string,
): string | undefined {
  const option = find(options, name);
  return option?.type === ApplicationCommandOptionType.String ? String(option.value) : undefined;
}

export function getInteger(
  options: APIApplicationCommandInteractionDataBasicOption[],
  name: string,
): number | undefined {
  const option = find(options, name);
  return option?.type === ApplicationCommandOptionType.Integer ? Number(option.value) : undefined;
}

export function getBoolean(
  options: APIApplicationCommandInteractionDataBasicOption[],
  name: string,
): boolean | undefined {
  const option = find(options, name);
  return option?.type === ApplicationCommandOptionType.Boolean ? option.value : undefined;
}

export function getChannelId(
  options: APIApplicationCommandInteractionDataBasicOption[],
  name: string,
): string | undefined {
  const option = find(options, name);
  return option?.type === ApplicationCommandOptionType.Channel ? option.value : undefined;
}

export type MentionableKind = 'user' | 'role';

/**
 * MENTIONABLE 型オプションの中身。ユーザーとロールのどちらが選ばれたかは
 * interaction.data.resolved を見ないと判別できない。
 */
export function getMentionable(
  interaction: APIChatInputApplicationCommandInteraction,
  options: APIApplicationCommandInteractionDataBasicOption[],
  name: string,
): { kind: MentionableKind; id: string } | undefined {
  const option = find(options, name);
  if (!option) return undefined;
  if (
    option.type !== ApplicationCommandOptionType.Mentionable &&
    option.type !== ApplicationCommandOptionType.User &&
    option.type !== ApplicationCommandOptionType.Role
  ) {
    return undefined;
  }
  const id = option.value;
  const resolved = interaction.data.resolved;
  if (resolved?.roles && id in resolved.roles) return { kind: 'role', id };
  return { kind: 'user', id };
}

export interface FocusedOption {
  name: string;
  value: string;
}

export function getFocused(
  interaction: APIApplicationCommandAutocompleteInteraction,
): FocusedOption {
  const { options } = resolveOptions(interaction.data.options);
  for (const option of options) {
    if ('focused' in option && option.focused) {
      return { name: option.name, value: String(option.value ?? '') };
    }
  }
  return { name: '', value: '' };
}
