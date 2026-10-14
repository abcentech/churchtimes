/**
 * Live adapter: the real Payload CMS REST API. There is NO mock fallback anywhere in this file:
 * every call resolves only after a 2xx response and otherwise throws an ApiError carrying the server's message.
 *
 * Contract: apps/cms/docs/api-contracts.md (v1.3). Auth is the HttpOnly `payload-token` cookie set by the CMS
 * (fetch with credentials:'include'); the JWT in the login body is ignored and nothing credential-like is stored.
 */

import { CMS_URL, CMS_HOST_LABEL, cmsAssetUrl } from '../config.js';
import { can } from '../permissions.js';
import { lexicalToMarkdown, markdownToLexical } from '../lexical.js';
import { ApiError, toApiError } from './errors.js';

const ID_RE = /^\d+$/;

/** Validate a record id before it is used in a request path. */
function safeId(value) {
  const s = String(value ?? '');
  if (!ID_RE.test(s)) throw new ApiError('Invalid identifier.', { status: 400 });
  return s;
}

// api-contracts.md section 3 (Submission.status). `converted` is set only by the server's convert endpoint, never by a PATCH.
const SUBMISSION_STATUSES = ['new', 'under_review', 'accepted', 'rejected', 'converted'];
const SUBMISSION_PATCH_STATUSES = SUBMISSION_STATUSES.filter(s => s !== 'converted');
const ARTICLE_STATUSES = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published', 'archived'];

function relId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value.id === undefined ? null : String(value.id);
  return String(value);
}

function normalizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  const name = user.name || user.email || 'Staff';
  return {
    id: String(user.id),
    name,
    email: user.email || '',
    role: String(user.role || '').replace(/_/g, '-'),
    sections: (Array.isArray(user.sections) ? user.sections : []).map(relId).filter(Boolean),
    avatar: String(name).trim().slice(0, 2).toUpperCase()
  };
}

function normalizeMedia(m) {
  if (m === null || m === undefined) return null;
  if (typeof m !== 'object') return { id: String(m), url: '', thumbUrl: '', alt: '', caption: '', credit: '', filename: '' };
  const card = m.sizes?.card?.url || m.sizes?.thumbnail?.url || m.url;
  return {
    id: String(m.id),
    url: cmsAssetUrl(m.url),
    thumbUrl: cmsAssetUrl(card),
    alt: m.alt || '',
    caption: m.caption || '',
    credit: m.credit || '',
    filename: m.filename || '',
    mimeType: m.mimeType || '',
    width: m.width || null,
    height: m.height || null,
    filesize: m.filesize || null
  };
}

function normalizeArticle(doc) {
  const cat = doc.category && typeof doc.category === 'object' ? doc.category : null;
  const author = doc.author && typeof doc.author === 'object' ? doc.author : null;
  const { markdown, lossy } = lexicalToMarkdown(doc.content);
  return {
    id: String(doc.id),
    title: doc.title || '',
    slug: doc.slug || '',
    standfirst: doc.excerpt || '',
    bodyMd: markdown,
    lossy,
    categoryId: relId(doc.category),
    categoryTitle: cat?.title || '',
    featuredImage: normalizeMedia(doc.featuredImage),
    status: doc.status || 'draft',
    authorId: relId(doc.author),
    authorName: doc.bylineName || author?.name || '',
    bylineName: doc.bylineName || '',
    updatedAt: doc.updatedAt || null,
    createdAt: doc.createdAt || null,
    publishedAt: doc.publishedAt || null,
    scheduledFor: doc.scheduledFor || null,
    reviewNotes: doc.reviewNotes || '',
    corrections: Array.isArray(doc.corrections) ? doc.corrections : []
  };
}

function normalizeSubmission(s) {
  return {
    id: String(s.id),
    reference: s.reference || '',
    title: s.title || '',
    body: s.body || '',
    name: s.name || '',
    email: s.email || '',
    phone: s.phone || '',
    location: s.location || '',
    categorySuggestion: s.categorySuggestion || '',
    status: s.status || 'new',
    reviewerNotes: s.reviewerNotes || '',
    articleId: relId(s.article),
    createdAt: s.createdAt || null
  };
}

function normalizeEvent(e) {
  return {
    id: String(e.id),
    slug: e.slug || '',
    title: e.title || '',
    summary: e.summary || '',
    status: e.status || 'draft',
    categoryId: relId(e.category),
    startedAt: e.startedAt || null,
    endedAt: e.endedAt || null
  };
}

function normalizeUpdate(u) {
  const author = u.author && typeof u.author === 'object' ? u.author : null;
  return {
    id: String(u.id),
    eventId: relId(u.event),
    body: u.body || '',
    status: u.status || 'pending',
    sequence: u.sequence ?? null,
    occurredAt: u.occurredAt || u.createdAt || null,
    authorName: author?.name || ''
  };
}

export class CmsAdapter {
  constructor() {
    this.mode = 'live';
    this.isMock = false;
    this.currentUser = null;
    this.listeners = new Set();
    this.categoriesPromise = null;
  }

  // ---- plumbing -----------------------------------------------------------------------------------------

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, data) {
    for (const fn of this.listeners) {
      try { fn(event, data); } catch (err) { console.error('listener error', err); }
    }
  }

  getModeInfo() {
    return { isMock: false, label: 'LIVE CMS', detail: `Connected to ${CMS_HOST_LABEL}` };
  }

  /**
   * Single entry point for every CMS call. Resolves only for 2xx; throws ApiError otherwise.
   * A 401 on an authenticated call drops the in-memory session and notifies the app (back to login).
   */
  async request(path, { method = 'GET', json, form, query, auth = true } = {}) {
    let url = `${CMS_URL}/api${path}`;
    if (query) {
      const qs = query instanceof URLSearchParams ? query : new URLSearchParams(query);
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const init = { method, credentials: 'include', headers: { Accept: 'application/json' } };
    if (json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    } else if (form) {
      init.body = form; // multipart: let the browser set the boundary
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      throw new ApiError('Cannot reach the CMS. Check your connection and try again.', { status: 0, network: true });
    }
    if (!res.ok) {
      const err = await toApiError(res);
      if (res.status === 401 && auth) this.handleUnauthorized();
      throw err;
    }
    if (res.status === 204) return null;
    try { return await res.json(); } catch { return null; }
  }

  handleUnauthorized() {
    if (!this.currentUser) return;
    this.currentUser = null;
    this.categoriesPromise = null;
    this.emit('unauthorized', null);
  }

  // ---- session ------------------------------------------------------------------------------------------

  /** Boot-time check. 200 with user:null means anonymous (not an error). Network errors throw. */
  async restoreSession() {
    const data = await this.request('/users/me', { auth: false });
    this.currentUser = normalizeUser(data?.user);
    return this.currentUser;
  }

  /**
   * Re-check the server session on navigation. Payload treats a revoked or expired token as an anonymous request (200 with public data),
   * not a 401, so read-only views would otherwise keep looking signed in. Returns false (and signs the UI out) when the server has no user.
   */
  async verifySession() {
    let data;
    try {
      data = await this.request('/users/me', { auth: false });
    } catch {
      return true; // network/CMS error: the view's own requests will surface it
    }
    if (normalizeUser(data?.user)) return true;
    this.handleUnauthorized();
    return false;
  }

  async login({ email, password }) {
    const cleanEmail = String(email || '').trim();
    if (!cleanEmail || !password) throw new ApiError('Please enter both email and password.', { status: 400 });
    const data = await this.request('/users/login', {
      method: 'POST',
      json: { email: cleanEmail, password },
      auth: false
    });
    // Deliberately ignore data.token: the HttpOnly cookie is the only credential.
    const user = normalizeUser(data?.user);
    if (!user) throw new ApiError('Sign-in did not return a user.', { status: 500 });
    this.currentUser = user;
    this.emit('session', user);
    return user;
  }

  /**
   * Ends the CMS session (cookie cleared server side) and ALWAYS clears local state.
   * Resolves { ok: true } when the server confirmed (or had no session to end: Payload answers 400 "no user" / 401),
   * { ok: false, error } when the server could not be reached or answered with another error, so the caller can warn
   * that the server-side session may still be active.
   */
  async logout() {
    let result = { ok: true };
    try {
      await this.request('/users/logout', { method: 'POST', auth: false });
    } catch (err) {
      if (err?.status === 400 || err?.status === 401) {
        result = { ok: true };
      } else {
        console.warn('Logout request failed', err?.message);
        result = { ok: false, error: err };
      }
    }
    this.clearLocalState();
    this.emit('session', null);
    return result;
  }

  clearLocalState() {
    this.currentUser = null;
    this.categoriesPromise = null;
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('ctn_') && key !== 'ctn_theme') localStorage.removeItem(key);
      }
      sessionStorage.clear();
    } catch { /* storage unavailable */ }
  }

  getCurrentUser() { return this.currentUser; }

  can(action, ctx) { return can(this.currentUser, action, ctx); }

  // ---- categories ---------------------------------------------------------------------------------------

  getCategories() {
    if (!this.categoriesPromise) {
      this.categoriesPromise = this.request('/categories', { query: { limit: '100', sort: 'title', depth: '0' } })
        .then(data => (data?.docs || []).map(c => ({ id: String(c.id), title: c.title || '', slug: c.slug || '' })))
        .catch(err => { this.categoriesPromise = null; throw err; });
    }
    return this.categoriesPromise;
  }

  // ---- articles -----------------------------------------------------------------------------------------

  async getArticles({ status, categoryId, search, limit = 50, page = 1 } = {}) {
    const q = new URLSearchParams({ depth: '1', limit: String(limit), page: String(page), sort: '-updatedAt' });
    if (status && status !== 'all') {
      if (!ARTICLE_STATUSES.includes(status)) throw new ApiError('Unknown status filter.', { status: 400 });
      q.set('where[status][equals]', status);
    }
    if (categoryId && categoryId !== 'all') q.set('where[category][equals]', safeId(categoryId));
    if (search && search.trim()) q.set('where[title][like]', search.trim().slice(0, 120));
    const data = await this.request('/articles', { query: q });
    return { data: (data?.docs || []).map(normalizeArticle), totalDocs: data?.totalDocs ?? 0 };
  }

  async getArticleCounts() {
    const entries = await Promise.all(ARTICLE_STATUSES.map(async s => {
      const data = await this.request('/articles', {
        query: { limit: '1', depth: '0', 'where[status][equals]': s }
      });
      return [s, data?.totalDocs ?? 0];
    }));
    return Object.fromEntries(entries);
  }

  async getArticle(id) {
    const data = await this.request(`/articles/${encodeURIComponent(safeId(id))}`, { query: { depth: '1' } });
    if (!data) throw new ApiError('Story not found.', { status: 404 });
    return { data: normalizeArticle(data) };
  }

  /** Allowlisted mapping from editor fields to CMS fields. Never sends status/author/publishedAt/etc. */
  static toCmsFields(fields) {
    const out = {};
    if ('title' in fields) out.title = fields.title;
    if ('slug' in fields && fields.slug) out.slug = fields.slug;
    if ('standfirst' in fields) out.excerpt = fields.standfirst;
    if ('bodyMd' in fields) out.content = markdownToLexical(fields.bodyMd);
    if ('bylineName' in fields) out.bylineName = fields.bylineName;
    if ('categoryId' in fields && fields.categoryId) out.category = Number(safeId(fields.categoryId));
    if ('featuredImageId' in fields) {
      out.featuredImage = fields.featuredImageId ? Number(safeId(fields.featuredImageId)) : null;
    }
    if ('corrections' in fields) out.corrections = fields.corrections;
    return out;
  }

  async createArticle(fields) {
    const body = CmsAdapter.toCmsFields(fields);
    const data = await this.request('/articles', { method: 'POST', json: body, query: { depth: '1' } });
    return { data: normalizeArticle(data.doc) };
  }

  /** PATCH only the supplied (changed) fields. */
  async updateArticle(id, changes) {
    const body = CmsAdapter.toCmsFields(changes);
    if (!Object.keys(body).length) return this.getArticle(id);
    const data = await this.request(`/articles/${encodeURIComponent(safeId(id))}`, {
      method: 'PATCH', json: body, query: { depth: '1' }
    });
    return { data: normalizeArticle(data.doc) };
  }

  /** Explicit workflow transition. Sends only `status` (+ editor `reviewNotes`). */
  async transitionArticle(id, status, { reviewNotes } = {}) {
    if (!ARTICLE_STATUSES.includes(status)) throw new ApiError('Unknown status.', { status: 400 });
    const body = { status };
    if (reviewNotes !== undefined) body.reviewNotes = reviewNotes;
    const data = await this.request(`/articles/${encodeURIComponent(safeId(id))}`, {
      method: 'PATCH', json: body, query: { depth: '1' }
    });
    return { data: normalizeArticle(data.doc) };
  }

  /**
   * Schedule (or reschedule) a story: one PATCH with status 'scheduled' and the instant to publish.
   * The CMS validates it (future time, who may schedule) and publishes it when the time arrives.
   */
  async scheduleArticle(id, scheduledForIso) {
    const when = new Date(scheduledForIso);
    if (Number.isNaN(when.getTime())) throw new ApiError('That is not a valid date and time.', { status: 400 });
    const data = await this.request(`/articles/${encodeURIComponent(safeId(id))}`, {
      method: 'PATCH', json: { status: 'scheduled', scheduledFor: when.toISOString() }, query: { depth: '1' }
    });
    return { data: normalizeArticle(data.doc) };
  }

  async deleteArticle(id) {
    await this.request(`/articles/${encodeURIComponent(safeId(id))}`, { method: 'DELETE' });
    return { ok: true };
  }

  // ---- submissions (staff queue; the public tip form lives on the public site) ----------------------------

  async getSubmissions({ statuses } = {}) {
    const q = new URLSearchParams({ limit: '50', sort: '-createdAt', depth: '0' });
    if (Array.isArray(statuses) && statuses.length) {
      for (const s of statuses) {
        if (!SUBMISSION_STATUSES.includes(s)) throw new ApiError('Unknown status filter.', { status: 400 });
      }
      q.set('where[status][in]', statuses.join(','));
    }
    const data = await this.request('/submissions', { query: q });
    return { data: (data?.docs || []).map(normalizeSubmission), totalDocs: data?.totalDocs ?? 0 };
  }

  async updateSubmission(id, { status, reviewerNotes }) {
    const body = {};
    if (status) {
      if (!SUBMISSION_PATCH_STATUSES.includes(status)) throw new ApiError('Unknown submission status.', { status: 400 });
      body.status = status;
    }
    if (reviewerNotes !== undefined) body.reviewerNotes = reviewerNotes;
    const data = await this.request(`/submissions/${encodeURIComponent(safeId(id))}`, { method: 'PATCH', json: body, query: { depth: '0' } });
    return { data: normalizeSubmission(data.doc) };
  }

  /** The reader tip an article was converted from, or null (also null when the caller may not read tips). */
  async getSubmissionForArticle(articleId) {
    if (!this.can('submission.review')) return null;
    const q = new URLSearchParams({ limit: '1', depth: '0', 'where[article][equals]': safeId(articleId) });
    const data = await this.request('/submissions', { query: q });
    const doc = data?.docs?.[0];
    return doc ? normalizeSubmission(doc) : null;
  }

  /** The ONLY way a tip becomes an article: POST /api/submissions/:id/convert. The CMS creates the draft. */
  async convertSubmission(id, categoryId) {
    const data = await this.request(`/submissions/${encodeURIComponent(safeId(id))}/convert`, {
      method: 'POST',
      json: { category: Number(safeId(categoryId)) }
    });
    const article = data?.article;
    if (!article || article.id === undefined) throw new ApiError('The CMS did not return the new story.', { status: 500 });
    return { articleId: String(article.id), slug: article.slug || '' };
  }

  // ---- live coverage --------------------------------------------------------------------------------------

  async getLiveEvents() {
    const data = await this.request('/live-events', { query: { limit: '50', sort: '-createdAt', depth: '0' } });
    return { data: (data?.docs || []).map(normalizeEvent) };
  }

  async createLiveEvent({ title, categoryId, summary }) {
    const body = { title, category: Number(safeId(categoryId)), status: 'draft' };
    if (summary) body.summary = summary;
    const data = await this.request('/live-events', { method: 'POST', json: body, query: { depth: '0' } });
    return { data: normalizeEvent(data.doc) };
  }

  async setLiveEventStatus(id, status) {
    if (!['draft', 'live', 'ended'].includes(status)) throw new ApiError('Unknown event status.', { status: 400 });
    const data = await this.request(`/live-events/${encodeURIComponent(safeId(id))}`, {
      method: 'PATCH', json: { status }, query: { depth: '0' }
    });
    return { data: normalizeEvent(data.doc) };
  }

  async getLiveUpdates(eventId) {
    const data = await this.request('/live-updates', {
      query: {
        'where[event][equals]': safeId(eventId),
        sort: '-sequence',
        limit: '100',
        depth: '1'
      }
    });
    return { data: (data?.docs || []).map(normalizeUpdate) };
  }

  /** publishNow asks the CMS to publish immediately; it only honours it for editors in scope (otherwise: pending). */
  async postLiveUpdate({ eventId, body, publishNow = false }) {
    const payload = { event: Number(safeId(eventId)), body };
    if (publishNow) payload.status = 'approved';
    const data = await this.request('/live-updates', {
      method: 'POST',
      json: payload,
      query: { depth: '1' }
    });
    return { data: normalizeUpdate(data.doc) };
  }

  async setLiveUpdateStatus(id, status) {
    if (!['approved', 'rejected', 'pending'].includes(status)) throw new ApiError('Unknown update status.', { status: 400 });
    const data = await this.request(`/live-updates/${encodeURIComponent(safeId(id))}`, {
      method: 'PATCH', json: { status }, query: { depth: '1' }
    });
    return { data: normalizeUpdate(data.doc) };
  }

  // ---- media ----------------------------------------------------------------------------------------------

  async getMedia({ search } = {}) {
    const q = new URLSearchParams({ limit: '60', sort: '-createdAt', depth: '0' });
    if (search && search.trim()) q.set('where[alt][like]', search.trim().slice(0, 120));
    const data = await this.request('/media', { query: q });
    return { data: (data?.docs || []).map(normalizeMedia), totalDocs: data?.totalDocs ?? 0 };
  }

  /** Multipart upload: `file` + `_payload` (JSON string with alt/caption/credit). Content-Type is set by the browser. */
  async uploadMedia(file, { alt, caption, credit }) {
    if (!(file instanceof Blob)) throw new ApiError('Choose an image file to upload.', { status: 400 });
    const meta = { alt: String(alt || '').trim() };
    if (!meta.alt) throw new ApiError('Alt text is required.', { status: 400 });
    if (caption) meta.caption = caption;
    if (credit) meta.credit = credit;
    const form = new FormData();
    form.append('_payload', JSON.stringify(meta));
    form.append('file', file, file.name || 'upload');
    const data = await this.request('/media', { method: 'POST', form });
    return { data: normalizeMedia(data.doc) };
  }
}
