import { publicOrigin } from './public-url.js';

export const COMMENTS_PAGE_SIZE = 100;
export const COMMENTS_MAX_PAGES = 20;
const MAX_BYTES = 2 * 1024 * 1024;
export class CommentsReadError extends Error {
  constructor(type, status = 0, retryAfter = 0) { super('Archived comments are unavailable'); Object.assign(this, { type, status, retryAfter }); }
}
export function publicCommentId(value) {
  const text = String(value ?? '');
  return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? text : '';
}
export function publicCommentsEndpoint(value) {
  try {
    const url = new URL(value);
    return publicOrigin(value) && !url.search && !url.hash && url.pathname.endsWith('/api/legacy-comments') ? url.href : '';
  } catch { return ''; }
}
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
function commentDate(value) {
  const parts=typeof value === 'string' && value.match(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/);
  if (!parts) return '';
  const year=Number(parts[1]), month=Number(parts[2]), day=Number(parts[3]);
  const leap=year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > [31,leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31][month-1]) return '';
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '';
}
export function normalizePublicComment(value) {
  if (!value || typeof value !== 'object' || (value.status !== undefined && value.status !== 'approved')) return null;
  const id = publicCommentId(value.id), authorName = text(value.authorName, 120), content = text(value.content, 5000);
  const date=commentDate(value.commentedAt);
  if (!id || !authorName || !content || !date) return null;
  // Explicit public projection: no email, website, IP or arbitrary CMS field survives.
  return { id, authorName, content, commentedAt: date, parentLegacyId: publicCommentId(value.parentLegacyId) || null };
}
function retryAfter(value) {
  const seconds = /^\d+$/.test(value || '') ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(86400, seconds) : 60;
}
async function limitedJson(response, wait) {
  if (Number(response.headers.get('Content-Length')) > MAX_BYTES) throw new CommentsReadError('response');
  if (!response.body?.getReader) throw new CommentsReadError('response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const {done, value} = await wait(reader.read());
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > MAX_BYTES) throw new CommentsReadError('response');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); } catch { throw new CommentsReadError('response'); }
  } finally {
    if (!complete) reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Pending cancellation may retain its lock briefly. */ }
  }
}
export async function fetchPublicComments({endpoint, articleId, page = 1, signal, timeoutMs = 6000, fetchImpl = fetch} = {}) {
  const target = publicCommentsEndpoint(endpoint), id = publicCommentId(articleId);
  if (!target || !id || !Number.isSafeInteger(page) || page < 1 || page > COMMENTS_MAX_PAGES) throw new CommentsReadError('configuration');
  const url = new URL(target);
  url.search = new URLSearchParams({'where[article][equals]':id, sort:'commentedAt', limit:String(COMMENTS_PAGE_SIZE), page:String(page), depth:'0'}).toString();
  const controller = new AbortController(); let timedOut = false;
  const abort = () => controller.abort();
  const cancelled = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new CommentsReadError(signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'cancelled')), {once:true}));
  const wait = value => Promise.race([value, cancelled]);
  signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    if (signal?.aborted) throw new CommentsReadError('cancelled');
    const response = await wait(fetchImpl(url.href, {method:'GET', credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', headers:{Accept:'application/json'}, signal:controller.signal}));
    if (!response.ok) { response.body?.cancel().catch(() => {}); throw new CommentsReadError('http', response.status, response.status === 429 ? retryAfter(response.headers.get('Retry-After')) : 0); }
    const payload = await limitedJson(response, wait);
    if (!Array.isArray(payload?.docs) || payload.docs.length > COMMENTS_PAGE_SIZE || typeof payload.hasNextPage !== 'boolean') throw new CommentsReadError('response');
    const comments = payload.docs.map(normalizePublicComment).filter(Boolean);
    if (payload.docs.length && !comments.length) throw new CommentsReadError('response');
    if (payload.hasNextPage && (!Number.isSafeInteger(payload.nextPage) || payload.nextPage !== page + 1)) throw new CommentsReadError('response');
    const truncated = payload.hasNextPage && page === COMMENTS_MAX_PAGES;
    return { comments, nextPage: payload.hasNextPage && !truncated ? payload.nextPage : null, truncated, incomplete: comments.length !== payload.docs.length };
  } catch (error) {
    if (error instanceof CommentsReadError) throw error;
    throw new CommentsReadError(signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
