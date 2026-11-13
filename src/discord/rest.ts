import type {
  APIInteractionResponseCallbackData,
  RESTPostAPIChannelMessageJSONBody,
} from 'discord-api-types/v10';

const API_BASE = 'https://discord.com/api/v10';

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Discord API ${status}: ${body.slice(0, 300)}`);
    this.name = 'DiscordApiError';
  }

  /**
   * 再試行しても無駄な失敗か。
   * 401 はここに含めない。Bot Token を入れ替えた直後などに全リマインダーが
   * 巻き添えで停止してしまうため、設定を直せば回復するものとして再試行させる。
   */
  get isPermanent(): boolean {
    return this.status === 400 || this.status === 403 || this.status === 404;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

async function request(
  method: string,
  path: string,
  init: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bot ${init.token}`;

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    const text = await response.text();
    const retryAfter = response.headers.get('retry-after');
    throw new DiscordApiError(
      response.status,
      text,
      retryAfter ? Number.parseFloat(retryAfter) : undefined,
    );
  }
  return response;
}

/** Bot Token を使ってチャンネルへ投稿する（cron からの配信で使う） */
export function createMessage(
  token: string,
  channelId: string,
  body: RESTPostAPIChannelMessageJSONBody,
): Promise<Response> {
  return request('POST', `/channels/${channelId}/messages`, { token, body });
}

/**
 * defer（type 5）したあとの本返信。
 * interaction token は 15 分有効で、Bot Token は不要。
 */
export function editOriginalInteractionResponse(
  applicationId: string,
  interactionToken: string,
  body: APIInteractionResponseCallbackData,
): Promise<Response> {
  return request('PATCH', `/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    body,
  });
}

export function putGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
  body: unknown,
): Promise<Response> {
  return request('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, {
    token,
    body,
  });
}

export async function getGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
): Promise<{ id: string; name: string; description?: string }[]> {
  const response = await request(
    'GET',
    `/applications/${applicationId}/guilds/${guildId}/commands`,
    {
      token,
    },
  );
  return response.json();
}

export async function getGlobalCommands(
  token: string,
  applicationId: string,
): Promise<{ id: string; name: string; description?: string }[]> {
  const response = await request('GET', `/applications/${applicationId}/commands`, { token });
  return response.json();
}

export function putGlobalCommands(
  token: string,
  applicationId: string,
  body: unknown,
): Promise<Response> {
  return request('PUT', `/applications/${applicationId}/commands`, { token, body });
}

/** Bot が投稿したメッセージを書き換える（締め切り後にボタンを外すなど） */
export function editMessage(
  token: string,
  channelId: string,
  messageId: string,
  body: RESTPostAPIChannelMessageJSONBody,
): Promise<Response> {
  return request('PATCH', `/channels/${channelId}/messages/${messageId}`, { token, body });
}

/** interaction へのフォローアップ（defer 後に本人だけへエラーを伝えるときなど） */
export function createFollowupMessage(
  applicationId: string,
  interactionToken: string,
  body: APIInteractionResponseCallbackData,
): Promise<Response> {
  return request('POST', `/webhooks/${applicationId}/${interactionToken}`, { body });
}
