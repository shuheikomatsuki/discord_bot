import { isXStatusUrl } from './urls';

/** 記事タイトルの取得。失敗しても紹介自体は続けたいので、例外は投げずに null を返す */

const TIMEOUT_MS = 5000;
/** <head> にタイトルがあれば十分なので、巨大なページを全部は読まない */
const MAX_BYTES = 256 * 1024;
const MAX_TITLE_LENGTH = 200;
const USER_AGENT = 'Mozilla/5.0 (compatible; read-later-bot/1.0)';

export async function fetchTitle(url: string): Promise<string | null> {
  try {
    return isXStatusUrl(url) ? await fetchXTitle(url) : await fetchHtmlTitle(url);
  } catch (error) {
    console.warn('readLater: title fetch failed', url, error);
    return null;
  }
}

/**
 * x.com はログインしないとページを見られないので、公開の oEmbed（認証不要・無料）で
 * 投稿者名と本文を取る。鍵アカウントや削除済みのポストは取れない。
 */
async function fetchXTitle(url: string): Promise<string | null> {
  const endpoint = `https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const data = (await response.json()) as { author_name?: string; html?: string };
  const paragraph = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(data.html ?? '')?.[1];
  const body = paragraph ? cleanText(paragraph.replace(/<br\s*\/?>/gi, ' ')) : '';
  if (!data.author_name && !body) return null;
  return truncate(body ? `${data.author_name ?? 'X'}「${body}」` : `${data.author_name} のポスト`);
}

async function fetchHtmlTitle(url: string): Promise<string | null> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok || !(response.headers.get('content-type') ?? '').includes('html')) return null;
  return extractTitle(await readHead(response));
}

async function readHead(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = '';
  let bytes = 0;
  while (bytes < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  await reader.cancel().catch(() => {});
  return html;
}

/** og:title を優先し、無ければ <title> */
export function extractTitle(html: string): string | null {
  const og =
    /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(html)?.[1];
  const title = og ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  if (!title) return null;
  const cleaned = cleanText(title);
  return cleaned ? truncate(cleaned) : null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function cleanText(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string): string {
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}
