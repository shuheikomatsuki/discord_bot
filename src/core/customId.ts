/**
 * Discord の custom_id は 100 文字上限。JSON を詰めると破綻するので
 * `v1:<feature>:<action>:<arg>...` という固定の規約にする。
 * 100文字に収まらないデータは custom_id に入れず、ID から D1 で引き直すこと。
 */
const VERSION = 'v1';
const MAX_LENGTH = 100;
const SEPARATOR = ':';

export interface ParsedCustomId {
  feature: string;
  action: string;
  args: string[];
}

export function encodeCustomId(feature: string, action: string, ...args: string[]): string {
  const parts = [VERSION, feature, action, ...args];
  for (const part of parts) {
    if (part.includes(SEPARATOR)) {
      throw new Error(`custom_id の断片に "${SEPARATOR}" は使えません: ${part}`);
    }
  }
  const id = parts.join(SEPARATOR);
  if (id.length > MAX_LENGTH) {
    throw new Error(`custom_id が ${MAX_LENGTH} 文字を超えました (${id.length}): ${id}`);
  }
  return id;
}

export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(SEPARATOR);
  const [version, feature, action, ...args] = parts;
  if (version !== VERSION || !feature || !action) return null;
  return { feature, action, args };
}
