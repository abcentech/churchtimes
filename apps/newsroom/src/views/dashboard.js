/**
 * Newsroom Dashboard View
 * 
 * Provides high-level editorial pipeline visibility, metrics, quick actions,
 * and filterable story queue.
 */

import { apiAdapter } from '../api/adapter.js';
import { store } from '../store.js';

export async function renderDashboard(container) {
  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Editorial Newsroom Desk</h1>
          <p class="view-subtitle">Independent minds. Shared humanity. Production editorial pipeline for Church Times Nigeria.</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-primary" id="dash-new-story-btn">
            ✍️ Write Story
          </button>
        </div>
      </div>
    </div>

    <!-- KPI Metrics Grid -->
    <div class="metrics-grid" id="dash-metrics-container" aria-label="Editorial workflow statistics">
      <div class="card" style="padding: 1rem; text-align: center;">Loading editorial statistics...</div>
    </div>

    <!-- Quick Action Launchpad -->
    <div class="launchpad-grid">
      <div class="launch-card" id="launch-write-story" role="button" tabindex="0" aria-label="Open story editor to compose a new article">
        <span class="launch-icon">✍️</span>
        <div class="launch-info">
          <h3>Write Story</h3>
          <p>Compose, autosave, attach verified media and preview</p>
        </div>
      </div>
      <div class="launch-card accent" id="launch-review-queue" role="button" tabindex="0" aria-label="Open review queue for editorial approval">
        <span class="launch-icon">📥</span>
        <div class="launch-info">
          <h3>Review Submissions</h3>
          <p>Fact-check submissions, request revisions, and approve</p>
        </div>
      </div>
      <div class="launch-card live" id="launch-go-live" role="button" tabindex="0" aria-label="Manage live event coverage and updates">
        <span class="launch-icon">🔴</span>
        <div class="launch-info">
          <h3>Go Live Coverage</h3>
          <p>Real-time updates for synods, conferences & breaking news</p>
        </div>
      </div>
      <div class="launch-card" id="launch-media-lib" role="button" tabindex="0" aria-label="Browse and inspect newsroom media assets">
        <span class="launch-icon">🖼️</span>
        <div class="launch-info">
          <h3>Media Library</h3>
          <p>Curated photographs, rights records and alt text</p>
        </div>
      </div>
    </div>

    <!-- Story Pipeline Section -->
    <div class="view-header-row" style="margin-bottom: 0.75rem;">
      <h2 style="font-family: var(--font-serif); font-size: 1.35rem; color: var(--color-forest);">
        Story Pipeline
      </h2>
      <span class="badge badge-category" id="story-count-badge">Loading...</span>
    </div>

    <div class="filter-bar">
      <div class="filter-group">
        <label for="filter-status-select" class="form-label" style="margin-bottom: 0;">Status:</label>
        <select id="filter-status-select" class="select-input">
          <option value="all">All Statuses</option>
          <option value="draft">Drafts</option>
          <option value="in_review">In Review</option>
          <option value="changes_requested">Changes Requested</option>
          <option value="approved">Approved</option>
          <option value="published">Published</option>
        </select>

        <label for="filter-category-select" class="form-label" style="margin-bottom: 0;">Section:</label>
        <select id="filter-category-select" class="select-input">
          <option value="all">All Sections</option>
          <option value="faith-society">Faith & Society</option>
          <option value="church-ministry">Church & Ministry</option>
          <option value="people-purpose">People & Purpose</option>
          <option value="business-vocation">Business & Vocation</option>
          <option value="culture-ideas">Culture & Ideas</option>
        </select>
      </div>

      <div class="filter-group">
        <input type="search" id="dash-search-input" class="search-input" placeholder="Search by headline or reporter..." aria-label="Search stories">
      </div>
    </div>

    <div class="table-responsive">
      <table class="data-table" aria-label="Articles in editorial pipeline">
        <thead>
          <tr>
            <th scope="col" style="min-width: 280px;">Headline</th>
            <th scope="col">Section</th>
            <th scope="col">Status</th>
            <th scope="col">Author</th>
            <th scope="col">Updated</th>
            <th scope="col" style="text-align: right;">Action</th>
          </tr>
        </thead>
        <tbody id="story-pipeline-tbody">
          <tr><td colspan="6" style="text-align: center; padding: 2rem;">Loading stories...</td></tr>
        </tbody>
      </table>
    </div>
  `;

  // Bind Launchpad buttons
  container.querySelector('#dash-new-story-btn').addEventListener('click', () => {
    store.setCurrentView('editor', { storyId: null });
  });
  container.querySelector('#launch-write-story').addEventListener('click', () => {
    store.setCurrentView('editor', { storyId: null });
  });
  container.querySelector('#launch-review-queue').addEventListener('click', () => {
    store.setCurrentView('review');
  });
  container.querySelector('#launch-go-live').addEventListener('click', () => {
    store.setCurrentView('live');
  });
  container.querySelector('#launch-media-lib').addEventListener('click', () => {
    store.setCurrentView('media');
  });

  // Load and render metrics & table
  await refreshDashboardData(container);

  // Bind filters
  const statusSelect = container.querySelector('#filter-status-select');
  const catSelect = container.querySelector('#filter-category-select');
  const searchInput = container.querySelector('#dash-search-input');

  const onFilterChange = async () => {
    const status = statusSelect.value;
    const category = catSelect.value;
    const search = searchInput.value;
    await renderStoryTable(container, { status, category, search });
  };

  statusSelect.addEventListener('change', onFilterChange);
  catSelect.addEventListener('change', onFilterChange);
  searchInput.addEventListener('input', debounce(onFilterChange, 250));
}

async function refreshDashboardData(container) {
  const [articlesRes, subsRes, liveRes] = await Promise.all([
    apiAdapter.getArticles(),
    apiAdapter.getSubmissions(),
    apiAdapter.getLiveEvents()
  ]);

  const articles = articlesRes.data;
  const submissions = subsRes.data;
  const liveEvents = liveRes.data;

  const counts = {
    draft: articles.filter(a => a.status === 'draft').length,
    in_review: articles.filter(a => a.status === 'in_review').length,
    changes_requested: articles.filter(a => a.status === 'changes_requested').length,
    approved: articles.filter(a => a.status === 'approved').length,
    published: articles.filter(a => a.status === 'published').length,
    submissions_pending: submissions.filter(s => s.status === 'pending').length,
    live_active: liveEvents.filter(e => e.status === 'live').length
  };

  const metricsContainer = container.querySelector('#dash-metrics-container');
  metricsContainer.innerHTML = `
    <div class="metric-card" data-filter-status="draft">
      <span class="metric-label">Drafts</span>
      <span class="metric-value">${counts.draft}</span>
      <span class="metric-desc">Stories in progress</span>
    </div>
    <div class="metric-card" data-filter-status="in_review" style="border-left: 3px solid #D97706;">
      <span class="metric-label" style="color: #92400E;">In Review</span>
      <span class="metric-value" style="color: #92400E;">${counts.in_review}</span>
      <span class="metric-desc">Awaiting editor check</span>
    </div>
    <div class="metric-card" data-filter-status="changes_requested" style="border-left: 3px solid #DC2626;">
      <span class="metric-label" style="color: #DC2626;">Revisions</span>
      <span class="metric-value" style="color: #DC2626;">${counts.changes_requested}</span>
      <span class="metric-desc">Feedback sent</span>
    </div>
    <div class="metric-card" data-filter-status="approved" style="border-left: 3px solid #059669;">
      <span class="metric-label" style="color: #059669;">Approved</span>
      <span class="metric-value" style="color: #059669;">${counts.approved}</span>
      <span class="metric-desc">Ready to publish</span>
    </div>
    <div class="metric-card" data-filter-status="published">
      <span class="metric-label">Published</span>
      <span class="metric-value">${counts.published}</span>
      <span class="metric-desc">Live on web & app</span>
    </div>
    <div class="metric-card" id="metric-open-tips">
      <span class="metric-label">Reader Tips</span>
      <span class="metric-value" style="color: var(--color-clay);">${counts.submissions_pending}</span>
      <span class="metric-desc">Public submissions</span>
    </div>
  `;

  // Click on metric card filters table
  metricsContainer.querySelectorAll('.metric-card[data-filter-status]').forEach(card => {
    card.addEventListener('click', () => {
      const status = card.getAttribute('data-filter-status');
      const select = container.querySelector('#filter-status-select');
      select.value = status;
      renderStoryTable(container, { status, category: container.querySelector('#filter-category-select').value });
    });
  });

  const tipsCard = metricsContainer.querySelector('#metric-open-tips');
  if (tipsCard) {
    tipsCard.addEventListener('click', () => {
      store.setCurrentView('review');
    });
  }

  await renderStoryTable(container, {});
}

async function renderStoryTable(container, { status = 'all', category = 'all', search = '' } = {}) {
  const tbody = container.querySelector('#story-pipeline-tbody');
  const countBadge = container.querySelector('#story-count-badge');
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 1.5rem;">Filtering stories...</td></tr>`;

  const res = await apiAdapter.getArticles({ status, category, search });
  const articles = res.data;

  if (countBadge) {
    countBadge.textContent = `${articles.length} stories`;
  }

  if (articles.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--color-muted);">
          <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">No stories found matching your filter.</p>
          <button type="button" class="btn btn-outline btn-sm" id="reset-filter-btn">Clear Filters</button>
        </td>
      </tr>
    `;
    const resetBtn = tbody.querySelector('#reset-filter-btn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        container.querySelector('#filter-status-select').value = 'all';
        container.querySelector('#filter-category-select').value = 'all';
        container.querySelector('#dash-search-input').value = '';
        renderStoryTable(container, {});
      });
    }
    return;
  }

  tbody.innerHTML = articles.map(article => {
    const catTitle = getCategoryTitle(article.category);
    const updatedFormatted = formatTimeAgo(article.updatedAt || article.createdAt);
    const statusBadge = getStatusBadgeHtml(article.status);

    return `
      <tr data-story-id="${article.id}">
        <td>
          <a href="#editor?id=${article.id}" class="story-headline-link" data-action="open-story" data-id="${article.id}">
            ${escapeHtml(article.title || 'Untitled Story')}
          </a>
          <div class="story-meta-inline">
            <span>Slug: /${escapeHtml(article.slug || '')}</span>
            <span>·</span>
            <span>Rev #${article.revisionCount || 1}</span>
          </div>
        </td>
        <td>
          <span class="badge badge-category">${catTitle}</span>
        </td>
        <td>
          ${statusBadge}
        </td>
        <td>
          <div style="font-weight: 500; font-size: 0.8125rem;">${escapeHtml(article.author?.name || 'Gbenga Osinaike')}</div>
          <div style="font-size: 0.75rem; color: var(--color-muted);">${escapeHtml(article.author?.desk || 'Staff Reporter')}</div>
        </td>
        <td style="font-size: 0.8125rem; color: var(--color-muted); white-space: nowrap;">
          ${updatedFormatted}
        </td>
        <td style="text-align: right; white-space: nowrap;">
          <button type="button" class="btn btn-outline btn-sm" data-action="open-story" data-id="${article.id}" aria-label="Edit story: ${escapeHtml(article.title)}">
            ✏️ Edit
          </button>
          ${article.status === 'in_review' ? `
            <button type="button" class="btn btn-accent btn-sm" data-action="review-story" data-id="${article.id}" aria-label="Review story: ${escapeHtml(article.title)}">
              Inspect
            </button>
          ` : ''}
        </td>
      </tr>
    `;
  }).join('');

  // Event delegation for table buttons
  tbody.querySelectorAll('[data-action="open-story"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-id');
      store.setCurrentView('editor', { storyId: id });
    });
  });

  tbody.querySelectorAll('[data-action="review-story"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const id = el.getAttribute('data-id');
      store.setCurrentView('review', { storyId: id });
    });
  });
}

function getCategoryTitle(slug) {
  const map = {
    'faith-society': 'Faith & Society',
    'church-ministry': 'Church & Ministry',
    'people-purpose': 'People & Purpose',
    'business-vocation': 'Business & Vocation',
    'culture-ideas': 'Culture & Ideas'
  };
  return map[slug] || slug || 'General';
}

function getStatusBadgeHtml(status) {
  const labels = {
    draft: 'Draft',
    in_review: 'In Review',
    changes_requested: 'Changes Requested',
    approved: 'Approved',
    published: 'Published'
  };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

function formatTimeAgo(isoString) {
  if (!isoString) return 'recently';
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
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

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
