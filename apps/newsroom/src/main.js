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
    this.sessionChipEl = document.getElementById('session-chip');
    this.themeToggleBtn = document.getElementById('theme-toggle-btn');
  }

  init() {
    this.initRolePicker();
    this.initSessionDisplay();
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
        this.updateSessionDisplay();
        this.syncRolePicker();
        this.route();
      } else if (event === 'view_changed') {
        this.updateNavActiveStates(data.view);
        window.location.hash = data.view + (data.payload?.storyId ? `?id=${data.payload.storyId}` : '');
      }
    });

    apiAdapter.subscribe(() => {
      this.updateModeBanner();
      this.updateSessionDisplay();
      this.updateBadges();
    });
  }

  initRolePicker() {
    if (!this.roleSelect) return;
    this.syncRolePicker();

    this.roleSelect.addEventListener('change', () => {
      store.setCurrentUser(this.roleSelect.value);
    });
  }

  syncRolePicker() {
    if (!this.roleSelect) return;
    const users = apiAdapter.getUsers();
    const current = apiAdapter.getCurrentUser();
    this.roleSelect.innerHTML = users.map(u => `
      <option value="${u.id}" ${current && u.id === current.id ? 'selected' : ''}>
        ${u.name} (${formatRoleName(u.role)})
      </option>
    `).join('');
  }

  initSessionDisplay() {
    this.updateSessionDisplay();
  }

  updateSessionDisplay() {
    if (!this.sessionChipEl) return;
    const user = apiAdapter.getCurrentUser();

    if (user) {
      this.sessionChipEl.innerHTML = `
        <div class="session-user-badge" id="session-user-badge" title="${escapeHtml(user.email || user.name)}">
          <span class="session-avatar">${escapeHtml(user.avatar || user.name.slice(0, 2).toUpperCase())}</span>
          <div class="session-meta">
            <span class="session-user-name">${escapeHtml(user.name)}</span>
            <span class="badge badge-role">${escapeHtml(formatRoleName(user.role))}</span>
          </div>
        </div>
        <button type="button" class="btn btn-outline btn-xs" id="btn-staff-logout" aria-label="Sign out of newsroom session">
          Log out
        </button>
      `;

      const logoutBtn = this.sessionChipEl.querySelector('#btn-staff-logout');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
          await apiAdapter.logout();
          showToast('Logged out. Session cleared.', 'info');
        });
      }
    } else {
      this.sessionChipEl.innerHTML = `
        <button type="button" class="btn btn-primary btn-sm" id="btn-staff-login" aria-label="Staff login">
          🔐 Staff Login
        </button>
      `;

      const loginBtn = this.sessionChipEl.querySelector('#btn-staff-login');
      if (loginBtn) {
        loginBtn.addEventListener('click', () => this.openStaffLoginModal());
      }
    }
  }

  openStaffLoginModal() {
    openModal({
      title: 'Staff Authentication',
      onClose: () => {
        if (window.location.hash === '#login') {
          window.location.hash = '#dashboard';
        }
      },
      contentHtml: `
        <div style="display: flex; flex-direction: column; gap: 1rem;">
          <div class="ethics-notice-box" style="margin-bottom: 0;">
            <h4 style="margin: 0 0 0.25rem 0;">Church Times Nigeria — Newsroom Access</h4>
            <p style="margin: 0; font-size: 0.8125rem;">
              Secure authenticated access for accredited journalists and editors.
              In live mode, sessions use HttpOnly cookies. Passwords and tokens are <strong>never stored in localStorage</strong>.
            </p>
          </div>

          <div class="validation-summary-alert" id="login-error-alert" style="display: none; margin-bottom: 0;" role="alert">
            <span id="login-error-msg"></span>
          </div>

          <form id="staff-login-form" novalidate>
            <div class="form-group" style="margin-bottom: 1rem;">
              <label for="login-email-input" class="form-label">Staff Email Address <span style="color: #DC2626;">*</span></label>
              <input
                type="email"
                id="login-email-input"
                class="form-input"
                placeholder="editor@churchtimesnigeria.net"
                required
                autocomplete="username"
              />
            </div>

            <div class="form-group" style="margin-bottom: 1rem;">
              <label for="login-password-input" class="form-label">Password <span style="color: #DC2626;">*</span></label>
              <input
                type="password"
                id="login-password-input"
                class="form-input"
                placeholder="••••••••••••"
                required
                autocomplete="current-password"
              />
            </div>

            <div style="margin-bottom: 1.25rem; background: var(--color-parchment-light); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px dashed var(--color-rule);">
              <div style="font-size: 0.75rem; font-weight: 700; color: var(--color-muted); text-transform: uppercase; margin-bottom: 0.35rem;">
                Demo Credentials (Claude Payload CMS Matrix)
              </div>
              <div style="display: flex; gap: 0.35rem; flex-wrap: wrap;">
                <button type="button" class="btn btn-outline btn-xs demo-fill-btn" data-email="reporter@churchtimes.local">Reporter</button>
                <button type="button" class="btn btn-outline btn-xs demo-fill-btn" data-email="news-editor@churchtimes.local">Section Editor</button>
                <button type="button" class="btn btn-outline btn-xs demo-fill-btn" data-email="eic@churchtimes.local">Editor-in-Chief</button>
                <button type="button" class="btn btn-outline btn-xs demo-fill-btn" data-email="admin@churchtimes.local">Admin</button>
              </div>
              <div style="font-size: 0.75rem; color: var(--color-muted); margin-top: 0.35rem;">
                Default demo password: <code>churchtimes2026!</code>
              </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
              <button type="button" class="btn btn-outline" id="modal-cancel-login">Cancel</button>
              <button type="submit" class="btn btn-primary" id="btn-submit-login">
                🔐 Sign In to Newsroom
              </button>
            </div>
          </form>
        </div>
      `,
      onRender: (modalBody, close) => {
        const form = modalBody.querySelector('#staff-login-form');
        const emailInput = modalBody.querySelector('#login-email-input');
        const passwordInput = modalBody.querySelector('#login-password-input');
        const errorAlert = modalBody.querySelector('#login-error-alert');
        const errorMsg = modalBody.querySelector('#login-error-msg');
        const submitBtn = modalBody.querySelector('#btn-submit-login');

        modalBody.querySelector('#modal-cancel-login').addEventListener('click', () => {
          close();
          if (window.location.hash === '#login') {
            window.location.hash = '#dashboard';
          }
        });

        // Demo quick fill
        modalBody.querySelectorAll('.demo-fill-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            emailInput.value = btn.getAttribute('data-email');
            passwordInput.value = 'churchtimes2026!';
            errorAlert.style.display = 'none';
          });
        });

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errorAlert.style.display = 'none';

          const email = emailInput.value.trim();
          const password = passwordInput.value;

          if (!email || !password) {
            errorMsg.textContent = 'Please enter both email and password.';
            errorAlert.style.display = 'block';
            return;
          }

          submitBtn.disabled = true;
          submitBtn.textContent = 'Authenticating...';

          try {
            const res = await apiAdapter.login({ email, password });
            showToast(`Welcome, ${res.user.name}! Authenticated as ${formatRoleName(res.user.role)}.`, 'success');
            close();
            this.updateSessionDisplay();
            this.syncRolePicker();
            if (window.location.hash === '#login') {
              window.location.hash = '#dashboard';
            } else {
              this.route();
            }
          } catch (err) {
            submitBtn.disabled = false;
            submitBtn.textContent = '🔐 Sign In to Newsroom';
            errorMsg.textContent = err.message;
            errorAlert.style.display = 'block';
          }
        });
      }
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
    const mockWrapper = document.getElementById('mock-role-picker-wrapper');
    if (!banner || !badge || !text) return;

    if (info.isMock) {
      banner.className = 'mode-banner';
      badge.textContent = 'LOCAL MOCK MODE';
      text.textContent = 'Running in Local Storage Mock Mode. All edits persist in browser.';
      if (mockWrapper) mockWrapper.style.display = 'flex';
    } else {
      banner.className = 'mode-banner is-live';
      badge.textContent = 'LIVE CMS CONNECTED';
      text.textContent = `Connected to Payload CMS at ${info.backendUrl}`;
      if (mockWrapper) mockWrapper.style.display = 'none';
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
            <label class="form-label" style="font-weight: 600;">Operating Mode</label>
            <div style="display: flex; gap: 1.5rem; margin-top: 0.35rem;">
              <label style="display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.875rem;">
                <input type="radio" name="cms-mode" id="radio-mode-mock" value="mock" ${info.isMock ? 'checked' : ''} />
                <span>🛠 Local Mock Mode</span>
              </label>
              <label style="display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer; font-size: 0.875rem;">
                <input type="radio" name="cms-mode" id="radio-mode-live" value="live" ${!info.isMock ? 'checked' : ''} />
                <span>🌐 Live Payload CMS</span>
              </label>
            </div>
            <span class="form-help">In Mock mode, role switcher is enabled. In Live CMS mode, real authenticated sessions are enforced.</span>
          </div>

          <div class="form-group">
            <label for="cms-url-input" class="form-label">Payload CMS Base URL</label>
            <input type="url" id="cms-url-input" class="form-input" value="${escapeHtml(info.backendUrl)}" />
            <input type="hidden" id="modal-cms-url" value="${escapeHtml(info.backendUrl)}" />
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
            <button type="button" class="btn btn-outline" id="modal-test-conn-btn">
              Test Connection
            </button>
            <button type="button" class="btn btn-primary" id="btn-save-cms-config">
              Save Configuration
            </button>
          </div>
        </div>
      `,
      onRender: (modalBody, close) => {
        const urlInput = modalBody.querySelector('#cms-url-input');
        const legacyUrlInput = modalBody.querySelector('#modal-cms-url');
        if (urlInput && legacyUrlInput) {
          urlInput.addEventListener('input', () => { legacyUrlInput.value = urlInput.value; });
        }

        modalBody.querySelector('#modal-close-settings').addEventListener('click', close);

        modalBody.querySelector('#modal-reset-fixtures-btn').addEventListener('click', () => {
          apiAdapter.resetStorage();
          showToast('Mock data reset to original seed fixtures!', 'success');
          close();
          this.route();
        });

        modalBody.querySelector('#modal-test-conn-btn').addEventListener('click', async () => {
          const url = (urlInput ? urlInput.value : legacyUrlInput.value).trim();
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

        const saveBtn = modalBody.querySelector('#btn-save-cms-config');
        if (saveBtn) {
          saveBtn.addEventListener('click', () => {
            const isLive = modalBody.querySelector('#radio-mode-live')?.checked;
            const url = (urlInput ? urlInput.value : legacyUrlInput.value).trim();
            if (isLive) {
              apiAdapter.backendUrl = url || 'http://localhost:3000';
              apiAdapter.isMockActive = false;
              apiAdapter.connectionStatus = `Connected to Payload CMS (${apiAdapter.backendUrl})`;
              showToast(`Switched to Live Payload CMS mode (${apiAdapter.backendUrl})`, 'success');
            } else {
              apiAdapter.isMockActive = true;
              apiAdapter.connectionStatus = 'Local Mock Mode';
              showToast('Switched to Local Mock Mode', 'info');
            }
            this.updateModeBanner();
            this.updateSessionDisplay();
            close();
          });
        }
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
      case 'login':
        this.openStaffLoginModal();
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
  if (!role) return 'Contributor';
  const clean = role.replace(/_/g, '-');
  const map = {
    reporter: 'Reporter',
    'section-editor': 'Section Editor',
    'editor-in-chief': 'Editor-in-Chief',
    admin: 'Administrator',
    'trusted-publisher': 'Trusted Publisher',
    public: 'Public Contributor'
  };
  return map[clean] || map[role] || role;
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
