import type {
  APIInteractionResponseCallbackData,
  APIMessage,
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
 * チャンネルの履歴を取る。`after` を渡すとその ID より新しいものを最大 `limit` 件返す
 * （返る配列の並びは新しい順なので、呼び出し側で並べ直すこと）。
 * 本文を読むには Developer Portal で Message Content Intent を ON にしておく必要がある。
 */
export async function getChannelMessages(
  token: string,
  channelId: string,
  query: { after?: string; limit?: number } = {},
): Promise<APIMessage[]> {
  const params = new URLSearchParams();
  if (query.after) params.set('after', query.after);
  params.set('limit', String(query.limit ?? 100));
  const response = await request('GET', `/channels/${channelId}/messages?${params}`, { token });
  return response.json();
}

export async function getChannel(
  token: string,
  channelId: string,
): Promise<{ id: string; guild_id?: string; name?: string }> {
  const response = await request('GET', `/channels/${channelId}`, { token });
  return response.json();
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
