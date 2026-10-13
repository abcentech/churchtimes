/**
 * Main Newsroom Application Entry Point
 * Church Times Nigeria
 */

import { apiAdapter } from './api/adapter.js';
import { store } from './store.js';
import { showToast } from './components/toast.js';
import { openModal, closeModal } from './components/modal.js';
import { renderDashboard } from './views/dashboard.js';
import { renderEditor } from './views/editor.js';
import { renderReview } from './views/review.js';
import { renderSubmit } from './views/submit.js';
import { renderLive } from './views/live.js';
import { renderMedia } from './views/media.js';

class NewsroomApp {
  constructor() {
    this.mainEl = document.getElementById('main-content');
    this.modeBannerEl = document.getElementById('mode-banner');
    this.roleSelect = document.getElementById('user-role-select');
    this.themeToggleBtn = document.getElementById('theme-toggle-btn');
  }

  init() {
    this.initRolePicker();
    this.initTheme();
    this.initModeBanner();
    this.initNavLinks();
    this.initKeyboardShortcuts();
    this.initRouter();
    this.updateBadges();

    // Subscribe to store changes
    store.subscribe((event, data) => {
      if (event === 'user_changed') {
        showToast(`Switched active role: ${data.name} (${data.role})`, 'info');
        this.route();
      } else if (event === 'view_changed') {
        this.updateNavActiveStates(data.view);
        window.location.hash = data.view + (data.payload?.storyId ? `?id=${data.payload.storyId}` : '');
      }
    });

    apiAdapter.subscribe(() => {
      this.updateModeBanner();
      this.updateBadges();
    });
  }

  initRolePicker() {
    if (!this.roleSelect) return;
    const users = apiAdapter.getUsers();
    this.roleSelect.innerHTML = users.map(u => `
      <option value="${u.id}" ${u.id === store.getCurrentUser().id ? 'selected' : ''}>
        ${u.name} (${formatRoleName(u.role)})
      </option>
    `).join('');

    this.roleSelect.addEventListener('change', () => {
      store.setCurrentUser(this.roleSelect.value);
    });
  }

  initTheme() {
    if (!this.themeToggleBtn) return;
    const savedTheme = localStorage.getItem('ctn_theme') || 'light';
    if (savedTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      this.themeToggleBtn.textContent = '☀️';
    }

    this.themeToggleBtn.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('ctn_theme', 'light');
        this.themeToggleBtn.textContent = '🌙';
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('ctn_theme', 'dark');
        this.themeToggleBtn.textContent = '☀️';
      }
    });
  }

  initModeBanner() {
    this.updateModeBanner();

    const configBtn = document.getElementById('btn-cms-settings');
    if (configBtn) {
      configBtn.addEventListener('click', () => this.openCmsSettingsModal());
    }
  }

  updateModeBanner() {
    const info = apiAdapter.getModeInfo();
    const banner = document.getElementById('mode-banner');
    const badge = document.getElementById('mode-banner-badge');
    const text = document.getElementById('mode-banner-desc');
    if (!banner || !badge || !text) return;

    if (info.isMock) {
      banner.className = 'mode-banner';
      badge.textContent = 'LOCAL MOCK MODE';
      text.textContent = 'Running in Local Storage Mock Mode. All edits persist in browser.';
    } else {
      banner.className = 'mode-banner is-live';
      badge.textContent = 'LIVE CMS CONNECTED';
      text.textContent = `Connected to Payload CMS at ${info.backendUrl}`;
    }
  }

  openCmsSettingsModal() {
    const info = apiAdapter.getModeInfo();
    openModal({
      title: 'Backend & Storage Configuration',
      contentHtml: `
        <div style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="ethics-notice-box" style="margin-bottom: 0;">
            <h4>Payload CMS Integration Contract</h4>
            <p>
              Claude owns the Payload CMS backend on <code>agent/payload-core</code>.
              When running locally, PostgreSQL + Payload run at <code>http://localhost:3000</code>.
            </p>
          </div>

          <div class="form-group">
            <label for="modal-cms-url" class="form-label">Payload CMS Base URL</label>
            <input type="url" id="modal-cms-url" class="form-input" value="${escapeHtml(info.backendUrl)}" />
            <span class="form-help">Default: http://localhost:3000</span>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; background: var(--color-parchment-light); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--color-rule);">
            <div>
              <div style="font-weight: 700; font-size: 0.875rem;">Reset Mock Test Fixtures</div>
              <div style="font-size: 0.75rem; color: var(--color-muted);">Restore original Church Times story and tips dataset.</div>
            </div>
            <button type="button" class="btn btn-outline btn-sm" id="modal-reset-fixtures-btn">
              🔄 Reset Data
            </button>
          </div>

          <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem;">
            <button type="button" class="btn btn-outline" id="modal-close-settings">Close</button>
            <button type="button" class="btn btn-primary" id="modal-test-conn-btn">
              Test Connection & Connect
            </button>
          </div>
        </div>
      `,
      onRender: (modalBody, close) => {
        modalBody.querySelector('#modal-close-settings').addEventListener('click', close);

        modalBody.querySelector('#modal-reset-fixtures-btn').addEventListener('click', () => {
          apiAdapter.resetStorage();
          showToast('Mock data reset to original seed fixtures!', 'success');
          close();
          this.route();
        });

        modalBody.querySelector('#modal-test-conn-btn').addEventListener('click', async () => {
          const url = modalBody.querySelector('#modal-cms-url').value.trim();
          showToast('Pinging Payload CMS endpoint...', 'info');
          const res = await apiAdapter.testBackendConnection(url);
          if (res.success) {
            showToast(res.message, 'success');
            close();
            this.updateModeBanner();
          } else {
            showToast(res.message, 'error', 4500);
            this.updateModeBanner();
          }
        });
      }
    });
  }

  initNavLinks() {
    // Quick write button in nav
    const quickWriteBtn = document.getElementById('nav-quick-write-btn');
    if (quickWriteBtn) {
      quickWriteBtn.addEventListener('click', () => {
        store.setCurrentView('editor', { storyId: null });
      });
    }

    // Intercept nav clicks
    document.querySelectorAll('[data-view-nav]').forEach(link => {
      link.addEventListener('click', (e) => {
        const view = link.getAttribute('data-view-nav');
        if (view) {
          store.setCurrentView(view);
        }
      });
    });
  }

  initKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Avoid shortcuts when typing in inputs/textareas
      const tag = e.target.tagName.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';

      // Alt + Number navigation
      if (e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (e.key === '1') { e.preventDefault(); store.setCurrentView('dashboard'); }
        if (e.key === '2') { e.preventDefault(); store.setCurrentView('editor'); }
        if (e.key === '3') { e.preventDefault(); store.setCurrentView('review'); }
        if (e.key === '4') { e.preventDefault(); store.setCurrentView('live'); }
        if (e.key === '5') { e.preventDefault(); store.setCurrentView('media'); }
        if (e.key === '6') { e.preventDefault(); store.setCurrentView('submit'); }
      }

      // Ctrl + S quick save
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        const saveDraftBtn = document.getElementById('btn-save-draft');
        if (saveDraftBtn) {
          saveDraftBtn.click();
        } else {
          showToast('Draft saved', 'success');
        }
      }
    });
  }

  initRouter() {
    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  async route() {
    const hash = window.location.hash.slice(1) || 'dashboard';
    const [viewName, queryString] = hash.split('?');
    const params = new URLSearchParams(queryString || '');
    const storyId = params.get('id');

    this.updateNavActiveStates(viewName);

    switch (viewName) {
      case 'dashboard':
        await renderDashboard(this.mainEl);
        break;
      case 'editor':
        await renderEditor(this.mainEl, storyId);
        break;
      case 'review':
        await renderReview(this.mainEl, storyId);
        break;
      case 'submit':
        renderSubmit(this.mainEl);
        break;
      case 'live':
        await renderLive(this.mainEl);
        break;
      case 'media':
        await renderMedia(this.mainEl);
        break;
      default:
        await renderDashboard(this.mainEl);
        break;
    }

    this.updateBadges();
    window.scrollTo(0, 0);
  }

  updateNavActiveStates(activeView) {
    document.querySelectorAll('[data-view-nav]').forEach(el => {
      const match = el.getAttribute('data-view-nav') === activeView;
      el.classList.toggle('active', match);
      if (el.tagName.toLowerCase() === 'a') {
        el.setAttribute('aria-current', match ? 'page' : 'false');
      }
    });
  }

  async updateBadges() {
    try {
      const [articlesRes, subsRes] = await Promise.all([
        apiAdapter.getArticles(),
        apiAdapter.getSubmissions()
      ]);
      const pendingCount = articlesRes.data.filter(a => a.status === 'in_review').length;
      const subsCount = subsRes.data.filter(s => s.status === 'pending').length;
      const totalReview = pendingCount + subsCount;

      const reviewBadges = document.querySelectorAll('.review-count-badge');
      reviewBadges.forEach(badge => {
        badge.textContent = totalReview;
        badge.style.display = totalReview > 0 ? 'inline-block' : 'none';
      });
    } catch (e) {}
  }
}

function formatRoleName(role) {
  const map = {
    reporter: 'Reporter',
    section_editor: 'Section Editor',
    editor_in_chief: 'Editor-in-Chief',
    public: 'Public Contributor'
  };
  return map[role] || role;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new NewsroomApp();
  app.init();
});
