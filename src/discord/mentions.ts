import { AllowedMentionsTypes, type APIAllowedMentions } from 'discord-api-types/v10';

/** users / roles は歴史的な区別で、どちらでも userIds と roleIds の両方をメンションする（混在可） */
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
    case 'roles': {
      const tags = mentionTags(spec);
      if (tags === '') return { prefix: '', allowedMentions: { parse: [] } };
      return {
        prefix: `${tags} `,
        allowedMentions: {
          parse: [],
          ...(spec.userIds.length > 0 && { users: spec.userIds }),
          ...(spec.roleIds.length > 0 && { roles: spec.roleIds }),
        },
      };
    }
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
    case 'roles':
      return mentionTags(spec) || 'なし';
    case 'none':
      return 'なし';
  }
}

function mentionTags(spec: MentionSpec): string {
  return [...spec.userIds.map((id) => `<@${id}>`), ...spec.roleIds.map((id) => `<@&${id}>`)].join(
    ' ',
  );
}
