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

const publicationDate = value => {
  const text = plainText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
};

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
    publishedAt: publicationDate(record.publishedAt),
    category: plainText(typeof record.category === 'object' ? record.category?.title : record.category, 100),
    // Do not interpret arbitrary rich-text or HTML as safe markup.
    content: record.content ?? null,
  };
}

async function requestPublishedArticles({
  baseUrl,
  fetchImpl = fetch,
  limit = 20,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  page = 1,
  slug,
} = {}) {
  if (!baseUrl) throw new Error('CMS base URL is required');
  const origin = new URL(baseUrl, 'https://invalid.local');
  if (!['https:', 'http:'].includes(origin.protocol) || origin.hostname === 'invalid.local') {
    throw new Error('CMS base URL must be an absolute HTTP(S) URL');
  }
  const safeLimit = Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(limit)) || 20));
  const url = new URL('/api/articles', origin);
  url.searchParams.set('where[status][equals]', 'published');
  url.searchParams.set('limit', String(safeLimit));
  url.searchParams.set('depth', '1');
  url.searchParams.set('sort', '-publishedAt');
  url.searchParams.set('page', String(Math.max(1, Math.floor(Number(page)) || 1)));
  if (slug) url.searchParams.set('where[slug][equals]', slug);

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
    const articles = payload.docs.map(normalizePublishedArticle).filter(Boolean);
    const nextPage = payload.hasNextPage === true && Number.isSafeInteger(payload.nextPage)
      && payload.nextPage > Number(url.searchParams.get('page')) ? payload.nextPage : null;
    return { articles, nextPage };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPublishedArticles(options = {}) {
  return (await requestPublishedArticles(options)).articles;
}

export async function fetchPublishedPage(options = {}) {
  return requestPublishedArticles(options);
}

export async function fetchPublishedArticle({ slug, ...options } = {}) {
  if (!validSlug(slug)) return null;
  const { articles } = await requestPublishedArticles({ ...options, slug, limit: 1 });
  return articles.find(article => article.slug === slug) || null;
}
