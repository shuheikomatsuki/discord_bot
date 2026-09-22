import { AllowedMentionsTypes, type APIAllowedMentions } from 'discord-api-types/v10';

export type MentionType = 'none' | 'everyone' | 'here' | 'users' | 'roles';

export interface MentionSpec {
  type: MentionType;
  userIds: string[];
  roleIds: string[];
}

export interface BuiltMention {
  /** 本文の先頭に付ける文字列 */
  prefix: string;
  allowedMentions: APIAllowedMentions;
}

/**
 * content に <@123> と書くだけでは通知が飛ばないことがあるため allowed_mentions を必ず明示する。
 * どのケースでも parse を明示的に絞ることで、ユーザーが本文に書いた @everyone が
 * 意図せず発火するのを防ぐ（本文は信用しない）。
 */
export function buildMention(spec: MentionSpec): BuiltMention {
  switch (spec.type) {
    case 'everyone':
      return { prefix: '@everyone ', allowedMentions: { parse: [AllowedMentionsTypes.Everyone] } };
    case 'here':
      return { prefix: '@here ', allowedMentions: { parse: [AllowedMentionsTypes.Everyone] } };
    case 'users':
      return {
        prefix: `${spec.userIds.map((id) => `<@${id}>`).join(' ')} `,
        allowedMentions: { parse: [], users: spec.userIds },
      };
    case 'roles':
      return {
        prefix: `${spec.roleIds.map((id) => `<@&${id}>`).join(' ')} `,
        allowedMentions: { parse: [], roles: spec.roleIds },
      };
    case 'none':
      return { prefix: '', allowedMentions: { parse: [] } };
  }
}

/** /remind list などでの表示用 */
export function describeMention(spec: MentionSpec): string {
  switch (spec.type) {
    case 'everyone':
      return '@everyone';
    case 'here':
      return '@here';
    case 'users':
      return spec.userIds.map((id) => `<@${id}>`).join(' ');
    case 'roles':
      return spec.roleIds.map((id) => `<@&${id}>`).join(' ');
    case 'none':
      return 'なし';
  }
}
