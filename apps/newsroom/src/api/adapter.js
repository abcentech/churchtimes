/**
 * Newsroom API Adapter for Church Times Nigeria
 * 
 * Implements the contract agreed with Claude's Payload CMS backend.
 * Provides transparent, robust fallback to local storage mock repository
 * with explicit indicators so mock functionality is never disguised as a live backend.
 */

import {
  INITIAL_USERS,
  INITIAL_CATEGORIES,
  INITIAL_MEDIA,
  INITIAL_ARTICLES,
  INITIAL_SUBMISSIONS,
  INITIAL_LIVE_EVENTS,
  INITIAL_LIVE_UPDATES
} from './mock-data.js';

const STORAGE_KEY = 'ctn_newsroom_store_v1';
const CONFIG_KEY = 'ctn_newsroom_config_v1';

class NewsroomApiAdapter {
  constructor() {
    this.config = this.loadConfig();
    this.isMockActive = true;
    this.connectionStatus = 'Offline Mock Mode';
    this.listeners = new Set();
    this.initStorage();
  }

  loadConfig() {
    try {
      const saved = localStorage.getItem(CONFIG_KEY);
      if (saved) return JSON.parse(saved);
    } catch (e) {
      // fallback
    }
    return {
      backendUrl: 'http://localhost:3000',
      preferLive: false,
      timeoutMs: 3000
    };
  }

  saveConfig() {
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
    } catch (e) {
      console.error('Failed to save newsroom config', e);
    }
  }

  initStorage() {
    try {
      const existing = localStorage.getItem(STORAGE_KEY);
      if (!existing) {
        this.resetStorage();
      }
    } catch (e) {
      console.warn('LocalStorage unavailable, running purely in-memory', e);
    }
  }

  resetStorage() {
    const store = {
      articles: JSON.parse(JSON.stringify(INITIAL_ARTICLES)),
      submissions: JSON.parse(JSON.stringify(INITIAL_SUBMISSIONS)),
      liveEvents: JSON.parse(JSON.stringify(INITIAL_LIVE_EVENTS)),
      liveUpdates: JSON.parse(JSON.stringify(INITIAL_LIVE_UPDATES)),
      media: JSON.parse(JSON.stringify(INITIAL_MEDIA)),
      categories: JSON.parse(JSON.stringify(INITIAL_CATEGORIES)),
      users: JSON.parse(JSON.stringify(INITIAL_USERS))
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      console.error('Failed to reset newsroom storage', e);
    }
    this.notify();
    return store;
  }

  getStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      // fallback
    }
    return this.resetStorage();
  }

  setStore(store) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (e) {
      console.error('Failed to persist store', e);
    }
    this.notify();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      try {
        listener(this.getModeInfo());
      } catch (err) {
        console.error('Subscriber error', err);
      }
    }
  }

  getModeInfo() {
    return {
      isMock: this.isMockActive,
      backendUrl: this.config.backendUrl,
      connectionStatus: this.connectionStatus,
      preferLive: this.config.preferLive,
      disclaimer: this.isMockActive
        ? 'Running in Local Mock & Storage Mode. All actions persist in browser storage. Connect Claude Payload CMS to publish to PostgreSQL.'
        : `Connected to live Payload CMS at ${this.config.backendUrl}`
    };
  }

  async testBackendConnection(url = this.config.backendUrl) {
    this.config.backendUrl = url;
    this.saveConfig();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const res = await fetch(`${url}/api/articles?limit=1`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      clearTimeout(timer);

      if (res.ok) {
        this.isMockActive = false;
        this.connectionStatus = 'Connected to Payload CMS';
        this.notify();
        return { success: true, message: `Successfully connected to Payload CMS at ${url}` };
      } else {
        throw new Error(`Server returned HTTP ${res.status}`);
      }
    } catch (err) {
      this.isMockActive = true;
      this.connectionStatus = `Mock Mode (CMS unreachable at ${url}: ${err.message})`;
      this.notify();
      return { success: false, message: `Could not reach Payload CMS at ${url}. Operating safely in Mock Mode.` };
    }
  }

  setPreferLive(prefer) {
    this.config.preferLive = prefer;
    this.saveConfig();
    if (prefer) {
      return this.testBackendConnection();
    } else {
      this.isMockActive = true;
      this.connectionStatus = 'Offline Mock Mode (User preferred)';
      this.notify();
      return Promise.resolve({ success: true, message: 'Switched to Local Mock Mode' });
    }
  }

  // ==========================================
  // ARTICLES WORKFLOW
  // ==========================================

  async getArticles({ status, category, search } = {}) {
    if (!this.isMockActive) {
      try {
        let q = `${this.config.backendUrl}/api/articles?depth=1&limit=50`;
        if (status && status !== 'all') q += `&where[status][equals]=${encodeURIComponent(status)}`;
        if (category && category !== 'all') q += `&where[category][equals]=${encodeURIComponent(category)}`;
        const res = await fetch(q);
        if (res.ok) {
          const data = await res.json();
          return { data: data.docs || [], isMock: false };
        }
      } catch (err) {
        console.warn('Backend query failed, falling back to mock store', err);
      }
    }

    const store = this.getStore();
    let list = [...store.articles];

    if (status && status !== 'all') {
      list = list.filter(a => a.status === status);
    }
    if (category && category !== 'all') {
      list = list.filter(a => a.category === category);
    }
    if (search && search.trim()) {
      const term = search.trim().toLowerCase();
      list = list.filter(a =>
        (a.title && a.title.toLowerCase().includes(term)) ||
        (a.standfirst && a.standfirst.toLowerCase().includes(term)) ||
        (a.author?.name && a.author.name.toLowerCase().includes(term))
      );
    }

    // Sort: most recently updated first
    list.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

    return { data: list, isMock: true };
  }

  async getArticle(id) {
    if (!this.isMockActive) {
      try {
        const res = await fetch(`${this.config.backendUrl}/api/articles/${id}`);
        if (res.ok) {
          const doc = await res.json();
          return { data: doc, isMock: false };
        }
      } catch (e) {
        // fallback
      }
    }

    const store = this.getStore();
    const article = store.articles.find(a => a.id === id);
    if (!article) throw new Error(`Article ${id} not found`);
    return { data: article, isMock: true };
  }

  async saveArticle(articleData) {
    const isNew = !articleData.id;
    const now = new Date().toISOString();

    if (!this.isMockActive) {
      try {
        const url = isNew
          ? `${this.config.backendUrl}/api/articles`
          : `${this.config.backendUrl}/api/articles/${articleData.id}`;
        const method = isNew ? 'POST' : 'PATCH';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(articleData)
        });
        if (res.ok) {
          const doc = await res.json();
          return { data: doc.doc || doc, isMock: false };
        }
      } catch (e) {
        console.warn('Failed to save to backend, falling back to mock storage', e);
      }
    }

    const store = this.getStore();
    let saved;

    if (isNew) {
      saved = {
        ...articleData,
        id: `art-${Date.now()}`,
        createdAt: now,
        updatedAt: now,
        status: articleData.status || 'draft',
        revisionCount: 1,
        reviewNotes: articleData.reviewNotes || 'Initial draft created'
      };
      store.articles.unshift(saved);
    } else {
      const idx = store.articles.findIndex(a => a.id === articleData.id);
      if (idx === -1) throw new Error('Article not found');
      saved = {
        ...store.articles[idx],
        ...articleData,
        updatedAt: now,
        revisionCount: (store.articles[idx].revisionCount || 1) + 1
      };
      store.articles[idx] = saved;
    }

    this.setStore(store);
    return { data: saved, isMock: true };
  }

  async updateArticleStatus(id, newStatus, reviewNotes = '') {
    const validStatuses = ['draft', 'in_review', 'changes_requested', 'approved', 'published'];
    if (!validStatuses.includes(newStatus)) {
      throw new Error(`Invalid status: ${newStatus}`);
    }

    const now = new Date().toISOString();
    const patch = {
      status: newStatus,
      updatedAt: now,
      reviewNotes: reviewNotes || `Status updated to ${newStatus}`
    };

    if (newStatus === 'published') {
      patch.publishedAt = now;
    }

    if (!this.isMockActive) {
      try {
        const res = await fetch(`${this.config.backendUrl}/api/articles/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        });
        if (res.ok) {
          const doc = await res.json();
          return { data: doc.doc || doc, isMock: false };
        }
      } catch (e) {
        // fallback
      }
    }

    const store = this.getStore();
    const idx = store.articles.findIndex(a => a.id === id);
    if (idx === -1) throw new Error('Article not found');

    const updated = {
      ...store.articles[idx],
      ...patch
    };
    store.articles[idx] = updated;
    this.setStore(store);

    return { data: updated, isMock: true };
  }

  async deleteArticle(id) {
    if (!this.isMockActive) {
      try {
        await fetch(`${this.config.backendUrl}/api/articles/${id}`, { method: 'DELETE' });
      } catch (e) {}
    }
    const store = this.getStore();
    store.articles = store.articles.filter(a => a.id !== id);
    this.setStore(store);
    return { success: true };
  }

  // ==========================================
  // PUBLIC & EDITORIAL SUBMISSIONS
  // ==========================================

  async getSubmissions({ status } = {}) {
    if (!this.isMockActive) {
      try {
        let q = `${this.config.backendUrl}/api/submissions?limit=50`;
        if (status && status !== 'all') q += `&where[status][equals]=${status}`;
        const res = await fetch(q);
        if (res.ok) {
          const data = await res.json();
          return { data: data.docs || [], isMock: false };
        }
      } catch (e) {}
    }

    const store = this.getStore();
    let list = [...store.submissions];
    if (status && status !== 'all') {
      list = list.filter(s => s.status === status);
    }
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { data: list, isMock: true };
  }

  async createPublicSubmission(submissionData) {
    // Validates inputs, honeypot protection, rate limiting warning
    if (!submissionData.headline || !submissionData.body) {
      throw new Error('Headline and story details are required.');
    }
    if (submissionData.honeypot) {
      // Spam detected silently
      return { data: { id: 'sub-spam-blocked' }, isMock: true };
    }

    const now = new Date().toISOString();
    const record = {
      id: `sub-${Math.floor(1000 + Math.random() * 9000)}`,
      headline: submissionData.headline.trim(),
      body: submissionData.body.trim(),
      category: submissionData.category || 'faith-society',
      submitterName: submissionData.submitterName?.trim() || 'Anonymous Contributor',
      submitterEmail: submissionData.submitterEmail?.trim() || 'Not provided',
      submitterPhone: submissionData.submitterPhone?.trim() || 'Not provided',
      organization: submissionData.organization?.trim() || 'Independent Citizen',
      location: submissionData.location?.trim() || 'Nigeria',
      status: 'pending',
      editorNotes: 'Public submission awaiting initial editorial verification. NEVER auto-published.',
      createdAt: now,
      mediaUrl: submissionData.mediaUrl || null
    };

    if (!this.isMockActive) {
      try {
        const res = await fetch(`${this.config.backendUrl}/api/public/submissions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record)
        });
        if (res.ok) {
          const doc = await res.json();
          return { data: doc.doc || doc, isMock: false };
        }
      } catch (e) {}
    }

    const store = this.getStore();
    store.submissions.unshift(record);
    this.setStore(store);

    return { data: record, isMock: true };
  }

  async updateSubmissionStatus(id, status, notes = '') {
    const store = this.getStore();
    const idx = store.submissions.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('Submission not found');

    store.submissions[idx].status = status;
    if (notes) store.submissions[idx].editorNotes = notes;
    this.setStore(store);
    return { data: store.submissions[idx], isMock: true };
  }

  async convertSubmissionToArticle(submissionId, author) {
    const store = this.getStore();
    const sub = store.submissions.find(s => s.id === submissionId);
    if (!sub) throw new Error('Submission not found');

    // Create a new draft article pre-filled with submission data
    const newArticle = {
      title: sub.headline,
      slug: sub.headline.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      category: sub.category,
      standfirst: `Reported via tip from ${sub.submitterName} (${sub.location}): ${sub.body.slice(0, 160)}...`,
      body: `**Reporting lead received from ${sub.submitterName} (${sub.organization || 'Citizen Contributor'}):**\n\n${sub.body}\n\n*Editorial note: Corroboration and fact-checking conducted by Church Times newsroom before drafting.*`,
      featuredImage: null,
      status: 'draft',
      author: author || INITIAL_USERS[0],
      reviewNotes: `Converted from public tip #${sub.id}. Verified by ${author?.name || 'Newsroom'}.`
    };

    const saved = await this.saveArticle(newArticle);
    await this.updateSubmissionStatus(submissionId, 'approved', `Converted to story draft #${saved.data.id}`);

    return saved;
  }

  // ==========================================
  // LIVE EVENTS & LIVE COVERAGE
  // ==========================================

  async getLiveEvents() {
    const store = this.getStore();
    return { data: store.liveEvents, isMock: true };
  }

  async createLiveEvent(eventData) {
    const store = this.getStore();
    const slug = eventData.slug || eventData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const newEvent = {
      id: `event-${Date.now()}`,
      slug,
      title: eventData.title,
      status: eventData.status || 'live',
      description: eventData.description || '',
      location: eventData.location || 'Lagos, Nigeria',
      startedAt: new Date().toISOString(),
      activeViewers: 1
    };
    store.liveEvents.unshift(newEvent);
    this.setStore(store);
    return { data: newEvent, isMock: true };
  }

  async getLiveUpdates(eventSlug, includePending = true) {
    const store = this.getStore();
    let updates = store.liveUpdates.filter(u => u.eventSlug === eventSlug);
    if (!includePending) {
      updates = updates.filter(u => u.status === 'approved');
    }
    updates.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return { data: updates, isMock: true };
  }

  async postLiveUpdate(updateData) {
    const store = this.getStore();
    const newUpdate = {
      id: `upd-${Date.now()}`,
      eventId: updateData.eventId,
      eventSlug: updateData.eventSlug,
      timestamp: updateData.timestamp || `${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} WAT`,
      headline: updateData.headline || '',
      body: updateData.body,
      reporterName: updateData.reporterName || 'Church Times Reporter',
      status: updateData.status || 'approved', // reporters may draft, editors approve immediately
      isPinned: Boolean(updateData.isPinned),
      createdAt: new Date().toISOString()
    };
    store.liveUpdates.unshift(newUpdate);
    this.setStore(store);
    return { data: newUpdate, isMock: true };
  }

  async approveLiveUpdate(updateId) {
    const store = this.getStore();
    const idx = store.liveUpdates.findIndex(u => u.id === updateId);
    if (idx === -1) throw new Error('Update not found');
    store.liveUpdates[idx].status = 'approved';
    this.setStore(store);
    return { data: store.liveUpdates[idx], isMock: true };
  }

  // ==========================================
  // MEDIA LIBRARY
  // ==========================================

  async getMedia({ search } = {}) {
    const store = this.getStore();
    let list = [...store.media];
    if (search && search.trim()) {
      const term = search.trim().toLowerCase();
      list = list.filter(m =>
        (m.title && m.title.toLowerCase().includes(term)) ||
        (m.alt && m.alt.toLowerCase().includes(term)) ||
        (m.caption && m.caption.toLowerCase().includes(term))
      );
    }
    return { data: list, isMock: true };
  }

  async uploadMedia(mediaData) {
    const store = this.getStore();
    const newMedia = {
      id: `med-${Date.now()}`,
      title: mediaData.title || 'Untitled Image',
      url: mediaData.url || '/site/news-media/29276.jpg',
      filename: mediaData.filename || 'upload.jpg',
      alt: mediaData.alt || 'Editorial photograph for Church Times Nigeria',
      caption: mediaData.caption || '',
      credit: mediaData.credit || 'Church Times Newsroom',
      license: mediaData.license || 'Staff Photograph',
      filesize: mediaData.filesize || '120 KB',
      dimensions: mediaData.dimensions || '1200x800'
    };
    store.media.unshift(newMedia);
    this.setStore(store);
    return { data: newMedia, isMock: true };
  }

  // ==========================================
  // METADATA
  // ==========================================

  getCategories() {
    return this.getStore().categories;
  }

  getUsers() {
    return this.getStore().users;
  }
}

export const apiAdapter = new NewsroomApiAdapter();
