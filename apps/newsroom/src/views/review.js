/**
 * Review Queue View for Church Times Nigeria Newsroom
 * 
 * Implements editorial oversight:
 * - Articles awaiting review
 * - Public reader submissions & tips (never auto-published)
 * - Revision loops (request changes with feedback notes)
 * - Approval and one-click conversion of public tips to draft stories
 */

import { apiAdapter } from '../api/adapter.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';

let activeTab = 'articles_review'; // 'articles_review' | 'submissions' | 'revisions' | 'approved'

export async function renderReview(container, preselectedStoryId = null) {
  const currentUser = store.getCurrentUser();

  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Editorial Review Queue</h1>
          <p class="view-subtitle">
            Rigour, accuracy and fairness. Review pending stories, verify public tips, and approve publications.
          </p>
        </div>
      </div>
    </div>

    <!-- Review Queue Navigation Tabs -->
    <div class="review-tabs" role="tablist" aria-label="Review queue categories">
      <button type="button" class="review-tab-btn ${activeTab === 'articles_review' ? 'active' : ''}" data-tab="articles_review" role="tab" aria-selected="${activeTab === 'articles_review'}">
        📥 In Review <span class="nav-badge" id="tab-count-review">0</span>
      </button>
      <button type="button" class="review-tab-btn ${activeTab === 'submissions' ? 'active' : ''}" data-tab="submissions" role="tab" aria-selected="${activeTab === 'submissions'}">
        📨 Reader Tips & Submissions <span class="nav-badge" id="tab-count-subs">0</span>
      </button>
      <button type="button" class="review-tab-btn ${activeTab === 'revisions' ? 'active' : ''}" data-tab="revisions" role="tab" aria-selected="${activeTab === 'revisions'}">
        ✏️ Revisions Requested <span class="nav-badge" id="tab-count-revs">0</span>
      </button>
      <button type="button" class="review-tab-btn ${activeTab === 'approved' ? 'active' : ''}" data-tab="approved" role="tab" aria-selected="${activeTab === 'approved'}">
        ✅ Approved Ready <span class="nav-badge" id="tab-count-appr">0</span>
      </button>
    </div>

    <!-- Active Tab Content Area -->
    <div id="review-content-area" role="tabpanel">
      <div style="text-align: center; padding: 2rem;">Loading queue items...</div>
    </div>
  `;

  // Bind Tab Switching
  container.querySelectorAll('.review-tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeTab = btn.getAttribute('data-tab');
      container.querySelectorAll('.review-tab-btn').forEach(b => {
        const isCurrent = b === btn;
        b.classList.toggle('active', isCurrent);
        b.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
      });
      await renderCurrentTabContent(container);
    });
  });

  await updateTabCounters(container);
  await renderCurrentTabContent(container);

  if (preselectedStoryId) {
    try {
      const res = await apiAdapter.getArticle(preselectedStoryId);
      inspectStoryModal(res.data, container);
    } catch (e) {}
  }
}

async function updateTabCounters(container) {
  const [articlesRes, subsRes] = await Promise.all([
    apiAdapter.getArticles(),
    apiAdapter.getSubmissions()
  ]);

  const articles = articlesRes.data;
  const submissions = subsRes.data;

  const countReview = articles.filter(a => a.status === 'in_review').length;
  const countSubs = submissions.filter(s => s.status === 'pending').length;
  const countRevs = articles.filter(a => a.status === 'changes_requested').length;
  const countAppr = articles.filter(a => a.status === 'approved').length;

  const rBadge = container.querySelector('#tab-count-review');
  const sBadge = container.querySelector('#tab-count-subs');
  const vBadge = container.querySelector('#tab-count-revs');
  const aBadge = container.querySelector('#tab-count-appr');

  if (rBadge) rBadge.textContent = countReview;
  if (sBadge) sBadge.textContent = countSubs;
  if (vBadge) vBadge.textContent = countRevs;
  if (aBadge) aBadge.textContent = countAppr;
}

async function renderCurrentTabContent(container) {
  const contentArea = container.querySelector('#review-content-area');
  if (!contentArea) return;

  const currentUser = store.getCurrentUser();

  if (activeTab === 'submissions') {
    await renderPublicSubmissionsTab(contentArea, container);
    return;
  }

  // Articles-based tabs:
  let statusFilter = 'in_review';
  if (activeTab === 'revisions') statusFilter = 'changes_requested';
  if (activeTab === 'approved') statusFilter = 'approved';

  const res = await apiAdapter.getArticles({ status: statusFilter });
  const articles = res.data;

  if (articles.length === 0) {
    contentArea.innerHTML = `
      <div class="card" style="text-align: center; padding: 3rem 1.5rem;">
        <span style="font-size: 2.5rem; display: block; margin-bottom: 0.5rem;">✨</span>
        <h3 style="font-family: var(--font-serif); font-size: 1.25rem; color: var(--color-forest); margin-bottom: 0.35rem;">
          No stories in this queue
        </h3>
        <p style="color: var(--color-muted); font-size: 0.875rem;">
          ${activeTab === 'articles_review' ? 'All submitted stories have been reviewed.' : 'Queue is currently clear.'}
        </p>
      </div>
    `;
    return;
  }

  contentArea.innerHTML = articles.map(art => `
    <div class="review-card" data-story-id="${art.id}">
      <div class="review-card-header">
        <div>
          <div style="margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.5rem;">
            <span class="badge badge-category">${getCategoryTitle(art.category)}</span>
            <span class="badge badge-${art.status}">${formatStatusLabel(art.status)}</span>
            <span style="font-size: 0.75rem; color: var(--color-muted);">Revision #${art.revisionCount || 1}</span>
          </div>
          <h2 class="review-card-title">${escapeHtml(art.title || 'Untitled Story')}</h2>
        </div>
      </div>

      <p class="review-card-summary">${escapeHtml(art.standfirst || art.body.slice(0, 200) + '...')}</p>

      ${art.reviewNotes ? `
        <div style="background-color: var(--color-sage-soft); border-left: 3px solid var(--color-clay); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8125rem;">
          <strong>Editorial Note:</strong> ${escapeHtml(art.reviewNotes)}
        </div>
      ` : ''}

      <div class="review-card-footer">
        <div style="font-size: 0.8125rem; color: var(--color-muted);">
          Reported by <strong>${escapeHtml(art.author?.name || 'Staff Reporter')}</strong> · Updated ${formatTimeAgo(art.updatedAt)}
        </div>

        <div class="review-actions-group">
          <button type="button" class="btn btn-outline btn-sm" data-action="open-in-editor" data-id="${art.id}">
            ✏️ Edit
          </button>
          <button type="button" class="btn btn-primary btn-sm" data-action="inspect-story" data-id="${art.id}">
            🔍 Inspect & Fact-Check
          </button>
        </div>
      </div>
    </div>
  `).join('');

  // Bind Actions
  contentArea.querySelectorAll('[data-action="open-in-editor"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      store.setCurrentView('editor', { storyId: id });
    });
  });

  contentArea.querySelectorAll('[data-action="inspect-story"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const article = articles.find(a => a.id === id);
      if (article) inspectStoryModal(article, container);
    });
  });
}

async function renderPublicSubmissionsTab(contentArea, container) {
  const res = await apiAdapter.getSubmissions();
  const submissions = res.data;

  if (submissions.length === 0) {
    contentArea.innerHTML = `
      <div class="card" style="text-align: center; padding: 3rem 1.5rem;">
        <span style="font-size: 2.5rem; display: block; margin-bottom: 0.5rem;">📨</span>
        <h3 style="font-family: var(--font-serif); font-size: 1.25rem; color: var(--color-forest); margin-bottom: 0.35rem;">
          No reader tips in queue
        </h3>
        <p style="color: var(--color-muted); font-size: 0.875rem;">
          Public tips submitted at the /submit page will appear here for editorial review.
        </p>
      </div>
    `;
    return;
  }

  contentArea.innerHTML = `
    <div class="ethics-notice-box" style="margin-bottom: 1.5rem;">
      <h4>⚠️ Crucial Newsroom Requirement</h4>
      <p>
        Public reader submissions can be made without credentials, but are <strong>NEVER published automatically</strong>.
        Every tip must be corroborated by a reporter, converted to a draft story, and taken through the complete fact-checking workflow.
      </p>
    </div>

    ${submissions.map(sub => `
      <div class="review-card" data-sub-id="${sub.id}">
        <div class="review-card-header">
          <div>
            <div style="margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.5rem;">
              <span class="badge badge-category">${getCategoryTitle(sub.category)}</span>
              <span class="badge badge-${sub.status}">${sub.status.toUpperCase()}</span>
              <span style="font-size: 0.75rem; color: var(--color-muted);">Ref: #${sub.id}</span>
            </div>
            <h2 class="review-card-title">${escapeHtml(sub.headline)}</h2>
          </div>
        </div>

        <p class="review-card-summary">${escapeHtml(sub.body)}</p>

        <div style="background-color: var(--color-parchment-light); border: 1px solid var(--color-rule); border-radius: var(--radius-sm); padding: 0.75rem; font-size: 0.8125rem;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem;">
            <div><strong>Submitter:</strong> ${escapeHtml(sub.submitterName)}</div>
            <div><strong>Affiliation:</strong> ${escapeHtml(sub.organization)}</div>
            <div><strong>Location:</strong> ${escapeHtml(sub.location)}</div>
            <div><strong>Contact:</strong> ${escapeHtml(sub.submitterEmail)} ${sub.submitterPhone ? `· ${escapeHtml(sub.submitterPhone)}` : ''}</div>
          </div>
        </div>

        <div class="review-card-footer">
          <div style="font-size: 0.75rem; color: var(--color-muted);">
            Received ${formatTimeAgo(sub.createdAt)}
          </div>

          <div class="review-actions-group">
            <button type="button" class="btn btn-outline btn-sm" data-action="dismiss-sub" data-id="${sub.id}" style="color: #DC2626;">
              Dismiss Tip
            </button>
            <button type="button" class="btn btn-success btn-sm" data-action="convert-sub" data-id="${sub.id}">
              ✍️ Convert to Draft Story
            </button>
          </div>
        </div>
      </div>
    `).join('')}
  `;

  // Bind Actions for Submissions
  contentArea.querySelectorAll('[data-action="convert-sub"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const currentUser = store.getCurrentUser();
      const res = await apiAdapter.convertSubmissionToArticle(id, currentUser);
      showToast('Tip converted into a new draft story! Opening editor...', 'success');
      store.setCurrentView('editor', { storyId: res.data.id });
    });
  });

  contentArea.querySelectorAll('[data-action="dismiss-sub"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      await apiAdapter.updateSubmissionStatus(id, 'rejected', 'Dismissed by editor');
      showToast('Tip dismissed', 'info');
      await updateTabCounters(container);
      await renderPublicSubmissionsTab(contentArea, container);
    });
  });
}

function inspectStoryModal(article, container) {
  const currentUser = store.getCurrentUser();

  const contentHtml = `
    <div style="display: flex; flex-direction: column; gap: 1rem;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
        <span class="badge badge-category">${getCategoryTitle(article.category)}</span>
        <span class="badge badge-${article.status}">${formatStatusLabel(article.status)}</span>
      </div>

      <h1 style="font-family: var(--font-serif); font-size: 1.5rem; line-height: 1.3; color: var(--color-forest);">
        ${escapeHtml(article.title)}
      </h1>

      <p style="font-family: var(--font-serif); font-size: 1.1rem; font-style: italic; color: var(--color-ink-light); border-left: 3px solid var(--color-clay); padding-left: 0.75rem;">
        ${escapeHtml(article.standfirst || '')}
      </p>

      <div style="font-size: 0.8125rem; color: var(--color-muted); border-bottom: 1px solid var(--color-rule); padding-bottom: 0.5rem;">
        By <strong>${escapeHtml(article.author?.name || 'Staff Reporter')}</strong> · Revision #${article.revisionCount || 1}
      </div>

      ${article.featuredImage ? `
        <div>
          <img src="${escapeHtml(article.featuredImage.url)}" alt="${escapeHtml(article.featuredImage.alt)}" style="width: 100%; max-height: 250px; object-fit: cover; border-radius: var(--radius-sm);">
          <div style="font-size: 0.75rem; color: var(--color-muted); margin-top: 0.25rem;">
            Caption: ${escapeHtml(article.featuredImage.caption || '')} · Credit: ${escapeHtml(article.featuredImage.credit || '')}
          </div>
        </div>
      ` : ''}

      <div style="font-family: var(--font-serif); font-size: 1rem; line-height: 1.6; color: var(--color-ink); max-height: 250px; overflow-y: auto; background: var(--color-parchment-light); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--color-rule);">
        ${escapeHtml(article.body).replace(/\n\n/g, '<p style="margin-bottom: 0.75rem;"></p>')}
      </div>

      <!-- Verification Checklist -->
      <div class="checklist-box">
        <div class="checklist-title">Editorial Fact-Check Checklist</div>
        <ul class="checklist-items">
          <li class="checklist-item">
            <input type="checkbox" id="chk-sources" checked>
            <label for="chk-sources">Named sources corroborated; dates and locations confirmed</label>
          </li>
          <li class="checklist-item">
            <input type="checkbox" id="chk-consent" checked>
            <label for="chk-consent">Subject dignity and consent verified; right of reply afforded</label>
          </li>
          <li class="checklist-item">
            <input type="checkbox" id="chk-rights" checked>
            <label for="chk-rights">Image rights cleared and descriptive alt text provided</label>
          </li>
        </ul>
      </div>

      <!-- Action Buttons -->
      <div style="display: flex; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; border-top: 1px solid var(--color-rule); padding-top: 0.75rem;">
        <button type="button" class="btn btn-outline" id="modal-open-editor">✏️ Open in Full Editor</button>
        <button type="button" class="btn btn-danger" id="modal-request-changes">✏️ Request Changes</button>
        <button type="button" class="btn btn-success" id="modal-approve-story">✅ Approve Story</button>
        ${currentUser.role === 'editor_in_chief' ? `
          <button type="button" class="btn btn-primary" id="modal-publish-story" style="background-color: var(--color-forest-dark);">🚀 Publish Live</button>
        ` : ''}
      </div>
    </div>
  `;

  openModal({
    title: 'Editorial Story Inspection',
    contentHtml,
    onRender: (modalBody, close) => {
      modalBody.querySelector('#modal-open-editor').addEventListener('click', () => {
        close();
        store.setCurrentView('editor', { storyId: article.id });
      });

      modalBody.querySelector('#modal-request-changes').addEventListener('click', () => {
        const notes = prompt('Enter editorial feedback guidance for the reporter:');
        if (notes && notes.trim()) {
          apiAdapter.updateArticleStatus(article.id, 'changes_requested', notes.trim()).then(async () => {
            close();
            showToast('Changes requested from reporter', 'info');
            await updateTabCounters(container);
            await renderCurrentTabContent(container);
          });
        }
      });

      modalBody.querySelector('#modal-approve-story').addEventListener('click', () => {
        apiAdapter.updateArticleStatus(article.id, 'approved', 'Editorial fact-check approved').then(async () => {
          close();
          showToast('Story approved for publication!', 'success');
          await updateTabCounters(container);
          await renderCurrentTabContent(container);
        });
      });

      const pubBtn = modalBody.querySelector('#modal-publish-story');
      if (pubBtn) {
        pubBtn.addEventListener('click', () => {
          if (confirm('Publish this story to the Church Times Nigeria live web feed now?')) {
            apiAdapter.updateArticleStatus(article.id, 'published', 'Published by Editor-in-Chief').then(async () => {
              close();
              showToast('🚀 Story published to live feed!', 'success');
              await updateTabCounters(container);
              await renderCurrentTabContent(container);
            });
          }
        });
      }
    }
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

function formatStatusLabel(status) {
  const labels = {
    draft: 'Draft',
    in_review: 'In Review',
    changes_requested: 'Changes Requested',
    approved: 'Approved',
    published: 'Published'
  };
  return labels[status] || status;
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
