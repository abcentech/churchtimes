/**
 * Newsroom Dashboard View
 *
 * Editorial pipeline visibility from the real CMS: per-status counts (server totals), filterable story list,
 * quick actions. Every number and row comes from a successful CMS response; failures are shown, never masked.
 */

import { api } from '../api/index.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { askConfirm } from '../components/modal.js';
import { showApiError } from '../components/notify.js';
import { escapeHtml, debounce, formatTimeAgo, statusBadge, formatStatusLabel, latestGuard } from '../util.js';

const beginTable = latestGuard();
const STATUS_FILTERS = ['draft', 'in_review', 'changes_requested', 'approved', 'scheduled', 'published', 'archived'];

export async function renderDashboard(container) {
  let categories = [];
  try {
    categories = await api.getCategories();
  } catch (err) {
    showApiError(err, 'Could not load sections: ');
  }

  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Editorial Newsroom Desk</h1>
          <p class="view-subtitle">Independent minds. Shared humanity. Production editorial pipeline for Church Times Nigeria.</p>
        </div>
        <div class="header-actions">
          <button type="button" class="btn btn-primary" id="dash-new-story-btn" data-testid="dash-new-story">Write Story</button>
        </div>
      </div>
    </div>

    <div id="dash-error" data-testid="dash-error" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;"></div>

    <div class="metrics-grid" id="dash-metrics-container" aria-label="Editorial workflow statistics">
      <div class="card" style="padding: 1rem; text-align: center;">Loading editorial statistics...</div>
    </div>

    <div class="launchpad-grid">
      <div class="launch-card" id="launch-write-story" role="button" tabindex="0" aria-label="Open story editor to compose a new article">
        <div class="launch-info"><h3>Write Story</h3><p>Compose, save drafts, attach verified media and preview</p></div>
      </div>
      <div class="launch-card accent" id="launch-review-queue" role="button" tabindex="0" aria-label="Open review queue for editorial approval">
        <div class="launch-info"><h3>Review Queue</h3><p>Review stories and reader tips, request revisions, approve</p></div>
      </div>
      <div class="launch-card live" id="launch-go-live" role="button" tabindex="0" aria-label="Manage live event coverage and updates">
        <div class="launch-info"><h3>Live Coverage</h3><p>Updates for synods, conferences and breaking news</p></div>
      </div>
      <div class="launch-card" id="launch-media-lib" role="button" tabindex="0" aria-label="Browse and upload newsroom media assets">
        <div class="launch-info"><h3>Media Library</h3><p>Photographs, credits and alt text</p></div>
      </div>
    </div>

    <div class="view-header-row" style="margin-bottom: 0.75rem;">
      <h2 style="font-family: var(--font-serif); font-size: 1.35rem; color: var(--color-forest);">Story Pipeline</h2>
      <span class="badge badge-category" id="story-count-badge">Loading...</span>
    </div>

    <div class="filter-bar">
      <div class="filter-group">
        <label for="filter-status-select" class="form-label" style="margin-bottom: 0;">Status:</label>
        <select id="filter-status-select" data-testid="dash-filter-status" class="select-input">
          <option value="all">All Statuses</option>
          ${STATUS_FILTERS.map(s => `<option value="${s}">${escapeHtml(formatStatusLabel(s))}</option>`).join('')}
        </select>

        <label for="filter-category-select" class="form-label" style="margin-bottom: 0;">Section:</label>
        <select id="filter-category-select" data-testid="dash-filter-category" class="select-input">
          <option value="all">All Sections</option>
          ${categories.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`).join('')}
        </select>
      </div>
      <div class="filter-group">
        <input type="search" id="dash-search-input" data-testid="dash-search" class="search-input" placeholder="Search by headline..." aria-label="Search stories">
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
        <tbody id="story-pipeline-tbody" data-testid="story-list">
          <tr><td colspan="6" style="text-align: center; padding: 2rem;">Loading stories...</td></tr>
        </tbody>
      </table>
    </div>
  `;

  const go = (view, payload) => () => store.setCurrentView(view, payload);
  container.querySelector('#dash-new-story-btn').addEventListener('click', go('editor', { storyId: null }));
  container.querySelector('#launch-write-story').addEventListener('click', go('editor', { storyId: null }));
  container.querySelector('#launch-review-queue').addEventListener('click', go('review'));
  container.querySelector('#launch-go-live').addEventListener('click', go('live'));
  container.querySelector('#launch-media-lib').addEventListener('click', go('media'));

  const statusSelect = container.querySelector('#filter-status-select');
  const catSelect = container.querySelector('#filter-category-select');
  const searchInput = container.querySelector('#dash-search-input');
  const refreshTable = () => renderStoryTable(container, {
    status: statusSelect.value, categoryId: catSelect.value, search: searchInput.value
  });
  statusSelect.addEventListener('change', refreshTable);
  catSelect.addEventListener('change', refreshTable);
  searchInput.addEventListener('input', debounce(refreshTable, 300));

  await Promise.all([renderMetrics(container, statusSelect, refreshTable), renderStoryTable(container, {})]);
}

function setError(container, message) {
  const el = container.querySelector('#dash-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

async function renderMetrics(container, statusSelect, refreshTable) {
  const metrics = container.querySelector('#dash-metrics-container');
  let counts;
  let tips = null;
  try {
    counts = await api.getArticleCounts();
  } catch (err) {
    metrics.innerHTML = '';
    setError(container, showApiError(err, 'Could not load story counts: '));
    return;
  }
  if (api.can('submission.review')) {
    try {
      tips = (await api.getSubmissions({ statuses: ['new', 'under_review'] })).totalDocs;
    } catch { tips = null; }
  }

  const card = (status, label, desc, color) => `
    <div class="metric-card" data-testid="metric-${status}" data-filter-status="${status}" style="${color ? `border-left: 3px solid ${color};` : ''}">
      <span class="metric-label">${escapeHtml(label)}</span>
      <span class="metric-value" data-testid="metric-value-${status}">${escapeHtml(counts[status] ?? 0)}</span>
      <span class="metric-desc">${escapeHtml(desc)}</span>
    </div>`;

  metrics.innerHTML = `
    ${card('draft', 'Drafts', 'Stories in progress')}
    ${card('in_review', 'In Review', 'Awaiting editor check', '#D97706')}
    ${card('changes_requested', 'Revisions', 'Feedback sent', '#DC2626')}
    ${card('approved', 'Approved', 'Ready to publish', '#059669')}
    ${card('published', 'Published', 'Live on web')}
    <div class="metric-card" id="metric-open-tips" data-testid="metric-tips">
      <span class="metric-label">Reader Tips</span>
      <span class="metric-value" style="color: var(--color-clay);" data-testid="metric-value-tips">${tips === null ? '-' : escapeHtml(tips)}</span>
      <span class="metric-desc">Public submissions to review</span>
    </div>`;

  metrics.querySelectorAll('.metric-card[data-filter-status]').forEach(el => {
    el.addEventListener('click', () => {
      statusSelect.value = el.getAttribute('data-filter-status');
      refreshTable();
    });
  });
  metrics.querySelector('#metric-open-tips').addEventListener('click', () => store.setCurrentView('review'));
}

async function renderStoryTable(container, { status = 'all', categoryId = 'all', search = '' } = {}) {
  const tbody = container.querySelector('#story-pipeline-tbody');
  const countBadge = container.querySelector('#story-count-badge');
  if (!tbody) return;

  const isCurrent = beginTable();
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 1.5rem;">Loading stories...</td></tr>';

  let res;
  try {
    res = await api.getArticles({ status, categoryId, search });
    if (!isCurrent()) return;
  } catch (err) {
    if (!isCurrent()) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 1.5rem;">Stories could not be loaded.</td></tr>';
    if (countBadge) countBadge.textContent = 'unavailable';
    setError(container, showApiError(err, 'Could not load stories: '));
    return;
  }
  setError(container, '');
  const articles = res.data;
  if (countBadge) {
    countBadge.textContent = res.totalDocs > articles.length
      ? `${articles.length} of ${res.totalDocs} stories`
      : `${articles.length} stories`;
  }

  if (articles.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; padding: 2.5rem; color: var(--color-muted);">
          <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">No stories found matching your filter.</p>
          <button type="button" class="btn btn-outline btn-sm" id="reset-filter-btn">Clear Filters</button>
        </td>
      </tr>`;
    tbody.querySelector('#reset-filter-btn').addEventListener('click', () => {
      container.querySelector('#filter-status-select').value = 'all';
      container.querySelector('#filter-category-select').value = 'all';
      container.querySelector('#dash-search-input').value = '';
      renderStoryTable(container, {});
    });
    return;
  }

  tbody.innerHTML = articles.map(article => {
    const id = escapeHtml(article.id);
    const title = article.title || 'Untitled Story';
    return `
      <tr data-testid="story-row" data-story-id="${id}" data-status="${escapeHtml(article.status)}">
        <td>
          <a href="#editor?id=${encodeURIComponent(article.id)}" class="story-headline-link" data-testid="story-open-link" data-action="open-story" data-id="${id}">${escapeHtml(title)}</a>
          <div class="story-meta-inline"><span>Slug: /${escapeHtml(article.slug)}</span></div>
        </td>
        <td><span class="badge badge-category">${escapeHtml(article.categoryTitle || '-')}</span></td>
        <td>${statusBadge(article.status)}</td>
        <td><div style="font-weight: 500; font-size: 0.8125rem;">${escapeHtml(article.authorName || 'Staff')}</div></td>
        <td style="font-size: 0.8125rem; color: var(--color-muted); white-space: nowrap;">${escapeHtml(formatTimeAgo(article.updatedAt || article.createdAt))}</td>
        <td style="text-align: right; white-space: nowrap;">
          <button type="button" class="btn btn-outline btn-sm" data-testid="story-edit" data-action="open-story" data-id="${id}" aria-label="Open story: ${escapeHtml(title)}">Open</button>
          ${article.status === 'in_review' && api.can('story.approve', { status: 'in_review', categoryId: article.categoryId }) ? `
            <button type="button" class="btn btn-accent btn-sm" data-testid="story-inspect" data-action="review-story" data-id="${id}" aria-label="Review story: ${escapeHtml(title)}">Inspect</button>` : ''}
          ${api.can('story.delete') ? `
            <button type="button" class="btn btn-outline btn-sm" data-testid="story-delete" data-action="delete-story" data-id="${id}" data-title="${escapeHtml(title)}" style="color:#DC2626;" aria-label="Delete story: ${escapeHtml(title)}">Delete</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-action="open-story"]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      store.setCurrentView('editor', { storyId: el.getAttribute('data-id') });
    });
  });
  tbody.querySelectorAll('[data-action="review-story"]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      store.setCurrentView('review', { storyId: el.getAttribute('data-id') });
    });
  });
  tbody.querySelectorAll('[data-action="delete-story"]').forEach(el => {
    el.addEventListener('click', async () => {
      const ok = await askConfirm({
        title: 'Delete story',
        message: `Permanently delete "${el.getAttribute('data-title')}"? Prefer archiving; delete is for mistakes.`,
        confirmLabel: 'Delete permanently',
        testid: 'delete-story'
      });
      if (!ok) return;
      try {
        await api.deleteArticle(el.getAttribute('data-id'));
        showToast('Story deleted.', 'success');
        await renderStoryTable(container, {
          status: container.querySelector('#filter-status-select').value,
          categoryId: container.querySelector('#filter-category-select').value,
          search: container.querySelector('#dash-search-input').value
        });
      } catch (err) {
        showApiError(err);
      }
    });
  });
}
