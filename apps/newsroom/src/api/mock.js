/**
 * DEVELOPMENT-ONLY mock backend (localStorage). Loaded through a dynamic import() guarded by `MOCK`
 * (import.meta.env.DEV && VITE_NEWSROOM_MOCK=1), so it never ships in a production build.
 * Implements the same interface as CmsAdapter, in the same view-model shapes.
 */

import {
  INITIAL_USERS, INITIAL_CATEGORIES, INITIAL_MEDIA, INITIAL_ARTICLES,
  INITIAL_SUBMISSIONS, INITIAL_LIVE_EVENTS, INITIAL_LIVE_UPDATES
} from './mock-data.js';
import { can, normRole } from '../permissions.js';
import { ApiError } from './errors.js';
import { STALE_MESSAGE, versionMatches } from '../stale-guard.js';

const STORAGE_KEY = 'ctn_mock_store_v2';
const ARTICLE_STATUSES = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published', 'archived'];
// Dev-only mock accounts; the mock "server" accepts this password. Not shipped in production builds.
const MOCK_PASSWORD = 'mock-only-password';

const clone = v => JSON.parse(JSON.stringify(v));
const forbidden = () => new ApiError('You are not permitted to do that.', { status: 403 });

function seed() {
  const users = INITIAL_USERS.filter(u => u.role !== 'public').map(u => ({
    id: u.id, name: u.name, email: u.email, role: normRole(u.role), sections: 'all', avatar: u.avatar
  }));
  const media = INITIAL_MEDIA.map(m => ({
    id: m.id, url: m.url, thumbUrl: m.url, alt: m.alt, caption: m.caption, credit: m.credit, filename: m.filename
  }));
  const catTitle = id => INITIAL_CATEGORIES.find(c => c.id === id)?.title || '';
  const articles = INITIAL_ARTICLES.map(a => ({
    id: a.id, title: a.title, slug: a.slug, standfirst: a.standfirst, bodyMd: a.body, lossy: false,
    categoryId: a.category, categoryTitle: catTitle(a.category),
    featuredImage: a.featuredImage ? media.find(m => m.id === a.featuredImage.id) || null : null,
    status: a.status, authorId: a.author?.id || null, authorName: a.author?.name || '',
    updatedAt: a.updatedAt, createdAt: a.createdAt, publishedAt: a.publishedAt || null,
    scheduledFor: null, reviewNotes: a.reviewNotes || '', corrections: []
  }));
  const submissions = INITIAL_SUBMISSIONS.map(s => ({
    id: s.id, reference: `SUB-${s.id.replace('sub-', '')}`, title: s.headline, body: s.body,
    name: s.submitterName, email: s.submitterEmail, phone: s.submitterPhone || '', location: s.location || '',
    categorySuggestion: INITIAL_CATEGORIES.find(c => c.id === s.category)?.title || '',
    status: s.status === 'pending' ? 'new' : s.status === 'in_review' ? 'under_review' : s.status,
    reviewerNotes: s.editorNotes || '', articleId: null, createdAt: s.createdAt
  }));
  const events = INITIAL_LIVE_EVENTS.map(e => ({
    id: e.id, slug: e.slug, title: e.title, summary: e.description, status: e.status === 'upcoming' ? 'draft' : e.status,
    categoryId: 'faith-society', startedAt: e.startedAt, endedAt: null
  }));
  const updates = INITIAL_LIVE_UPDATES.map((u, i) => ({
    id: u.id, eventId: u.eventId, body: u.headline ? `${u.headline}: ${u.body}` : u.body,
    status: u.status === 'pending_review' ? 'pending' : u.status, sequence: i + 1,
    occurredAt: u.createdAt, updatedAt: u.createdAt, authorName: u.reporterName
  }));
  return { users, media, articles, submissions, events, updates, categories: clone(INITIAL_CATEGORIES) };
}

export class MockAdapter {
  constructor() {
    this.mode = 'mock';
    this.isMock = true;
    this.listeners = new Set();
    this.db = this.load();
    this.currentUser = clone(this.db.users[0]); // dev convenience: start as the reporter
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    const db = seed();
    this.persist(db);
    return db;
  }

  persist(db = this.db) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* ignore */ }
  }

  reset() {
    this.db = seed();
    this.persist();
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event, data) { for (const fn of this.listeners) { try { fn(event, data); } catch (e) { console.error(e); } } }
  getModeInfo() { return { isMock: true, label: 'LOCAL MOCK MODE', detail: 'Development mock backend. Edits persist in this browser only.' }; }

  // session
  async restoreSession() { return this.currentUser; }
  async login({ email, password }) {
    const user = this.db.users.find(u => u.email.toLowerCase() === String(email || '').trim().toLowerCase());
    if (!user || password !== MOCK_PASSWORD) throw new ApiError('The email or password provided is incorrect.', { status: 401 });
    this.currentUser = clone(user);
    this.emit('session', this.currentUser);
    return this.currentUser;
  }
  async refreshSession() { return Boolean(this.currentUser); }
  async logout() { this.currentUser = null; this.emit('session', null); return { ok: true }; }
  getCurrentUser() { return this.currentUser; }
  can(action, ctx) { return can(this.currentUser, action, ctx); }
  getMockUsers() { return this.db.users; }
  switchMockUser(id) {
    const user = this.db.users.find(u => u.id === id);
    if (user) { this.currentUser = clone(user); this.emit('session', this.currentUser); }
    return this.currentUser;
  }
  get mockPassword() { return MOCK_PASSWORD; }

  async getCategories() { return clone(this.db.categories); }

  // articles
  _ctx(a) {
    return { status: a.status, categoryId: a.categoryId, isAuthor: a.authorId === this.currentUser?.id };
  }
  async getArticles({ status, categoryId, search } = {}) {
    let list = [...this.db.articles];
    if (status && status !== 'all') list = list.filter(a => a.status === status);
    if (categoryId && categoryId !== 'all') list = list.filter(a => a.categoryId === categoryId);
    if (search && search.trim()) {
      const t = search.trim().toLowerCase();
      list = list.filter(a => a.title.toLowerCase().includes(t) || (a.authorName || '').toLowerCase().includes(t));
    }
    list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    return { data: clone(list), totalDocs: list.length };
  }
  async getArticleCounts() {
    return Object.fromEntries(ARTICLE_STATUSES.map(s => [s, this.db.articles.filter(a => a.status === s).length]));
  }
  async getArticle(id) {
    const a = this.db.articles.find(x => x.id === id);
    if (!a) throw new ApiError('Story not found.', { status: 404 });
    return { data: clone(a) };
  }
  _apply(a, f) {
    if ('title' in f) a.title = f.title;
    if ('slug' in f && f.slug) a.slug = f.slug;
    if ('standfirst' in f) a.standfirst = f.standfirst;
    if ('bylineName' in f) { a.bylineName = f.bylineName; a.authorName = f.bylineName || a.authorName; }
    if ('bodyMd' in f) a.bodyMd = f.bodyMd;
    if ('categoryId' in f) {
      a.categoryId = f.categoryId;
      a.categoryTitle = this.db.categories.find(c => c.id === f.categoryId)?.title || '';
    }
    if ('featuredImageId' in f) a.featuredImage = this.db.media.find(m => m.id === f.featuredImageId) || null;
    a.updatedAt = new Date().toISOString();
  }
  async createArticle(fields) {
    if (!fields.title?.trim()) throw new ApiError('title: This field is required.', { status: 400 });
    const a = {
      id: `art-${Date.now()}`, title: '', slug: '', standfirst: '', bodyMd: '', lossy: false,
      categoryId: this.db.categories[0].id, categoryTitle: this.db.categories[0].title, featuredImage: null,
      status: 'draft', authorId: this.currentUser.id, authorName: this.currentUser.name,
      createdAt: new Date().toISOString(), publishedAt: null, scheduledFor: null, reviewNotes: '', corrections: []
    };
    this._apply(a, fields);
    this.db.articles.unshift(a);
    this.persist();
    return { data: clone(a) };
  }
  async updateArticle(id, changes, { expectedUpdatedAt } = {}) {
    const a = this.db.articles.find(x => x.id === id);
    if (!a) throw new ApiError('Story not found.', { status: 404 });
    if (!can(this.currentUser, 'story.edit', this._ctx(a))) throw forbidden();
    if (!versionMatches(a.updatedAt, expectedUpdatedAt)) throw new ApiError(STALE_MESSAGE, { status: 409 });
    this._apply(a, changes);
    this.persist();
    return { data: clone(a) };
  }
  async transitionArticle(id, status, { reviewNotes, expectedUpdatedAt } = {}) {
    const a = this.db.articles.find(x => x.id === id);
    if (!a) throw new ApiError('Story not found.', { status: 404 });
    if (!versionMatches(a.updatedAt, expectedUpdatedAt)) throw new ApiError(STALE_MESSAGE, { status: 409 });
    const action = {
      in_review: 'story.submit_review', approved: 'story.approve', changes_requested: 'story.request_changes',
      published: 'story.publish', archived: 'story.archive'
    }[status];
    if (!action || !can(this.currentUser, action, this._ctx(a))) throw forbidden();
    a.status = status;
    if (reviewNotes !== undefined) a.reviewNotes = reviewNotes;
    if (status === 'published' && !a.publishedAt) a.publishedAt = new Date().toISOString();
    a.updatedAt = new Date().toISOString();
    this.persist();
    return { data: clone(a) };
  }
  async scheduleArticle(id, scheduledForIso) {
    const a = this.db.articles.find(x => x.id === id);
    if (!a) throw new ApiError('Story not found.', { status: 404 });
    if (!can(this.currentUser, 'story.schedule', this._ctx(a))) throw forbidden();
    const when = new Date(scheduledForIso);
    if (Number.isNaN(when.getTime())) throw new ApiError('scheduledFor is required to schedule an article.', { status: 400 });
    if (when.getTime() <= Date.now()) throw new ApiError('scheduledFor must be in the future.', { status: 400 });
    a.status = 'scheduled';
    a.scheduledFor = when.toISOString();
    a.updatedAt = new Date().toISOString();
    this.persist();
    return { data: clone(a) };
  }
  async deleteArticle(id) {
    if (!can(this.currentUser, 'story.delete')) throw forbidden();
    this.db.articles = this.db.articles.filter(a => a.id !== id);
    this.persist();
    return { ok: true };
  }

  // submissions
  async getSubmissions({ statuses } = {}) {
    let list = [...this.db.submissions];
    if (statuses?.length) list = list.filter(s => statuses.includes(s.status));
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { data: clone(list), totalDocs: list.length };
  }
  async getSubmissionForArticle(articleId) {
    if (!can(this.currentUser, 'submission.review')) return null;
    const s = this.db.submissions.find(x => x.articleId === articleId);
    return s ? clone(s) : null;
  }
  async updateSubmission(id, { status, reviewerNotes }) {
    if (!can(this.currentUser, 'submission.review')) throw forbidden();
    const s = this.db.submissions.find(x => x.id === id);
    if (!s) throw new ApiError('Not found.', { status: 404 });
    if (status) s.status = status;
    if (reviewerNotes !== undefined) s.reviewerNotes = reviewerNotes;
    this.persist();
    return { data: clone(s) };
  }
  async convertSubmission(id, categoryId) {
    if (!can(this.currentUser, 'submission.convert')) throw forbidden();
    const s = this.db.submissions.find(x => x.id === id);
    if (!s) throw new ApiError('Not found.', { status: 404 });
    if (s.status === 'converted') throw new ApiError('This submission was already converted.', { status: 409 });
    const { data } = await this.createArticle({
      title: s.title,
      slug: s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      bodyMd: s.body,
      categoryId
    });
    s.status = 'converted';
    s.articleId = data.id;
    this.persist();
    return { articleId: data.id, slug: data.slug };
  }

  // live
  async getLiveEvents() { return { data: clone(this.db.events) }; }
  async createLiveEvent({ title, categoryId, summary }) {
    const e = {
      id: `event-${Date.now()}`, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), title,
      summary: summary || '', status: 'draft', categoryId, startedAt: null, endedAt: null
    };
    this.db.events.unshift(e);
    this.persist();
    return { data: clone(e) };
  }
  async setLiveEventStatus(id, status) {
    if (!can(this.currentUser, 'live.manage')) throw forbidden();
    const e = this.db.events.find(x => x.id === id);
    if (!e) throw new ApiError('Not found.', { status: 404 });
    e.status = status;
    this.persist();
    return { data: clone(e) };
  }
  async getLiveUpdates(eventId) {
    const list = this.db.updates.filter(u => u.eventId === eventId).sort((a, b) => b.sequence - a.sequence);
    return { data: clone(list) };
  }
  async postLiveUpdate({ eventId, body, imageId = null }) {
    const isEditor = normRole(this.currentUser.role) !== 'reporter';
    const image = imageId ? this.db.media.find(m => String(m.id) === String(imageId)) || null : null;
    if (imageId && !image) throw new ApiError('The selected image does not exist.', { status: 400 });
    if (image && !String(image.alt || '').trim()) throw new ApiError('The image needs alt text before it can be used.', { status: 400 });
    const u = {
      id: `upd-${Date.now()}`, eventId, body, image: image ? clone(image) : null, status: isEditor ? 'approved' : 'pending',
      sequence: this.db.updates.length + 1, occurredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      authorName: this.currentUser.name
    };
    this.db.updates.unshift(u);
    this.persist();
    return { data: clone(u) };
  }
  async setLiveUpdateStatus(id, status, { expectedUpdatedAt } = {}) {
    if (!can(this.currentUser, 'live.approve', { categoryId: 'faith-society' })) throw forbidden();
    const u = this.db.updates.find(x => x.id === id);
    if (!u) throw new ApiError('Not found.', { status: 404 });
    if (!versionMatches(u.updatedAt, expectedUpdatedAt)) throw new ApiError(STALE_MESSAGE, { status: 409 });
    u.status = status;
    u.updatedAt = new Date().toISOString();
    this.persist();
    return { data: clone(u) };
  }

  // media
  async getMedia({ search } = {}) {
    let list = [...this.db.media];
    if (search && search.trim()) {
      const t = search.trim().toLowerCase();
      list = list.filter(m => (m.alt || '').toLowerCase().includes(t) || (m.caption || '').toLowerCase().includes(t));
    }
    return { data: clone(list), totalDocs: list.length };
  }
  async uploadMedia(file, { alt, caption, credit }) {
    if (!alt?.trim()) throw new ApiError('Alt text is required.', { status: 400 });
    const m = {
      id: `${Date.now()}`, url: '/site/news-media/29276.jpg', thumbUrl: '/site/news-media/29276.jpg',
      alt, caption: caption || '', credit: credit || '', filename: file?.name || 'upload.jpg'
    };
    this.db.media.unshift(m);
    this.persist();
    return { data: clone(m) };
  }
}
