import { publicOrigin } from './public-url.js';
import { CMSReadError } from './published-articles.js';
const DEFAULT_TIMEOUT_MS = 6000;
const plainText = (value, maxLength = 2000) => typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
const validSlug = value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || '');
const publicationDate = value => { const text = plainText(value, 40); return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : ''; };
// Public search (go-live contract C8): GET /api/public/search. Hits are cards only; the article body is fetched on the report page.
const SEARCH_MAX_QUERY = 200;
function normalizeSearchHit(record) {
  const slug = plainText(record?.slug, 160), title = plainText(record?.title, 240);
  if (!validSlug(slug) || !title) return null;
  const category = record.category && typeof record.category === 'object' ? record.category.title : record.category;
  return {
    id: String(record.id ?? slug), slug, title,
    excerpt: plainText(record.snippet || record.excerpt, 600),
    publishedAt: publicationDate(record.publishedAt),
    category: plainText(category, 100), bylineName: '', featuredImage: null,
  };
}
export async function searchArticles({ baseUrl, query, page = 1, limit = 12, signal, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const term = typeof query === 'string' ? query.trim().slice(0, SEARCH_MAX_QUERY) : '';
  // The endpoint rejects an empty query; there is nothing to look for, so make no request.
  if (!term) return { articles: [], nextPage: null, totalDocs: 0, totalCapped: false };
  if (!baseUrl) throw new CMSReadError('configuration','CMS base URL is required');
  if (!publicOrigin(baseUrl)) throw new CMSReadError('configuration','CMS base URL must be an absolute HTTP(S) URL');
  const url = new URL('/api/public/search', new URL(baseUrl));
  const pageNumber = Math.max(1, Math.floor(Number(page)) || 1);
  url.searchParams.set('q', term);
  url.searchParams.set('page', String(pageNumber));
  url.searchParams.set('limit', String(Math.max(1, Math.min(20, Math.floor(Number(limit)) || 12))));
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, credentials: 'omit' });
    if (!response.ok) {
      const seconds = Number(response.headers?.get?.('Retry-After'));
      const retryAfter = response.status === 429 && Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 0;
      throw new CMSReadError('http',`CMS search failed (${response.status})`,response.status,retryAfter);
    }
    let payload;
    try { payload = await response.json(); } catch { if (controller.signal.aborted) throw new Error('aborted'); throw new CMSReadError('response','Unexpected CMS response'); }
    if (!Array.isArray(payload?.docs)) throw new CMSReadError('response','Unexpected CMS response');
    const nextPage = payload.hasNextPage === true && Number.isSafeInteger(payload.nextPage) && payload.nextPage > pageNumber ? payload.nextPage : null;
    return {
      articles: payload.docs.map(normalizeSearchHit).filter(Boolean), nextPage,
      totalDocs: Number.isSafeInteger(payload.totalDocs) && payload.totalDocs >= 0 ? payload.totalDocs : 0,
      totalCapped: payload.totalCapped === true, note: payload.totalCapped === true ? 'Over 1,000 matches; best first.' : '',
    };
  } catch (error) {
    if (error instanceof CMSReadError) throw error;
    if (signal?.aborted) throw new CMSReadError('cancelled','CMS request aborted on navigation');
    if (timedOut) throw new CMSReadError('timeout','CMS request aborted after timeout');
    throw new CMSReadError('network','CMS network request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
