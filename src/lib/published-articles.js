import { publicOrigin } from './public-url.js';
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

const validSlug = value => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || '');

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
export function normalizePublishedArticle(record, {baseUrl} = {}) {
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
    bylineName: plainText(record.bylineName,200),
    featuredImage: normalizePublicMedia(record.featuredImage,baseUrl),
    legacyUrl:legacyUrl(record.legacyUrl),
    corrections: Array.isArray(record.corrections) ? record.corrections.slice(0,100).filter(c=>c && typeof c.note==='string' && c.note.trim()).map(c=>({note:plainText(c.note,2000),correctedAt:publicationDate(c.correctedAt)})) : [],
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
  signal,
  categoryId,
  query,
  collection = 'articles',
  categorySlug,
} = {}) {
  if (!baseUrl) throw new CMSReadError('configuration','CMS base URL is required');
  let origin;
  try { origin = new URL(baseUrl); } catch { throw new CMSReadError('configuration','CMS base URL must be an absolute HTTP(S) URL'); }
  if (!publicOrigin(baseUrl)) {
    throw new CMSReadError('configuration','CMS base URL must be an absolute HTTP(S) URL');
  }
  const safeLimit = Math.max(1, Math.min(MAX_ITEMS, Math.floor(Number(limit)) || 20));
  const url = new URL(`/api/${collection}`, origin);
  if(collection==='articles') url.searchParams.set('where[status][equals]', 'published');
  url.searchParams.set('limit', String(safeLimit));
  url.searchParams.set('depth', '1');
  url.searchParams.set('sort', collection==='articles' ? '-publishedAt' : 'title');
  url.searchParams.set('page', String(Math.max(1, Math.floor(Number(page)) || 1)));
  if (slug || categorySlug) url.searchParams.set('where[slug][equals]', slug || categorySlug);
  if (categoryId !== undefined) {
    if (!/^\d{1,15}$/.test(String(categoryId))) throw new CMSReadError('configuration','Category filters require numeric IDs');
    url.searchParams.set('where[category][equals]',String(categoryId));
  }
  const term=typeof query==='string' ? query.trim().slice(0,120) : '';
  if(term) ['title','excerpt','bylineName'].forEach((field,i)=>url.searchParams.set(`where[or][${i}][${field}][like]`,term));

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let timedOut=false;
  const timer = setTimeout(() => { timedOut=true;controller.abort(); }, timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'omit',
    });
    if (!response.ok) throw new CMSReadError('http',`CMS request failed (${response.status})`,response.status);
    let payload;
    try {payload=await response.json();} catch { if(controller.signal.aborted)throw new Error('aborted');throw new CMSReadError('response','Unexpected CMS response'); }
    if (!Array.isArray(payload?.docs)) throw new CMSReadError('response','Unexpected CMS response');
    const articles = collection==='categories' ? payload.docs.map(normalizeCategory).filter(Boolean) : payload.docs.map(record=>normalizePublishedArticle(record,{baseUrl})).filter(Boolean);
    const nextPage = payload.hasNextPage === true && Number.isSafeInteger(payload.nextPage)
      && payload.nextPage > Number(url.searchParams.get('page')) ? payload.nextPage : null;
    return { articles, nextPage };
  } catch(error) {
    if(error instanceof CMSReadError)throw error;
    if(signal?.aborted)throw new CMSReadError('cancelled','CMS request aborted on navigation');
    if(timedOut)throw new CMSReadError('timeout','CMS request aborted after timeout');
    throw new CMSReadError('network','CMS network request failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
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

function normalizeCategory(record) {
  if (!record || !/^\d{1,15}$/.test(String(record.id)) || !validSlug(record.slug) || !plainText(record.title)) return null;
  return {id:String(record.id),slug:record.slug,title:plainText(record.title,100),description:plainText(record.description,600)};
}
export async function fetchPublicCategories(options={}) {
  return requestPublishedArticles({...options,collection:'categories',limit:100});
}
export async function fetchPublicCategory({slug,...options}={}) {
  if(!validSlug(slug)) return null;
  const {articles}=await requestPublishedArticles({...options,collection:'categories',categorySlug:slug,limit:1});
  return articles.find(category=>category.slug===slug) || null;
}
