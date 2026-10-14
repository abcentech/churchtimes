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

export class CMSReadError extends Error {
  constructor(type, message, status=0) { super(message); this.type=type; this.status=status; }
}
export function cmsErrorMessage(error) {
  if(error?.type==='configuration')return 'The newsroom connection is not configured correctly. You can still read the current edition.';
  if(error?.type==='timeout')return 'The newsroom took too long to respond. Please try again or read the current edition.';
  if(error?.status===429)return 'The newsroom is receiving too many requests. Please wait before trying again.';
  if([401,403].includes(error?.status))return 'Public reporting is unavailable from this newsroom connection. You can still read the current edition.';
  if(error?.type==='response')return 'The newsroom returned an unreadable response. Please try again later or read the current edition.';
  return '';
}

const plainText = (value, maxLength = 2000) =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

const validSlug = value => typeof value === 'string' && value.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

const publicationDate = value => {
  const text = plainText(value, 40);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : '';
};

function mediaUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value, baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    if (baseUrl && url.origin !== new URL(baseUrl).origin) return '';
    return url.pathname.startsWith('/api/media/file/') ? url.href : '';
  } catch { return ''; }
}
export function normalizePublicMedia(record, baseUrl) {
  if (!record || typeof record !== 'object') return null;
  if (!['image/jpeg','image/png','image/webp'].includes(record.mimeType)) return null;
  const url = mediaUrl(record.url, baseUrl);
  if (!url) return null;
  const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 20000 ? value : null;
  return {
    url, cardUrl:mediaUrl(record.sizes?.card?.url, baseUrl) || url,
    heroUrl:mediaUrl(record.sizes?.hero?.url, baseUrl) || url,
    alt:plainText(record.alt,300), caption:plainText(record.caption,1000), credit:plainText(record.credit,300),
    width:dimension(record.width), height:dimension(record.height),
    cardWidth:record.sizes?.card?.url ? dimension(record.sizes.card.width) : dimension(record.width),
    cardHeight:record.sizes?.card?.url ? dimension(record.sizes.card.height) : dimension(record.height),
    heroWidth:record.sizes?.hero?.url ? dimension(record.sizes.hero.width) : dimension(record.width),
    heroHeight:record.sizes?.hero?.url ? dimension(record.sizes.hero.height) : dimension(record.height),
  };
}
function legacyUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['churchtimesnigeria.net','www.churchtimesnigeria.net'].includes(url.hostname) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
export function normalizePublishedArticle(record, { baseUrl } = {}) {
  if (!record || record.status !== 'published') return null;
  const slug = typeof record.slug === 'string' ? record.slug.trim() : '';
  const title = plainText(record.title, 240);
  if (!validSlug(slug) || !title) return null;
  return {
    id: String(record.id ?? slug),
    slug,
    title,
    excerpt: plainText(record.excerpt || record.summary, 600),
    publishedAt: publicationDate(record.publishedAt),
    updatedAt: publicationDate(record.updatedAt),
    categoryId: Number.isSafeInteger(record.category?.id) ? record.category.id : null,
    categorySlug: validSlug(record.category?.slug) ? record.category.slug : '',
    category: plainText(typeof record.category === 'object' ? record.category?.title : record.category, 100),
    bylineName:plainText(record.bylineName,200),
    featuredImage:normalizePublicMedia(record.featuredImage,baseUrl),
    legacyUrl:legacyUrl(record.legacyUrl),
    corrections:Array.isArray(record.corrections) ? record.corrections.slice(0,100).filter(item => typeof item?.note === 'string' && item.note.trim()).map(item => ({ note:plainText(item.note,2000), correctedAt:publicationDate(item.correctedAt) })) : [],
    // Do not interpret arbitrary rich-text or HTML as safe markup.
    content: record.content ?? null,
  };
}

export function publicCmsOrigin(baseUrl) {
  let url;
  try {url=new URL(baseUrl);} catch {throw new CMSReadError('configuration','CMS base URL must be an absolute HTTP(S) origin');}
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || url.pathname !== '/'
    || (url.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname))) {
    throw new CMSReadError('configuration','CMS base URL must be an absolute HTTP(S) origin without credentials or a path');
  }
  return url.origin;
}
async function requestJson(url, { fetchImpl = fetch, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut=false;
  const timer = setTimeout(()=>{timedOut=true;abort();}, timeoutMs);
  try {
    if(controller.signal.aborted) throw new Error('aborted');
    const response = await fetchImpl(url.toString(), {
      method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal, credentials: 'omit',
    });
    if (!response.ok) throw new CMSReadError('http',`CMS request failed (${response.status})`,response.status);
    let payload;
    try {payload=await response.json();} catch {if(controller.signal.aborted)throw new Error('aborted');throw new CMSReadError('response','Unexpected CMS response');}
    if (controller.signal.aborted) throw new DOMException('CMS request aborted', 'AbortError');
    if (!Array.isArray(payload?.docs)) throw new CMSReadError('response','Unexpected CMS response');
    return payload;
  } catch(error) {
    if(error instanceof CMSReadError)throw error;
    if(signal?.aborted)throw new CMSReadError('cancelled','CMS request aborted on navigation');
    if(timedOut)throw new CMSReadError('timeout','CMS request aborted after timeout');
    throw new CMSReadError('network','CMS network request failed');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
const nextPageOf = (payload, page) => payload.hasNextPage === true && Number.isSafeInteger(payload.nextPage) && payload.nextPage > page ? payload.nextPage : null;
export async function fetchPublicCategories(options = {}) {
  const origin = publicCmsOrigin(options.baseUrl);
  const categories = [], seen = new Set();
  let page = 1;
  for (let count = 0; count < 20; count++) {
    const url = new URL('/api/categories', origin);
    url.searchParams.set('limit', '100'); url.searchParams.set('page', String(page)); url.searchParams.set('sort', 'title');
    const payload = await requestJson(url, options);
    for (const item of payload.docs) {
      if (!Number.isSafeInteger(item.id) || item.id <= 0 || !validSlug(item.slug) || !plainText(item.title, 100) || seen.has(item.id)) continue;
      seen.add(item.id); categories.push({ id: item.id, slug: item.slug, title: plainText(item.title, 100) });
    }
    const next = nextPageOf(payload, page);
    if (!next) return categories;
    page = next;
  }
  throw new Error('The category list could not be loaded completely');
}
async function requestPublishedArticles(options = {}) {
  const { baseUrl, limit = 20, page = 1, slug, categoryIds = [], query = '' } = options;
  const origin = publicCmsOrigin(baseUrl);
  if (!Array.isArray(categoryIds) || categoryIds.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Category filters require numeric IDs');
  const safePage = Math.max(1, Math.floor(Number(page)) || 1);
  const url = new URL('/api/articles', origin);
  url.searchParams.set('where[status][equals]', 'published');
  url.searchParams.set('limit', String(Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(limit)) || 20))));
  url.searchParams.set('depth', '1'); url.searchParams.set('sort', '-publishedAt'); url.searchParams.set('page', String(safePage));
  if (slug) url.searchParams.set('where[slug][equals]', slug);
  if (categoryIds.length) url.searchParams.set(categoryIds.length === 1 ? 'where[category][equals]' : 'where[category][in]', [...new Set(categoryIds)].join(','));
  const search = plainText(query, 120);
  if (search) ['title', 'excerpt', 'bylineName'].forEach((field, index) => url.searchParams.set(`where[or][${index}][${field}][like]`, search));
  const payload = await requestJson(url, options);
  const articles = payload.docs.map(record => normalizePublishedArticle(record, { baseUrl: origin })).filter(Boolean);
  return { articles, nextPage: nextPageOf(payload, safePage) };
}
export async function fetchPublishedArticles(options = {}) { return (await requestPublishedArticles(options)).articles; }
export async function fetchPublishedPage(options = {}) { return requestPublishedArticles(options); }
export async function fetchPublishedArticle({ slug, ...options } = {}) {
  if (!validSlug(slug)) return null;
  const { articles } = await requestPublishedArticles({ ...options, slug, limit: 1 });
  return articles.find(article => article.slug === slug) || null;
}
