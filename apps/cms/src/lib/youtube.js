/** YouTube editor input parsing. Shared by the CMS and the newsroom; never return a supplied URL. */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const YOUTUBE_START_MAX = 2147483647;
export const YOUTUBE_INPUT_MESSAGE = 'Enter a YouTube video link or an 11-character video ID.';

/** @param {unknown} value */
export function isYoutubeStartSeconds(value) {
  return value == null || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= YOUTUBE_START_MAX);
}

/** @param {string} value */
function parseTime(value) {
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return isYoutubeStartSeconds(seconds) ? seconds : null;
  }
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(value);
  if (!match || !match[0]) return null;
  const seconds = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return isYoutubeStartSeconds(seconds) ? seconds : null;
}

/**
 * @param {unknown} value Pasted URL or bare ID.
 * @returns {{videoId: string, startSeconds?: number} | null}
 */
export function parseYoutubeInput(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (YOUTUBE_ID_RE.test(input)) return { videoId: input };
  if (!input || input.length > 2048) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id;
  if (host === 'youtu.be') {
    id = /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
    else id = /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !YOUTUBE_ID_RE.test(id)) return null;
  const times = url.searchParams.getAll('t');
  if (times.length > 1) return null;
  if (times.length) {
    const startSeconds = parseTime(times[0]);
    if (startSeconds === null) return null;
    return { videoId: id, startSeconds };
  }
  return { videoId: id };
}
