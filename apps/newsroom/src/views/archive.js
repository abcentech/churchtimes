/**
 * Archive review: recovered archive drafts (apps/cms/docs/archive-candidate-schema.md).
 *
 * Queue: recovered drafts filtered by review status, confidence and import batch, with counts. Review screen: the recovered
 * body beside its staff-only provenance. The source address is shown as plain text and a link that opens only when clicked
 * (new tab, rel="noopener noreferrer", no referrer); nothing from the old site is ever loaded into this page.
 *
 * Approve / Reject set provenance.reviewStatus through the CMS (editors only, audited server-side). A recovered story stays a
 * draft; publishing still goes through the normal review and publish workflow, and the CMS refuses it until it is approved here.
 */

import { api } from '../api/index.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { askConfirm } from '../components/modal.js';
import { showApiError } from '../components/notify.js';
import { markdownToHtml } from '../lexical.js';
import { escapeHtml, formatTimeAgo, cssToken, latestGuard } from '../util.js';
import { STALE_MESSAGE, isStaleConflict } from '../stale-guard.js';
import {
  CONFIDENCE_LEVELS, REVIEW_STATUSES, cleanFilters, confidenceHelp, confidenceLabel, groupSha, originalDateLabel,
  publishBlockReason, reviewActions, reviewLabel, safeSourceUrl, BATCH_RE
} from '../archive-review.js';

let filters = { reviewStatus: 'pending', confidence: '', batch: '' };
let page = 1;
const beginRender = latestGuard();

export const confidenceBadge = c =>
  `<span class="badge badge-confidence-${cssToken(c) || 'unknown'}" data-testid="archive-confidence" title="${escapeHtml(confidenceHelp(c))}">${escapeHtml(confidenceLabel(c))}</span>`;
export const reviewBadge = s =>
  `<span class="badge badge-archive-${cssToken(s) || 'pending'}" data-testid="archive-review-status">${escapeHtml(reviewLabel(s))}</span>`;

export async function renderArchive(container, storyId = null) {
  if (!api.can('archive.view')) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding: 2rem;" data-testid="archive-not-permitted" role="alert">
        <h1 class="view-title" style="font-size:1.25rem;">Archive review is for editors</h1>
        <p style="margin:0.5rem 0 0;">Recovered archive drafts can be reviewed by section editors, the editor-in-chief and administrators.</p>
      </div>`;
    return;
  }
  if (storyId) return renderReviewScreen(container, storyId);
  return renderQueue(container);
}

// ---------------------------------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------------------------------

async function renderQueue(container) {
  const isCurrent = beginRender();
  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Archive review</h1>
          <p class="view-subtitle">Pages recovered from the old site arrive as drafts. Check each one against its source, then approve or reject it. Nothing here is public.</p>
        </div>
      </div>
    </div>
    <div id="archive-error" data-testid="archive-error" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;"></div>
    <form id="archive-filters" class="filter-bar archive-filters" data-testid="archive-filters" aria-label="Filter recovered drafts" novalidate>
      <div class="filter-group">
        <label for="archive-filter-status" class="form-label">Review status</label>
        <select id="archive-filter-status" class="select-input" data-testid="archive-filter-status"></select>
      </div>
      <div class="filter-group">
        <label for="archive-filter-confidence" class="form-label">Recovery confidence</label>
        <select id="archive-filter-confidence" class="select-input" data-testid="archive-filter-confidence"></select>
      </div>
      <div class="filter-group">
        <label for="archive-filter-batch" class="form-label">Import batch</label>
        <input id="archive-filter-batch" class="form-input" data-testid="archive-filter-batch" type="text" inputmode="text" maxlength="80" autocomplete="off" spellcheck="false" placeholder="All batches" value="${escapeHtml(filters.batch)}" aria-describedby="archive-batch-hint">
      </div>
      <div class="filter-group archive-filter-actions">
        <button type="submit" class="btn btn-outline btn-sm" data-testid="archive-apply">Apply</button>
        <button type="button" class="btn btn-outline btn-sm" id="archive-clear" data-testid="archive-clear">Clear filters</button>
      </div>
      <p id="archive-batch-hint" class="form-hint archive-hint">Batch is the exact label shown on each draft (for example arc-0123456789ab).</p>
    </form>
    <p id="archive-summary" class="archive-summary" data-testid="archive-summary" role="status" aria-live="polite">Loading recovered drafts...</p>
    <div id="archive-list" data-testid="archive-list"></div>
    <nav id="archive-pager" class="archive-pager" aria-label="Pages of recovered drafts" hidden></nav>
  `;

  const form = container.querySelector('#archive-filters');
  const statusSel = container.querySelector('#archive-filter-status');
  const confSel = container.querySelector('#archive-filter-confidence');
  const batchInput = container.querySelector('#archive-filter-batch');
  const fillSelects = counts => {
    const n = (group, key) => (counts ? ` (${counts[group][key]})` : '');
    statusSel.innerHTML = `<option value="">All statuses</option>${REVIEW_STATUSES.map(s =>
      `<option value="${s}" ${filters.reviewStatus === s ? 'selected' : ''}>${escapeHtml(reviewLabel(s))}${n('reviewStatus', s)}</option>`).join('')}`;
    confSel.innerHTML = `<option value="">All confidence levels</option>${CONFIDENCE_LEVELS.map(c =>
      `<option value="${c}" ${filters.confidence === c ? 'selected' : ''}>${escapeHtml(confidenceLabel(c))}${n('confidence', c)}</option>`).join('')}`;
  };
  fillSelects(null);

  const reload = () => { page = 1; return renderQueue(container); };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const typed = batchInput.value.trim();
    if (typed && !BATCH_RE.test(typed)) {
      setError(container, 'That is not a valid batch label. Use letters, digits, dots, underscores and hyphens only.');
      batchInput.setAttribute('aria-invalid', 'true');
      batchInput.focus();
      return;
    }
    filters = cleanFilters({ reviewStatus: statusSel.value, confidence: confSel.value, batch: typed });
    await reload();
  });
  container.querySelector('#archive-clear').addEventListener('click', async () => {
    filters = { reviewStatus: '', confidence: '', batch: '' };
    await reload();
  });

  let list;
  let counts;
  try {
    [list, counts] = await Promise.all([api.getArchiveCandidates(filters, { page }), api.getArchiveCounts(filters)]);
  } catch (err) {
    if (!isCurrent()) return;
    container.querySelector('#archive-summary').textContent = 'Recovered drafts could not be loaded.';
    setError(container, showApiError(err, 'Could not load recovered drafts: '));
    return;
  }
  if (!isCurrent()) return;
  setError(container, '');
  fillSelects(counts);

  const total = REVIEW_STATUSES.reduce((sum, s) => sum + (counts.reviewStatus[s] || 0), 0);
  container.querySelector('#archive-summary').innerHTML =
    `<strong data-testid="archive-total">${list.totalDocs}</strong> shown &middot; ` +
    REVIEW_STATUSES.map(s => `<span data-testid="archive-count-${s}">${escapeHtml(reviewLabel(s))}: <strong>${counts.reviewStatus[s]}</strong></span>`).join(' &middot; ') +
    ` &middot; <span class="archive-muted">${total} in this view before the status filter</span>`;

  const area = container.querySelector('#archive-list');
  if (list.data.length === 0) {
    area.innerHTML = `
      <div class="card" style="text-align:center; padding:3rem 1.5rem;" data-testid="archive-empty">
        <h2 style="font-family: var(--font-serif); font-size:1.25rem; color: var(--color-forest);">No recovered drafts match</h2>
        <p style="color: var(--color-muted); font-size:0.875rem;">Change or clear the filters, or ask for an archive import to be run.</p>
      </div>`;
  } else {
    area.innerHTML = `<ul class="archive-rows" aria-label="Recovered drafts">${list.data.map(rowHtml).join('')}</ul>`;
    area.querySelectorAll('[data-action="open-review"]').forEach(btn => {
      btn.addEventListener('click', () => store.setCurrentView('archive', { storyId: btn.getAttribute('data-id') }));
    });
  }

  const pager = container.querySelector('#archive-pager');
  if (list.totalPages > 1) {
    pager.hidden = false;
    pager.innerHTML = `
      <button type="button" class="btn btn-outline btn-sm" id="archive-prev" data-testid="archive-prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${list.page} of ${list.totalPages}</span>
      <button type="button" class="btn btn-outline btn-sm" id="archive-next" data-testid="archive-next" ${page >= list.totalPages ? 'disabled' : ''}>Next</button>`;
    pager.querySelector('#archive-prev').addEventListener('click', async () => { page = Math.max(1, page - 1); await renderQueue(container); });
    pager.querySelector('#archive-next').addEventListener('click', async () => { page += 1; await renderQueue(container); });
  }
}

function rowHtml(a) {
  const p = a.provenance;
  return `
    <li class="review-card archive-row" data-testid="archive-row" data-story-id="${escapeHtml(a.id)}" data-confidence="${escapeHtml(p?.confidence || '')}" data-review="${escapeHtml(p?.reviewStatus || '')}">
      <div class="archive-row-main">
        <div class="archive-row-badges">${confidenceBadge(p?.confidence)}${reviewBadge(p?.reviewStatus)}</div>
        <h2 class="review-card-title archive-row-title">${escapeHtml(a.title || 'Untitled recovered page')}</h2>
        <p class="archive-row-meta">
          <span data-testid="archive-original-date">${escapeHtml(originalDateLabel(p?.originalDate))}</span>
          <span aria-hidden="true">&middot;</span>
          <span data-testid="archive-source-host">${escapeHtml(p?.sourceHost || 'unknown source')}</span>
          <span aria-hidden="true">&middot;</span>
          <span>Updated ${escapeHtml(formatTimeAgo(a.updatedAt))}</span>
        </p>
      </div>
      <div class="review-actions-group">
        <button type="button" class="btn btn-primary btn-sm" data-testid="archive-open" data-action="open-review" data-id="${escapeHtml(a.id)}" aria-label="Review: ${escapeHtml(a.title || 'Untitled recovered page')}">Review</button>
      </div>
    </li>`;
}

function setError(container, message) {
  const el = container.querySelector('#archive-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

// ---------------------------------------------------------------------------------------------------
// Review screen
// ---------------------------------------------------------------------------------------------------

async function renderReviewScreen(container, storyId, notice = '') {
  const isCurrent = beginRender();
  container.innerHTML = '<div style="text-align:center; padding:2rem;">Loading recovered story...</div>';
  let story;
  try {
    story = (await api.getArticle(storyId)).data;
  } catch (err) {
    if (!isCurrent()) return;
    container.innerHTML = `<div class="card" style="padding:2rem; text-align:center;" role="alert" data-testid="archive-load-error">${escapeHtml(showApiError(err, 'Could not load that story: '))}<p><a href="#archive">Back to archive review</a></p></div>`;
    return;
  }
  if (!isCurrent()) return;
  if (!story.provenance) {
    container.innerHTML = `<div class="card" style="padding:2rem; text-align:center;" data-testid="archive-not-candidate">This story is not a recovered archive draft. <a href="#editor?id=${encodeURIComponent(story.id)}">Open it in the editor</a>.</div>`;
    return;
  }

  const p = story.provenance;
  const canReview = api.can('archive.review', { status: story.status, categoryId: story.categoryId });
  const actions = reviewActions(story, canReview);
  const block = publishBlockReason(story);
  const href = safeSourceUrl(p.sourceUrl);

  container.innerHTML = `
    <div class="view-header">
      <p class="archive-back"><a href="#archive" data-testid="archive-back">&larr; All recovered drafts</a></p>
      <h1 class="view-title" data-testid="archive-title">${escapeHtml(story.title || 'Untitled recovered page')}</h1>
      <div class="archive-row-badges">${confidenceBadge(p.confidence)}${reviewBadge(p.reviewStatus)}<span class="badge badge-draft">Draft</span></div>
    </div>
    <div id="archive-review-error" data-testid="archive-review-error" role="alert" class="validation-summary-alert" style="display:${notice ? 'block' : 'none'}; margin-bottom:1rem;">${escapeHtml(notice)}</div>
    ${block ? `<div class="ethics-notice-box archive-block" data-testid="archive-publish-blocked" role="status"><p style="margin:0;"><strong>Publishing is blocked.</strong> ${escapeHtml(block)}</p></div>`
      : `<div class="ethics-notice-box archive-ok" data-testid="archive-publish-clear" role="status"><p style="margin:0;"><strong>Approved.</strong> This story can now follow the normal review and publish steps in the editor. Approval does not publish it.</p></div>`}
    ${p.confidence && p.confidence !== 'partial' ? `<p class="archive-confidence-note" data-testid="archive-confidence-note"><strong>${escapeHtml(confidenceLabel(p.confidence))}:</strong> ${escapeHtml(confidenceHelp(p.confidence))}</p>` : ''}
    <div class="archive-split">
      <section class="card archive-body" aria-labelledby="archive-body-h">
        <h2 id="archive-body-h" class="archive-h">Recovered body</h2>
        <div class="preview-body" data-testid="archive-body" tabindex="0" aria-label="Recovered body text">${markdownToHtml(story.bodyMd || '', { media: id => story.bodyMedia?.[id] })}</div>
      </section>
      <aside class="card archive-prov" aria-labelledby="archive-prov-h" data-testid="archive-provenance">
        <h2 id="archive-prov-h" class="archive-h">Provenance (staff only)</h2>
        <dl class="archive-dl">
          <dt>Source address</dt>
          <dd data-testid="archive-source-url"><code class="archive-code">${escapeHtml(p.sourceUrl || 'not recorded')}</code>
            ${href ? `<div><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-testid="archive-source-link">Open the old page in a new tab</a>
              <span class="archive-muted">(opens only when you click; this app never loads it)</span></div>`
        : '<div class="archive-muted">Not a web address; no link is offered.</div>'}</dd>
          <dt>Source host</dt><dd data-testid="archive-host">${escapeHtml(p.sourceHost || 'unknown')}</dd>
          <dt>Date claimed by the page</dt><dd data-testid="archive-date">${escapeHtml(originalDateLabel(p.originalDate))} <span class="archive-muted">(not verified)</span></dd>
          <dt>Captured</dt><dd>${escapeHtml(p.captureTimestamp ? new Date(p.captureTimestamp).toUTCString() : 'unknown')}</dd>
          <dt>SHA-256 of the captured page</dt><dd data-testid="archive-sha"><code class="archive-code">${escapeHtml(groupSha(p.sourceSha256) || 'not recorded')}</code></dd>
          <dt>Recovery confidence</dt><dd>${escapeHtml(confidenceLabel(p.confidence))}: ${escapeHtml(confidenceHelp(p.confidence))}</dd>
          <dt>Import batch</dt><dd data-testid="archive-batch"><code class="archive-code">${escapeHtml(p.importBatch)}</code></dd>
          <dt>Review status</dt><dd>${escapeHtml(reviewLabel(p.reviewStatus))}</dd>
        </dl>
      </aside>
    </div>
    <div class="archive-actions" role="group" aria-label="Review decision">
      <a class="btn btn-outline" href="#editor?id=${encodeURIComponent(story.id)}" id="archive-open-editor" data-testid="archive-open-editor">Open in editor</a>
      ${actions.reject ? '<button type="button" class="btn btn-danger" id="archive-reject" data-testid="archive-reject">Reject</button>' : ''}
      ${actions.approve ? '<button type="button" class="btn btn-success" id="archive-approve" data-testid="archive-approve">Approve</button>' : ''}
      ${!canReview ? '<p class="archive-muted" data-testid="archive-review-not-permitted" style="margin:0;">Only an editor for this section can approve or reject.</p>' : ''}
    </div>`;

  const errEl = container.querySelector('#archive-review-error');
  const decide = async (decision, success, tone) => {
    errEl.style.display = 'none';
    container.querySelectorAll('.archive-actions button').forEach(b => { b.disabled = true; });
    try {
      await api.setArchiveReview(story.id, decision, { expectedUpdatedAt: story.updatedAt });
      showToast(success, tone);
      await renderReviewScreen(container, story.id);
    } catch (err) {
      if (isStaleConflict(err)) {
        showToast(err.message || STALE_MESSAGE, 'info');
        await renderReviewScreen(container, story.id, err.message || STALE_MESSAGE);
        return;
      }
      container.querySelectorAll('.archive-actions button').forEach(b => { b.disabled = false; });
      errEl.textContent = showApiError(err);
      errEl.style.display = 'block';
      errEl.focus?.();
    }
  };

  container.querySelector('#archive-approve')?.addEventListener('click', async () => {
    const weak = p.confidence !== 'partial';
    const ok = await askConfirm({
      title: 'Approve this recovered story?',
      message: `${weak ? `Recovery confidence is "${confidenceLabel(p.confidence)}": ${confidenceHelp(p.confidence)} ` : ''}Approving records your name and the time, and lets the story follow the normal review and publish steps. It does not publish it.`,
      confirmLabel: 'Approve',
      testid: 'archive-approve-confirm'
    });
    if (ok) await decide('reviewed', 'Approved. The story is still a draft.', 'success');
  });
  container.querySelector('#archive-reject')?.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Reject this recovered story?',
      message: 'The story stays a draft and cannot be published unless an editor approves it later. Your name and the time are recorded.',
      confirmLabel: 'Reject',
      testid: 'archive-reject-confirm'
    });
    if (ok) await decide('rejected', 'Rejected. The story stays a draft.', 'info');
  });
}
