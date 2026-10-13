/**
 * Church Times published-content adapter.
 *
 * Public-facing code should use this module instead of calling privileged CMS
 * endpoints directly. It intentionally does not alter the current static edition.
 *
 * Expected CMS contract:
 * GET {baseUrl}/api/articles?where[status][equals]=published&limit=20
 * Response: Payload-style { docs: [...], totalDocs, ... }
 *
 * Only published records are accepted even if an API is misconfigured.
 */
const MAX_ITEMS = 100;
const DEFAULT_TIMEOUT_MS = 6000;

const plainText = (value, maxLength = 2000) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const validSlug = value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || '');

export function normalizePublishedArticle(record) {
  if (!record || record.status !== 'published') return null;
  const slug = plainText(record.slug, 160);
  const title = plainText(record.title, 240);
  if (!validSlug(slug) || !title) return null;
  return {
    id: String(record.id ?? slug),
    slug,
    title,
    excerpt: plainText(record.excerpt || record.summary, 600),
    publishedAt: plainText(record.publishedAt, 40),
    category: plainText(typeof record.category === 'object' ? record.category?.title : record.category, 100),
    // Do not interpret arbitrary rich-text or HTML as safe markup.
    content: record.content ?? null,
  };
}

export async function fetchPublishedArticles({
  baseUrl,
  fetchImpl = fetch,
  limit = 20,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!baseUrl) throw new Error('CMS base URL is required');
  const origin = new URL(baseUrl, 'https://invalid.local');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.hostname === 'invalid.local') {
    throw new Error('CMS base URL must be an absolute HTTP(S) URL');
  }
  const safeLimit = Math.max(1, Math.min(MAX_ITEMS, Number(limit) || 20));
  const url = new URL('/api/articles', origin);
  url.searchParams.set('where[status][equals]', 'published');
  url.searchParams.set('limit', String(safeLimit));
  url.searchParams.set('depth', '0');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`CMS request failed (${response.status})`);
    const payload = await response.json();
    if (!Array.isArray(payload?.docs)) throw new Error('Unexpected CMS response');
    return payload.docs.map(normalizePublishedArticle).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}
