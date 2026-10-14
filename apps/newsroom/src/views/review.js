/**
 * Review Queue View
 *
 * - Stories awaiting review / revisions / approved (real article statuses).
 * - Reader tips from the staff-only /api/submissions collection. Tips are NEVER published automatically; the only
 *   way to turn one into a story is POST /api/submissions/:id/convert, which creates a DRAFT on the server.
 *   The CMS convert endpoint pre-fills the story byline with the submitter's name (email and phone are never copied);
 *   editors must clear the byline before publishing when the source must stay anonymous.
 * - The public tip form itself lives on the public site, not here.
 */

import { api } from '../api/index.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { openModal, askText, askConfirm } from '../components/modal.js';
import { showApiError } from '../components/notify.js';
import { markdownToHtml } from '../lexical.js';
import { PUBLIC_SITE_URL } from '../config.js';
import { escapeHtml, formatTimeAgo, statusBadge, cssToken, latestGuard } from '../util.js';

let activeTab = 'articles_review';
let tipFilter = 'open';
const beginRender = latestGuard();

const TIP_FILTERS = {
  open: ['new', 'under_review'],
  accepted: ['accepted'],
  converted: ['converted'],
  rejected: ['rejected'],
  all: undefined
};

export async function renderReview(container, preselectedStoryId = null) {
  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Editorial Review Queue</h1>
          <p class="view-subtitle">Rigour, accuracy and fairness. Review pending stories, verify reader tips, and approve publications.</p>
        </div>
      </div>
    </div>

    <div id="review-error" data-testid="review-error" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;"></div>

    <div class="review-tabs" role="tablist" aria-label="Review queue categories">
      ${[
        ['articles_review', 'In Review', 'tab-count-review'],
        ['submissions', 'Reader Tips & Submissions', 'tab-count-subs'],
        ['revisions', 'Revisions Requested', 'tab-count-revs'],
        ['approved', 'Approved Ready', 'tab-count-appr']
      ].map(([key, label, countId]) => `
        <button type="button" class="review-tab-btn ${activeTab === key ? 'active' : ''}" data-tab="${key}" data-testid="review-tab-${key}" role="tab" aria-selected="${activeTab === key}">
          ${escapeHtml(label)} <span class="nav-badge" id="${countId}">-</span>
        </button>`).join('')}
    </div>

    <div id="review-content-area" data-testid="review-content" role="tabpanel">
      <div style="text-align: center; padding: 2rem;">Loading queue items...</div>
    </div>
  `;

  container.querySelectorAll('.review-tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      activeTab = btn.getAttribute('data-tab');
      container.querySelectorAll('.review-tab-btn').forEach(b => {
        const current = b === btn;
        b.classList.toggle('active', current);
        b.setAttribute('aria-selected', current ? 'true' : 'false');
      });
      await renderCurrentTabContent(container);
    });
  });

  await Promise.all([updateTabCounters(container), renderCurrentTabContent(container)]);

  if (preselectedStoryId) {
    try {
      const res = await api.getArticle(preselectedStoryId);
      inspectStoryModal(res.data, container);
    } catch (err) {
      showApiError(err);
    }
  }
}

function setError(container, message) {
  const el = container.querySelector('#review-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

async function updateTabCounters(container) {
  try {
    const counts = await api.getArticleCounts();
    const set = (id, v) => { const el = container.querySelector(id); if (el) el.textContent = String(v); };
    set('#tab-count-review', counts.in_review ?? 0);
    set('#tab-count-revs', counts.changes_requested ?? 0);
    set('#tab-count-appr', counts.approved ?? 0);
  } catch (err) {
    setError(container, err.message);
  }
  if (api.can('submission.review')) {
    try {
      const subs = await api.getSubmissions({ statuses: TIP_FILTERS.open });
      const el = container.querySelector('#tab-count-subs');
      if (el) el.textContent = String(subs.totalDocs);
    } catch { /* shown when the tab is opened */ }
  } else {
    const el = container.querySelector('#tab-count-subs');
    if (el) el.textContent = '-';
  }
}

async function renderCurrentTabContent(container) {
  const area = container.querySelector('#review-content-area');
  if (!area) return;
  const isCurrent = beginRender();

  if (activeTab === 'submissions') {
    await renderSubmissionsTab(area, container, isCurrent);
    return;
  }

  const status = { articles_review: 'in_review', revisions: 'changes_requested', approved: 'approved' }[activeTab];
  let articles;
  try {
    articles = (await api.getArticles({ status })).data;
    if (!isCurrent()) return;
  } catch (err) {
    if (!isCurrent()) return;
    area.innerHTML = '<div class="card" style="padding:2rem; text-align:center;">This queue could not be loaded.</div>';
    setError(container, showApiError(err, 'Could not load the queue: '));
    return;
  }
  setError(container, '');

  if (articles.length === 0) {
    area.innerHTML = `
      <div class="card" style="text-align: center; padding: 3rem 1.5rem;" data-testid="review-empty">
        <h3 style="font-family: var(--font-serif); font-size: 1.25rem; color: var(--color-forest); margin-bottom: 0.35rem;">No stories in this queue</h3>
        <p style="color: var(--color-muted); font-size: 0.875rem;">${activeTab === 'articles_review' ? 'All submitted stories have been reviewed.' : 'Queue is currently clear.'}</p>
      </div>`;
    return;
  }

  area.innerHTML = articles.map(art => `
    <div class="review-card" data-testid="review-card" data-story-id="${escapeHtml(art.id)}" data-status="${escapeHtml(art.status)}">
      <div class="review-card-header">
        <div>
          <div style="margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.5rem;">
            <span class="badge badge-category">${escapeHtml(art.categoryTitle || '-')}</span>
            ${statusBadge(art.status)}
          </div>
          <h2 class="review-card-title">${escapeHtml(art.title || 'Untitled Story')}</h2>
        </div>
      </div>
      <p class="review-card-summary">${escapeHtml(art.standfirst || `${art.bodyMd.slice(0, 200)}${art.bodyMd.length > 200 ? '...' : ''}`)}</p>
      ${art.reviewNotes ? `
        <div style="background-color: var(--color-sage-soft); border-left: 3px solid var(--color-clay); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8125rem;">
          <strong>Editorial Note:</strong> ${escapeHtml(art.reviewNotes)}
        </div>` : ''}
      <div class="review-card-footer">
        <div style="font-size: 0.8125rem; color: var(--color-muted);">
          ${art.authorName ? `By <strong>${escapeHtml(art.authorName)}</strong> &middot; ` : ''}Updated ${escapeHtml(formatTimeAgo(art.updatedAt))}
        </div>
        <div class="review-actions-group">
          <button type="button" class="btn btn-outline btn-sm" data-testid="review-edit" data-action="open-in-editor" data-id="${escapeHtml(art.id)}">Open in editor</button>
          <button type="button" class="btn btn-primary btn-sm" data-testid="review-inspect" data-action="inspect-story" data-id="${escapeHtml(art.id)}">Inspect &amp; Fact-Check</button>
        </div>
      </div>
    </div>`).join('');

  area.querySelectorAll('[data-action="open-in-editor"]').forEach(btn => {
    btn.addEventListener('click', () => store.setCurrentView('editor', { storyId: btn.getAttribute('data-id') }));
  });
  area.querySelectorAll('[data-action="inspect-story"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const article = articles.find(a => a.id === btn.getAttribute('data-id'));
      if (article) inspectStoryModal(article, container);
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Reader tips
// ---------------------------------------------------------------------------------------------------

async function renderSubmissionsTab(area, container, isCurrent = () => true) {
  if (!api.can('submission.review')) {
    area.innerHTML = `
      <div class="card" style="text-align:center; padding: 2rem;" data-testid="tips-not-permitted">
        <p style="margin:0;">Only editors can review reader tips.</p>
      </div>`;
    return;
  }

  let subs;
  try {
    subs = (await api.getSubmissions({ statuses: TIP_FILTERS[tipFilter] })).data;
    if (!isCurrent()) return;
  } catch (err) {
    if (!isCurrent()) return;
    area.innerHTML = '<div class="card" style="padding:2rem; text-align:center;">Reader tips could not be loaded.</div>';
    setError(container, showApiError(err, 'Could not load reader tips: '));
    return;
  }
  setError(container, '');

  const publicLink = PUBLIC_SITE_URL
    ? `<a href="${escapeHtml(PUBLIC_SITE_URL)}/#submit" target="_blank" rel="noopener noreferrer" data-testid="public-tip-form-link">the public site's submission form</a>`
    : "the public site's submission form";

  area.innerHTML = `
    <div class="ethics-notice-box" style="margin-bottom: 1.5rem;">
      <h4>Crucial Newsroom Requirement</h4>
      <p>
        Reader tips arrive through ${publicLink}. They are <strong>NEVER published automatically</strong>.
        Every tip must be corroborated by a reporter, converted to a draft story and taken through the full workflow.
        The submitter's name is pre-filled as the byline; email and phone are never copied. Clear the byline before publishing if the source must stay anonymous.
      </p>
    </div>
    <div class="filter-bar" style="margin-bottom: 1rem;">
      <div class="filter-group">
        <label for="tip-filter-select" class="form-label" style="margin-bottom:0;">Show:</label>
        <select id="tip-filter-select" class="select-input" data-testid="tip-filter">
          ${Object.keys(TIP_FILTERS).map(k => `<option value="${k}" ${k === tipFilter ? 'selected' : ''}>${escapeHtml(k)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="tip-list" data-testid="tip-list">
    ${subs.length === 0 ? `
      <div class="card" style="text-align: center; padding: 3rem 1.5rem;" data-testid="tips-empty">
        <h3 style="font-family: var(--font-serif); font-size: 1.25rem; color: var(--color-forest);">No reader tips here</h3>
      </div>` : subs.map(sub => `
      <div class="review-card" data-testid="tip-card" data-sub-id="${escapeHtml(sub.id)}" data-status="${escapeHtml(sub.status)}">
        <div class="review-card-header">
          <div>
            <div style="margin-bottom: 0.35rem; display: flex; align-items: center; gap: 0.5rem;">
              ${sub.categorySuggestion ? `<span class="badge badge-category">${escapeHtml(sub.categorySuggestion)}</span>` : ''}
              <span class="badge badge-${cssToken(sub.status)}" data-testid="tip-status">${escapeHtml(sub.status.replace('_', ' ').toUpperCase())}</span>
              <span style="font-size: 0.75rem; color: var(--color-muted);">Ref: ${escapeHtml(sub.reference || sub.id)}</span>
            </div>
            <h2 class="review-card-title">${escapeHtml(sub.title)}</h2>
          </div>
        </div>
        <p class="review-card-summary" style="white-space: pre-wrap;">${escapeHtml(sub.body)}</p>
        <div style="background-color: var(--color-parchment-light); border: 1px solid var(--color-rule); border-radius: var(--radius-sm); padding: 0.75rem; font-size: 0.8125rem;">
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem;">
            <div><strong>Submitter:</strong> ${escapeHtml(sub.name)}</div>
            <div><strong>Location:</strong> ${escapeHtml(sub.location || 'not given')}</div>
            <div><strong>Contact:</strong> ${escapeHtml(sub.email)}${sub.phone ? ` &middot; ${escapeHtml(sub.phone)}` : ''}</div>
          </div>
          ${sub.reviewerNotes ? `<div style="margin-top:0.5rem;"><strong>Reviewer notes:</strong> ${escapeHtml(sub.reviewerNotes)}</div>` : ''}
        </div>
        <div class="review-card-footer">
          <div style="font-size: 0.75rem; color: var(--color-muted);">Received ${escapeHtml(formatTimeAgo(sub.createdAt))}</div>
          <div class="review-actions-group">
            ${['new', 'under_review', 'accepted'].includes(sub.status) ? `
              <button type="button" class="btn btn-outline btn-sm" data-testid="tip-dismiss" data-action="dismiss-sub" data-id="${escapeHtml(sub.id)}" style="color: #DC2626;">Dismiss Tip</button>
              <button type="button" class="btn btn-success btn-sm" data-testid="tip-convert" data-action="convert-sub" data-id="${escapeHtml(sub.id)}">Convert to Draft Story</button>` : ''}
            ${sub.status === 'converted' && sub.articleId ? `
              <button type="button" class="btn btn-outline btn-sm" data-testid="tip-open-story" data-action="open-converted" data-id="${escapeHtml(sub.articleId)}">Open story</button>` : ''}
          </div>
        </div>
      </div>`).join('')}
    </div>`;

  area.querySelector('#tip-filter-select').addEventListener('change', async e => {
    tipFilter = e.target.value;
    await renderCurrentTabContent(container);
  });

  area.querySelectorAll('[data-action="open-converted"]').forEach(btn => {
    btn.addEventListener('click', () => store.setCurrentView('editor', { storyId: btn.getAttribute('data-id') }));
  });

  area.querySelectorAll('[data-action="convert-sub"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sub = subs.find(s => s.id === btn.getAttribute('data-id'));
      if (sub) openConvertModal(sub, container);
    });
  });

  area.querySelectorAll('[data-action="dismiss-sub"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const notes = await askText({
        title: 'Dismiss tip',
        label: 'Reason for dismissing this tip (kept on the record):',
        confirmLabel: 'Dismiss tip',
        testid: 'dismiss-tip'
      });
      if (!notes) return;
      try {
        await api.updateSubmission(id, { status: 'rejected', reviewerNotes: notes });
        showToast('Tip dismissed', 'info');
        await updateTabCounters(container);
        await renderCurrentTabContent(container);
      } catch (err) {
        showApiError(err);
      }
    });
  });
}

async function openConvertModal(sub, container) {
  let categories;
  try {
    categories = await api.getCategories();
  } catch (err) {
    showApiError(err);
    return;
  }
  const suggested = categories.find(c =>
    c.title.toLowerCase() === sub.categorySuggestion.toLowerCase() || c.slug === sub.categorySuggestion.toLowerCase());

  openModal({
    title: 'Convert tip to draft story',
    contentHtml: `
      <form id="convert-form" data-testid="tip-convert-form">
        <p style="margin-bottom: 0.75rem;">The CMS will create a <strong>draft</strong> story from &ldquo;${escapeHtml(sub.title)}&rdquo; with you as the author, and mark the tip as converted. The CMS credits the submitter's name as the story byline (not their email or phone); you can change or clear it in the editor.</p>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="convert-category" class="form-label">Section for the new story</label>
          <select id="convert-category" class="form-select" data-testid="tip-convert-category">
            ${categories.map(c => `<option value="${escapeHtml(c.id)}" ${suggested && suggested.id === c.id ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
          </select>
        </div>
        <div id="convert-error" data-testid="tip-convert-error" role="alert" style="display:none; color:#B91C1C; font-size:0.8125rem; margin-bottom:0.5rem;"></div>
        <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
          <button type="button" class="btn btn-outline" id="convert-cancel">Cancel</button>
          <button type="submit" class="btn btn-success" id="convert-confirm" data-testid="tip-convert-confirm">Create draft story</button>
        </div>
      </form>`,
    onRender: (body, close) => {
      body.querySelector('#convert-cancel').addEventListener('click', close);
      body.querySelector('#convert-form').addEventListener('submit', async e => {
        e.preventDefault();
        const submit = body.querySelector('#convert-confirm');
        const errEl = body.querySelector('#convert-error');
        errEl.style.display = 'none';
        submit.disabled = true;
        try {
          const res = await api.convertSubmission(sub.id, body.querySelector('#convert-category').value);
          close();
          showToast('Tip converted into a new draft story! Opening editor...', 'success');
          store.setCurrentView('editor', { storyId: res.articleId });
        } catch (err) {
          errEl.textContent = showApiError(err);
          errEl.style.display = 'block';
          submit.disabled = false;
          await updateTabCounters(container);
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------------
// Story inspection
// ---------------------------------------------------------------------------------------------------

function inspectStoryModal(article, container) {
  const ctx = { status: article.status, categoryId: article.categoryId, isAuthor: false };
  const canApprove = api.can('story.approve', ctx);
  const canRequest = api.can('story.request_changes', ctx);
  const canPublish = api.can('story.publish', { ...ctx, isAuthor: String(article.authorId) === String(api.getCurrentUser()?.id) });

  openModal({
    title: 'Editorial Story Inspection',
    contentHtml: `
      <div style="display: flex; flex-direction: column; gap: 1rem;" data-testid="inspect-modal">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
          <span class="badge badge-category">${escapeHtml(article.categoryTitle || '-')}</span>
          ${statusBadge(article.status)}
        </div>
        <h1 style="font-family: var(--font-serif); font-size: 1.5rem; line-height: 1.3; color: var(--color-forest);">${escapeHtml(article.title)}</h1>
        ${article.standfirst ? `<p style="font-family: var(--font-serif); font-size: 1.1rem; font-style: italic; color: var(--color-ink-light); border-left: 3px solid var(--color-clay); padding-left: 0.75rem;">${escapeHtml(article.standfirst)}</p>` : ''}
        <div style="font-size: 0.8125rem; color: var(--color-muted); border-bottom: 1px solid var(--color-rule); padding-bottom: 0.5rem;">
          ${article.authorName ? `By <strong>${escapeHtml(article.authorName)}</strong> &middot; ` : ''}Slug: /${escapeHtml(article.slug)}
        </div>
        ${article.featuredImage && article.featuredImage.url ? `
          <div>
            <img src="${escapeHtml(article.featuredImage.url)}" alt="${escapeHtml(article.featuredImage.alt)}" style="width: 100%; max-height: 250px; object-fit: cover; border-radius: var(--radius-sm);">
            <div style="font-size: 0.75rem; color: var(--color-muted); margin-top: 0.25rem;">
              ${escapeHtml(article.featuredImage.caption || '')}${article.featuredImage.credit ? ` &middot; Credit: ${escapeHtml(article.featuredImage.credit)}` : ''}
            </div>
          </div>` : ''}
        <div class="preview-body" data-testid="inspect-body" style="max-height: 250px; overflow-y: auto; background: var(--color-parchment-light); padding: 0.75rem; border-radius: var(--radius-sm); border: 1px solid var(--color-rule);">
          ${markdownToHtml(article.bodyMd)}
        </div>

        <div class="checklist-box">
          <div class="checklist-title">Editorial Fact-Check Checklist (aid only; the CMS does not require it)</div>
          <ul class="checklist-items">
            <li class="checklist-item"><input type="checkbox" id="chk-sources"><label for="chk-sources">Named sources corroborated; dates and locations confirmed</label></li>
            <li class="checklist-item"><input type="checkbox" id="chk-consent"><label for="chk-consent">Subject dignity and consent verified; right of reply afforded</label></li>
            <li class="checklist-item"><input type="checkbox" id="chk-rights"><label for="chk-rights">Image rights cleared and descriptive alt text provided</label></li>
          </ul>
        </div>

        <div id="inspect-error" data-testid="inspect-error" role="alert" style="display:none; color:#B91C1C; font-size:0.8125rem;"></div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; flex-wrap: wrap; border-top: 1px solid var(--color-rule); padding-top: 0.75rem;">
          <button type="button" class="btn btn-outline" id="modal-open-editor" data-testid="inspect-open-editor">Open in Full Editor</button>
          ${canRequest ? '<button type="button" class="btn btn-danger" id="modal-request-changes" data-testid="inspect-request-changes">Request Changes</button>' : ''}
          ${canApprove ? '<button type="button" class="btn btn-success" id="modal-approve-story" data-testid="inspect-approve">Approve Story</button>' : ''}
          ${canPublish ? '<button type="button" class="btn btn-primary" id="modal-publish-story" data-testid="inspect-publish" style="background-color: var(--color-forest-dark);">Publish Live</button>' : ''}
        </div>
      </div>`,
    onRender: (body, close) => {
      const errEl = body.querySelector('#inspect-error');
      const transition = async (status, opts, success) => {
        errEl.style.display = 'none';
        try {
          await api.transitionArticle(article.id, status, opts);
          close();
          showToast(success, status === 'changes_requested' ? 'info' : 'success');
          await updateTabCounters(container);
          await renderCurrentTabContent(container);
        } catch (err) {
          errEl.textContent = showApiError(err);
          errEl.style.display = 'block';
        }
      };

      body.querySelector('#modal-open-editor').addEventListener('click', () => {
        close();
        store.setCurrentView('editor', { storyId: article.id });
      });

      body.querySelector('#modal-request-changes')?.addEventListener('click', async () => {
        const notes = await askText({
          title: 'Request Editorial Changes',
          label: 'Feedback and revision guidance for the reporter:',
          confirmLabel: 'Send Revision Request',
          testid: 'request-changes'
        });
        if (!notes) return;
        await transition('changes_requested', { reviewNotes: notes }, 'Changes requested from reporter');
      });

      body.querySelector('#modal-approve-story')?.addEventListener('click', () =>
        transition('approved', {}, 'Story approved for publication!'));

      body.querySelector('#modal-publish-story')?.addEventListener('click', async () => {
        const ok = await askConfirm({
          title: 'Publish story',
          message: 'Publish this story to the Church Times Nigeria live web feed now?',
          confirmLabel: 'Publish now',
          testid: 'publish'
        });
        if (ok) await transition('published', {}, 'Story published to live feed!');
      });
    }
  });
}
