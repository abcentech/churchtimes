// Public topic and author reads (plan section 4: GET /api/public/topics/:slug and /api/public/authors/:slug).
// Shared by the public host (server-rendered /topic/{slug}/) and the lazy browser features. Read-only, anonymous, no cookies.
import { publicOrigin } from '../../lib/public-url.js';
import { CMSReadError, normalizePublishedArticle } from '../../lib/published-articles.js';

export const TOPIC_KINDS = ['topic', 'denomination', 'series', 'ministry'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const text = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
export const validTaxonomySlug = value => typeof value === 'string' && value.length <= 160 && SLUG.test(value);

function cards(list, baseUrl) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  // The public endpoints only return published articles; records without a status are the card shape, so they count as published.
  return list.slice(0, 50).map(record => record && typeof record === 'object' ? normalizePublishedArticle({ ...record, status: record.status ?? 'published' }, { baseUrl }) : null)
    .filter(article => article && !seen.has(article.slug) && seen.add(article.slug));
}

/** Accepts `{topic, articles}`, `{doc, articles}` or a flat document with `articles`/`docs` (the contract is read leniently, validated strictly). */
export function normalizeTopicPayload(payload, { baseUrl } = {}) {
  const record = payload?.topic && typeof payload.topic === 'object' ? payload.topic : payload?.doc && typeof payload.doc === 'object' ? payload.doc : payload;
  if (!record || typeof record !== 'object' || record.isPublic === false) return null;
  const slug = text(record.slug, 160), name = text(record.name || record.title, 120);
  if (!validTaxonomySlug(slug) || !name) return null;
  return {
    slug, name,
    kind: TOPIC_KINDS.includes(record.kind) ? record.kind : 'topic',
    description: text(record.description, 400),
    articles: cards(payload.articles ?? payload.docs ?? record.articles, baseUrl),
  };
}

export function normalizeAuthorPayload(payload, { baseUrl } = {}) {
  const record = payload?.author && typeof payload.author === 'object' ? payload.author : payload?.doc && typeof payload.doc === 'object' ? payload.doc : payload;
  if (!record || typeof record !== 'object' || record.isPublic === false) return null;
  const slug = text(record.slug, 160), name = text(record.name, 120);
  if (!validTaxonomySlug(slug) || !name) return null;
  return { slug, name, role: text(record.role, 120), articles: cards(payload.articles ?? payload.docs ?? record.articles, baseUrl) };
}

/** GET one topic or author. Resolves null for 404 / not public; throws CMSReadError for anything else. */
export async function fetchTaxonomy({ kind, slug, baseUrl, fetchImpl = fetch, signal, timeoutMs = 6000 }) {
  if (!['topic', 'author'].includes(kind) || !validTaxonomySlug(slug)) return null;
  if (!baseUrl || !publicOrigin(baseUrl)) throw new CMSReadError('configuration', 'CMS base URL must be an absolute HTTP(S) URL');
  const url = new URL(`/api/public/${kind === 'topic' ? 'topics' : 'authors'}/${encodeURIComponent(slug)}`, new URL(baseUrl));
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) {
      const seconds = Number(response.headers?.get?.('Retry-After'));
      throw new CMSReadError('http', `CMS ${kind} request failed (${response.status})`, response.status, response.status === 429 && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 0);
    }
    let payload;
    try { payload = await response.json(); } catch { throw new CMSReadError('response', 'Unexpected CMS response'); }
    return kind === 'topic' ? normalizeTopicPayload(payload, { baseUrl }) : normalizeAuthorPayload(payload, { baseUrl });
  } catch (error) {
    if (error instanceof CMSReadError) throw error;
    if (signal?.aborted) throw new CMSReadError('cancelled', 'CMS request aborted on navigation');
    if (timedOut) throw new CMSReadError('timeout', 'CMS request aborted after timeout');
    throw new CMSReadError('network', 'CMS network request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/** GET /api/public/topics (index). Resolves [] when the endpoint is absent. */
export async function fetchTopicIndex({ baseUrl, fetchImpl = fetch, signal, timeoutMs = 6000 }) {
  if (!baseUrl || !publicOrigin(baseUrl)) throw new CMSReadError('configuration', 'CMS base URL must be an absolute HTTP(S) URL');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(new URL('/api/public/topics', new URL(baseUrl)).toString(), { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal: controller.signal });
    if (response.status === 404) return [];
    if (!response.ok) throw new CMSReadError('http', `CMS topics request failed (${response.status})`, response.status);
    const payload = await response.json().catch(() => null);
    const list = Array.isArray(payload) ? payload : Array.isArray(payload?.docs) ? payload.docs : Array.isArray(payload?.topics) ? payload.topics : null;
    if (!list) throw new CMSReadError('response', 'Unexpected CMS response');
    return list.slice(0, 500).map(record => normalizeTopicPayload({ topic: record, articles: [] })).filter(Boolean);
  } catch (error) {
    if (error instanceof CMSReadError) throw error;
    throw new CMSReadError(signal?.aborted ? 'cancelled' : 'network', 'CMS network request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
