/** 投稿本文から URL を取り出し、重複判定できる形に正規化する */

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
/** 文末の句読点や閉じ括弧は URL に含めない（「…これ https://a.com/x 。」対策） */
const TRAILING_PUNCTUATION = /[)\]}>.,!?;:'"、。！？」』）】]+$/u;

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'ref_src']);
const X_HOSTS = new Set([
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.com',
  'www.x.com',
  'mobile.x.com',
]);

export function extractUrls(content: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(URL_PATTERN)) {
    const normalized = normalizeUrl(match[0].replace(TRAILING_PUNCTUATION, ''));
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function normalizeUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  const isX = X_HOSTS.has(url.hostname.toLowerCase());
  if (isX) {
    url.hostname = 'x.com';
    // 共有ボタンが付ける ?s=20&t=... は記事の同一性に関係ない
    url.search = '';
  } else {
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || TRACKING_PARAMS.has(key)) url.searchParams.delete(key);
    }
  }
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }
  return url.toString();
}

/** x.com のポスト URL か（タイトル取得の方法を変えるため） */
export function isXStatusUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'x.com' && /^\/[^/]+\/status\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** 本文から URL を除いた残りをメモとして使う */
export function extractNote(content: string, maxLength = 200): string | null {
  const note = content.replace(URL_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (note === '') return null;
  return note.length > maxLength ? `${note.slice(0, maxLength - 1)}…` : note;
}
