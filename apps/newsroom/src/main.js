/**
 * Newsroom SPA entry point (Church Times Nigeria staff app).
 *
 * Boot sequence: choose the adapter (live CMS; mock only in a dev server with VITE_NEWSROOM_MOCK=1), ask the CMS
 * who we are (GET /api/users/me). Without a server-verified user only the sign-in screen is reachable.
 */

import { initApi, api, getDevUi } from './api/index.js';
import { PUBLIC_SITE_URL } from './config.js';
import { store } from './store.js';
import { showToast } from './components/toast.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderEditor, flushEditor } from './views/editor.js';
import { renderReview } from './views/review.js';
import { renderLive, stopLivePolling } from './views/live.js';
import { renderMedia } from './views/media.js';
import { escapeHtml, formatRoleName } from './util.js';

const ID_RE = /^\d+$/;

class NewsroomApp {
  constructor() {
    this.mainEl = document.getElementById('main-content');
    this.sessionChipEl = document.getElementById('session-chip');
    this.themeToggleBtn = document.getElementById('theme-toggle-btn');
    this.lastView = null;
    this.host = null;
    this.loginNotice = '';
    this.returnHash = '';
    this.navToken = 0; // incremented by every route() call; older (stale) calls stop after their next await
  }

  async start() {
    this.initTheme();
    this.initNavLinks();
    this.initKeyboardShortcuts();
    this.initPublicLink();

    try {
      await initApi();
    } catch (err) {
      console.error(err);
      this.showBootError('The newsroom failed to start.');
      return;
    }

    this.updateModeBanner();
    api.subscribe((event) => {
      if (event === 'unauthorized') this.onSessionLost('Your session has ended. Please sign in again.', { keepReturn: true });
      else if (event === 'session') {
        this.updateSessionDisplay();
        getDevUi()?.syncMockRolePicker(api);
      }
    });

    const devUi = getDevUi();
    if (devUi) {
      devUi.installMockUi({ adapter: api, onSwitch: () => { this.updateSessionDisplay(); this.route(); } });
    }

    try {
      await api.restoreSession();
    } catch (err) {
      this.showBootError(err.message);
      return;
    }

    window.addEventListener('hashchange', () => this.route());
    store.subscribe((event, data) => {
      if (event === 'view_changed') {
        const id = data.payload?.storyId;
        window.location.hash = data.view + (id ? `?id=${encodeURIComponent(id)}` : '');
      }
    });
    this.updateSessionDisplay();
    await this.route();
  }

  /** Each route renders into its own container so a slow, stale view can never overwrite a newer one. */
  newHost() {
    const host = document.createElement('div');
    host.className = 'view-host';
    this.mainEl.replaceChildren(host);
    return host;
  }

  showBootError(message) {
    document.body.dataset.auth = 'out';
    this.mainEl.innerHTML = `
      <section class="card login-card" data-testid="boot-error" role="alert" style="max-width: 32rem; margin: 3rem auto; padding: 1.5rem;">
        <h1 class="view-title" style="font-size: 1.35rem;">Cannot reach the CMS</h1>
        <p id="boot-error-text" style="color: var(--color-muted); margin: 0.5rem 0 1rem;"></p>
        <button type="button" class="btn btn-primary" id="btn-retry-boot" data-testid="boot-retry">Try again</button>
      </section>`;
    this.mainEl.querySelector('#boot-error-text').textContent = message;
    this.mainEl.querySelector('#btn-retry-boot').addEventListener('click', () => window.location.reload());
  }

  // ---- session --------------------------------------------------------------------------------------

  updateSessionDisplay() {
    const user = api.getCurrentUser();
    document.body.dataset.auth = user ? 'in' : 'out';
    if (!this.sessionChipEl) return;
    if (!user) {
      this.sessionChipEl.innerHTML = '';
      return;
    }
    this.sessionChipEl.innerHTML = `
      <div class="session-user-badge" id="session-user-badge" data-testid="session-user" title="${escapeHtml(user.email || user.name)}">
        <span class="session-avatar">${escapeHtml(user.avatar || String(user.name).slice(0, 2).toUpperCase())}</span>
        <div class="session-meta">
          <span class="session-user-name" data-testid="session-user-name">${escapeHtml(user.name)}</span>
          <span class="badge badge-role" data-testid="session-user-role" data-role="${escapeHtml(user.role)}">${escapeHtml(formatRoleName(user.role))}</span>
        </div>
      </div>
      <button type="button" class="btn btn-outline btn-xs" id="btn-staff-logout" data-testid="logout" aria-label="Sign out of newsroom session">Log out</button>`;
    this.sessionChipEl.querySelector('#btn-staff-logout').addEventListener('click', async () => {
      const result = await api.logout();
      if (result && result.ok === false) {
        showToast('Signed out in this browser, but the CMS did not confirm the logout. The server session may still be active: close this browser window or sign out from another device.', 'error', 9000);
      } else {
        showToast('Logged out. Session cleared.', 'info');
      }
      this.onSessionLost('You have been signed out.');
    });
  }

  /** No server-verified user: drop everything and show the sign-in screen only. */
  onSessionLost(notice, { keepReturn = false } = {}) {
    stopLivePolling();
    const current = window.location.hash.slice(1);
    this.returnHash = keepReturn && current && current !== 'login' ? current : '';
    this.updateSessionDisplay();
    this.loginNotice = notice || '';
    if (window.location.hash && window.location.hash !== '#login') {
      history.replaceState(null, '', '#login');
    }
    this.route();
  }

  showLogin() {
    document.body.dataset.auth = 'out';
    const notice = this.loginNotice;
    this.loginNotice = '';
    renderLogin(this.host || (this.host = this.newHost()), {
      notice,
      onSuccess: async (user) => {
        showToast(`Welcome, ${user.name}! Signed in as ${formatRoleName(user.role)}.`, 'success');
        this.updateSessionDisplay();
        getDevUi()?.syncMockRolePicker(api);
        history.replaceState(null, '', this.returnHash ? `#${this.returnHash}` : '#dashboard');
        this.returnHash = '';
        await this.route();
      }
    });
  }

  // ---- chrome ---------------------------------------------------------------------------------------

  initTheme() {
    if (!this.themeToggleBtn) return;
    let saved = 'light';
    try { saved = localStorage.getItem('ctn_theme') || 'light'; } catch { /* ignore */ }
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      this.themeToggleBtn.textContent = 'Light';
    }
    this.themeToggleBtn.addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (dark) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'dark');
      this.themeToggleBtn.textContent = dark ? 'Dark' : 'Light';
      try { localStorage.setItem('ctn_theme', dark ? 'light' : 'dark'); } catch { /* ignore */ }
    });
  }

  updateModeBanner() {
    const info = api.getModeInfo();
    const banner = document.getElementById('mode-banner');
    const badge = document.getElementById('mode-banner-badge');
    const text = document.getElementById('mode-banner-desc');
    if (!banner || !badge || !text) return;
    banner.className = info.isMock ? 'mode-banner' : 'mode-banner is-live';
    badge.textContent = info.label;
    text.textContent = info.detail;
  }

  initPublicLink() {
    const link = document.getElementById('nav-public-site-link');
    if (link && PUBLIC_SITE_URL) {
      link.href = `${PUBLIC_SITE_URL}/#submit`;
      link.hidden = false;
    }
  }

  initNavLinks() {
    document.getElementById('nav-quick-write-btn')?.addEventListener('click', () => {
      store.setCurrentView('editor', { storyId: null });
    });
    document.querySelectorAll('[data-view-nav]').forEach(link => {
      link.addEventListener('click', () => {
        const view = link.getAttribute('data-view-nav');
        if (view) store.setCurrentView(view);
      });
    });
  }

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (!api.getCurrentUser()) return;
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        const map = { 1: 'dashboard', 2: 'editor', 3: 'review', 4: 'live', 5: 'media' };
        if (map[e.key]) { e.preventDefault(); store.setCurrentView(map[e.key]); }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        const saveBtn = document.getElementById('btn-save-draft');
        if (saveBtn && !saveBtn.disabled) { e.preventDefault(); saveBtn.click(); }
      }
    });
  }

  // ---- router ---------------------------------------------------------------------------------------

  async route() {
    // Navigation token: route() is async and can be re-entered (hash changes, session events). Only the latest call may
    // create a host or render; every earlier call returns as soon as it resumes from an await.
    const token = ++this.navToken;
    const isStale = () => token !== this.navToken;
    const hash = window.location.hash.slice(1) || 'dashboard';
    const [viewName, queryString] = hash.split('?');
    const params = new URLSearchParams(queryString || '');

    // Leaving the editor: stop timers and flush a pending autosave while its DOM still exists.
    if (this.lastView === 'editor') {
      if (this.host) await flushEditor(this.host);
      if (isStale()) return;
    }
    stopLivePolling();

    const user = api.getCurrentUser(); // read after the flush: the session may have ended meanwhile
    if (!user) {
      this.host = this.newHost();
      if (viewName !== 'login' && !this.returnHash) this.returnHash = hash;
      this.lastView = 'login';
      this.showLogin();
      return;
    }
    if (viewName === 'login') {
      window.location.hash = '#dashboard';
      return;
    }
    // A revoked/expired session reads as anonymous (200), never 401: confirm it with the server before rendering a staff view.
    if (!api.isMock) {
      const valid = await api.verifySession();
      if (isStale()) return;
      if (!valid) return;
    }

    document.body.dataset.auth = 'in';
    const rawId = params.get('id');
    let storyId = null;
    if (rawId) {
      if (!api.isMock && !ID_RE.test(rawId)) {
        showToast('That story link is not valid.', 'error');
        window.location.hash = '#dashboard';
        return;
      }
      storyId = rawId;
    }

    const host = this.newHost();
    this.host = host;
    this.lastView = viewName;
    store.currentView = viewName;
    this.updateNavActiveStates(viewName);

    switch (viewName) {
      case 'editor': await renderEditor(host, storyId); break;
      case 'review': await renderReview(host, storyId); break;
      case 'live': await renderLive(host); break;
      case 'media': await renderMedia(host); break;
      case 'submit': this.renderPublicTipNotice(host); break;
      case 'dashboard':
      default:
        await renderDashboard(host);
        break;
    }

    if (isStale()) return;
    this.updateBadges();
    window.scrollTo(0, 0);
  }

  renderPublicTipNotice(host) {
    host.innerHTML = `
      <div class="card" style="padding: 2rem; max-width: 40rem; margin: 1rem auto;" data-testid="public-tip-notice">
        <h1 class="view-title" style="font-size: 1.35rem;">Reader tips are submitted on the public site</h1>
        <p style="margin: 0.75rem 0;">The story and tip form is part of the public Church Times Nigeria website. Tips arrive in the
          <a href="#review">Review Queue</a> under Reader Tips, where editors can review and convert them.</p>
        ${PUBLIC_SITE_URL ? `<p><a class="btn btn-outline" href="${escapeHtml(PUBLIC_SITE_URL)}/#submit" target="_blank" rel="noopener noreferrer" data-testid="public-tip-form-link">Open the public submission form</a></p>` : ''}
      </div>`;
  }

  updateNavActiveStates(activeView) {
    document.querySelectorAll('[data-view-nav]').forEach(el => {
      const match = el.getAttribute('data-view-nav') === activeView;
      el.classList.toggle('active', match);
      if (el.tagName.toLowerCase() === 'a') el.setAttribute('aria-current', match ? 'page' : 'false');
    });
  }

  async updateBadges() {
    try {
      const counts = await api.getArticleCounts();
      let total = counts.in_review || 0;
      if (api.can('submission.review')) {
        total += (await api.getSubmissions({ statuses: ['new', 'under_review'] })).totalDocs || 0;
      }
      document.querySelectorAll('.review-count-badge').forEach(badge => {
        badge.textContent = String(total);
        badge.style.display = total > 0 ? 'inline-block' : 'none';
      });
    } catch { /* badges are decorative; errors surface in the views */ }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new NewsroomApp().start();
});
