/**
 * Story Editor View
 *
 * - Headline, standfirst (CMS `excerpt`), category (CMS category id), slug, featured image (media id), body.
 * - Body is edited as a markdown subset and stored as Lexical JSON (`content`); see ../lexical.js.
 *   Images inside the body are a line of their own, `![alt](media:<id>)`, stored as Lexical upload nodes.
 * - Save sends ONLY changed, allowlisted fields. Status transitions are separate explicit PATCHes whose
 *   result comes from the server response; nothing is shown as done until the CMS answered 2xx.
 * - Autosave runs only for already-saved drafts / changes_requested stories; never for published stories
 *   (those need an explicit save with a correction note) and never creates records.
 * - All story state lives in a per-render state object keyed by the view's container element, never in module
 *   variables: a slow load or save belonging to a view that was navigated away from can only touch its own
 *   (detached) state, so a PATCH always targets the story whose form is on screen.
 */

import { api } from '../api/index.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { askText, askConfirm } from '../components/modal.js';
import { showApiError } from '../components/notify.js';
import { openMediaPicker, mediaImageProblem } from '../components/media-picker.js';
import { markdownToHtml, countWords, imageToken, insertBlockLine, listImages, removeImageLine, stripImageLabels } from '../lexical.js';
import { ApiError } from '../api/errors.js';
import { STALE_MESSAGE, CONTENT_CONFLICT_MESSAGE, isStaleConflict } from '../stale-guard.js';
import { saveLocalCopy, readLocalCopy, clearLocalCopy, copyDiffers } from '../draft-guard.js';
import { escapeHtml, slugify, statusBadge, formatDate } from '../util.js';
import { MAX_EXTRA_CATEGORIES, cleanExtraIds, parseIds, toggleExtra } from '../categories.js';
import { publishBlockReason, fourEyesReason } from '../archive-review.js';
import { parseScheduleInput, isoToLocalInput, formatScheduled, defaultScheduleValue } from '../schedule.js';

// Pointer to the editor currently on screen, used only by the page-unload guard below (story state stays in `states`).
let activeEditor = null;

function localStore() {
  try { return window.sessionStorage; } catch { return null; }
}

if (typeof window !== 'undefined') {
  // Closing / reloading the tab with unsaved edits: keep a local copy and make the browser ask first.
  window.addEventListener('beforeunload', (e) => {
    const c = activeEditor;
    if (c && c.isConnected && isEditorDirty(c)) {
      syncLocalCopy(c);
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    const c = activeEditor;
    if (c && c.isConnected) syncLocalCopy(c);
  });
}

const states = new WeakMap();
const stateOf = container => states.get(container);

// UI preferences only (not story state)
let isSplitPreviewActive = true;
let isMobilePreviewActive = false;

const TIP_BYLINE_WARNING = "This story came from a reader tip. The submitter's name is pre-filled as the byline. Clear the byline before publishing if the source must stay anonymous.";

/** Trimmed on BOTH sides of every comparison (see formValues) so a stray space never looks like an edit. */
function snapshot(story) {
  return {
    title: (story.title || '').trim(),
    slug: (story.slug || '').trim(),
    standfirst: (story.standfirst || '').trim(),
    bylineName: (story.bylineName || '').trim(),
    bodyMd: stripImageLabels((story.bodyMd || '').trim()),
    categoryId: story.categoryId ? String(story.categoryId) : '',
    extraCategoryIds: cleanExtraIds(story.categoryId, story.extraCategoryIds),
    featuredImageId: story.featuredImage?.id ? String(story.featuredImage.id) : ''
  };
}

function blankStory(user, categories) {
  return {
    id: null, title: '', slug: '', standfirst: '', bylineName: '', bodyMd: '', lossy: false,
    categoryId: categories[0] ? String(categories[0].id) : '', categoryTitle: categories[0]?.title || '', extraCategoryIds: '',
    featuredImage: null, status: 'draft', authorId: user?.id || null, authorName: user?.name || '',
    updatedAt: null, publishedAt: null, reviewNotes: '', corrections: []
  };
}

function errorPanel(container, message) {
  container.innerHTML = `
    <div class="card" style="padding: 2rem; text-align:center;" data-testid="editor-load-error" role="alert">
      <h2 style="margin-bottom:0.5rem;">Could not open this story</h2>
      <p id="editor-load-error-text" style="color: var(--color-muted); margin-bottom: 1rem;"></p>
      <button type="button" class="btn btn-outline" id="btn-back-dashboard">Back to the desk</button>
    </div>`;
  container.querySelector('#editor-load-error-text').textContent = message;
  container.querySelector('#btn-back-dashboard').addEventListener('click', () => store.setCurrentView('dashboard'));
}

export async function renderEditor(container, storyId = null) {
  const user = api.getCurrentUser();

  // Every await below can outlive this view (the router replaces the host element on navigation): bail out as soon as
  // the container is detached so a stale load can never render or become the active story.
  let categories;
  try {
    categories = await api.getCategories();
  } catch (err) {
    if (!container.isConnected) return;
    showApiError(err);
    return errorPanel(container, err.message);
  }
  if (!container.isConnected) return;

  let story;
  if (storyId) {
    try {
      story = (await api.getArticle(storyId)).data;
    } catch (err) {
      if (!container.isConnected) return;
      showApiError(err);
      return errorPanel(container, err.message);
    }
    if (!container.isConnected) return;
  } else {
    story = blankStory(user, categories);
  }

  const st = {
    container,
    categories,
    currentStory: story,
    baseline: snapshot(story),
    extraCategoryIds: cleanExtraIds(story.categoryId, story.extraCategoryIds),
    slugTouched: Boolean(story.id),
    mediaCache: new Map(Object.entries(story.bodyMedia || {})), // body image id -> media view-model (previews only)
    inflight: null,
    autosavePending: false,
    autosaveTimer: null,
    fromTip: false
  };
  states.set(container, st);
  activeEditor = container;

  const editable = canEdit(story);
  const readonlyAttr = editable ? '' : 'readonly';
  const slugLocked = story.publishedAt ? 'readonly' : '';
  const bodyReadonly = !editable || story.lossy ? 'readonly' : '';

  container.innerHTML = `
    <div class="editor-sticky-bar" id="editor-actions-bar">
      <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
        <button type="button" class="btn btn-outline btn-sm" id="btn-back-dashboard" aria-label="Return to newsroom dashboard">
          &larr; Dashboard
        </button>
        <div id="story-status-badge-container" data-testid="editor-status" data-status="${escapeHtml(story.status)}">
          ${statusBadge(story.status)}
        </div>
        <div class="autosave-indicator" id="autosave-indicator" aria-live="polite">
          <span class="autosave-dot" id="autosave-dot"></span>
          <span id="autosave-label">${story.id ? 'Saved' : 'Not saved yet'}</span>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
        <span style="font-size: 0.75rem; color: var(--color-muted); margin-right: 0.5rem;" id="word-count-badge">0 words &middot; 0 min read</span>
        <button type="button" class="btn btn-outline btn-sm" id="btn-toggle-preview" aria-pressed="false">Toggle Preview</button>
        <button type="button" class="btn btn-secondary btn-sm" id="btn-save-draft" data-testid="editor-save-draft" ${editable ? '' : 'disabled'}>
          Save Draft
        </button>
        <div id="workflow-action-buttons" style="display: inline-flex; gap: 0.5rem; flex-wrap: wrap;"></div>
      </div>
    </div>

    <div id="editor-error" data-testid="editor-error" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;"></div>
    <div id="editor-conflict" data-testid="editor-conflict" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;">
      <p id="editor-conflict-text" style="margin: 0 0 0.5rem;"></p>
      <button type="button" class="btn btn-outline btn-sm" id="btn-conflict-copy" data-testid="editor-conflict-copy">Copy my text</button>
      <button type="button" class="btn btn-outline btn-sm" id="btn-conflict-reload" data-testid="editor-conflict-reload">Reload story</button>
    </div>
    <div id="editor-restore" data-testid="editor-restore" role="status" class="ethics-notice-box" style="display:none; margin-bottom: 1rem;">
      <p id="editor-restore-text" style="margin: 0 0 0.5rem;"></p>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-restore-copy" data-testid="editor-restore-accept">Restore my text</button>
      <button type="button" class="btn btn-outline btn-sm" id="btn-restore-discard" data-testid="editor-restore-discard">Discard it</button>
    </div>
    <div id="schedule-panel" class="ethics-notice-box" data-testid="editor-schedule-panel" style="display:none; margin-bottom: 1rem;"></div>
    ${!editable ? `<div class="ethics-notice-box" data-testid="editor-readonly-note" style="margin-bottom:1rem;"><p style="margin:0;">You can read this story but not edit it in its current status.</p></div>` : ''}
    ${story.lossy ? `<div class="ethics-notice-box" data-testid="editor-lossy-note" style="margin-bottom:1rem;"><p style="margin:0;">This story contains elements the newsroom editor cannot represent (for example embedded video, nested lists, underline, alignment or links that open in a new tab). The body is read-only here so nothing is lost. Most imported (archive) articles can only have their body edited in the CMS admin; headline, standfirst and other fields can still be edited here.</p></div>` : ''}

    <div id="review-notes-banner" class="ethics-notice-box" style="display:none; margin-bottom: 1rem;" data-testid="editor-review-notes">
      <h4 id="review-notes-title">Editorial Review Notes</h4>
      <p id="review-notes-text"></p>
    </div>

    <div class="editor-workspace split-active" id="editor-workspace-grid">
      <div class="editor-pane" id="editor-input-pane">
        <div class="form-group">
          <label for="story-headline-input" class="form-label">Headline (Story Title)</label>
          <textarea id="story-headline-input" data-testid="editor-title" class="headline-textarea" rows="2" maxlength="240"
            placeholder="Enter working headline..." aria-required="true" ${readonlyAttr}>${escapeHtml(story.title)}</textarea>
        </div>

        <div class="form-group">
          <label for="story-standfirst-input" class="form-label">Standfirst / Deck (max 600 characters)</label>
          <textarea id="story-standfirst-input" data-testid="editor-standfirst" class="standfirst-textarea" rows="2" maxlength="600"
            placeholder="Brief editorial summary introducing the report to readers..." ${readonlyAttr}>${escapeHtml(story.standfirst)}</textarea>
        </div>

        <div class="form-grid-2">
          <div class="form-group">
            <label for="story-category-select" class="form-label">Editorial Section</label>
            <select id="story-category-select" data-testid="editor-category" class="form-select" ${editable ? '' : 'disabled'}>
              ${categories.map(c => `<option value="${escapeHtml(c.id)}" ${String(c.id) === String(story.categoryId) ? 'selected' : ''}>${escapeHtml(c.title)}</option>`).join('')}
            </select>
          </div>
          <div class="form-group" id="extra-categories-group">
            <span class="form-label" id="extra-categories-label">Also appears in (up to ${MAX_EXTRA_CATEGORIES})</span>
            <div id="story-extra-categories" data-testid="editor-extra-categories" class="chip-group" role="group" aria-labelledby="extra-categories-label"></div>
          </div>
          <div class="form-group">
            <label for="story-slug-input" class="form-label">URL Slug</label>
            <input type="text" id="story-slug-input" data-testid="editor-slug" class="form-input" maxlength="160"
              value="${escapeHtml(story.slug)}" placeholder="generated from the headline" ${readonlyAttr || slugLocked} />
            ${slugLocked ? `<div class="form-hint" data-testid="editor-slug-locked" style="font-size:0.75rem;color:var(--color-muted);margin-top:0.25rem;">Locked: this story is published, so its URL is fixed. Only the editor-in-chief or an admin can change it in the CMS admin (a redirect is created).</div>` : ''}
          </div>
        </div>

        <div class="form-group">
          <label for="story-byline-input" class="form-label">Byline shown to readers (optional)</label>
          <input type="text" id="story-byline-input" data-testid="editor-byline" class="form-input" maxlength="200"
            value="${escapeHtml(story.bylineName)}" placeholder="leave empty to use the author's name" ${readonlyAttr} />
          <div id="tip-byline-warning" class="ethics-notice-box" data-testid="editor-tip-byline-warning" role="note" style="display:none; margin-top:0.5rem;">
            <p style="margin:0;"></p>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Featured Photograph</label>
          <div class="featured-image-box" id="featured-image-container" data-testid="editor-featured-image"></div>
        </div>

        <div class="form-group">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">
            <label for="story-body-input" class="form-label" style="margin: 0;">Story Content (Markdown / Text)</label>
            <span style="font-size: 0.75rem; color: var(--color-muted);">Paragraphs, h2/h3 headings, bold, italic, quotes, lists, links</span>
          </div>
          <div class="format-bar" role="toolbar" aria-label="Text formatting toolbar">
            <button type="button" class="format-btn" data-fmt="bold" title="Bold text" ${bodyReadonly ? 'disabled' : ''}><strong>B</strong></button>
            <button type="button" class="format-btn" data-fmt="italic" title="Italic text" ${bodyReadonly ? 'disabled' : ''}><em>I</em></button>
            <button type="button" class="format-btn" data-fmt="h2" title="Section Heading" ${bodyReadonly ? 'disabled' : ''}>H2</button>
            <button type="button" class="format-btn" data-fmt="h3" title="Sub-heading" ${bodyReadonly ? 'disabled' : ''}>H3</button>
            <button type="button" class="format-btn" data-fmt="quote" title="Pullquote / Blockquote" ${bodyReadonly ? 'disabled' : ''}>Quote</button>
            <button type="button" class="format-btn" data-fmt="list" title="Bullet List" ${bodyReadonly ? 'disabled' : ''}>&bull; List</button>
            <button type="button" class="format-btn" data-fmt="link" title="Link" ${bodyReadonly ? 'disabled' : ''}>Link</button>
            <button type="button" class="format-btn" data-fmt="image" id="btn-insert-image" data-testid="editor-insert-image" title="Insert an image from the media library (or upload one) at the cursor" ${bodyReadonly ? 'disabled' : ''}>Insert image</button>
          </div>
          <div id="body-images" class="body-images" data-testid="editor-body-images" aria-label="Images in this story" style="display:none;"></div>
          <textarea id="story-body-input" data-testid="editor-body" class="story-body-textarea"
            placeholder="Write the full report here with independent sourcing and evidence..." aria-required="true" ${bodyReadonly}>${escapeHtml(story.bodyMd)}</textarea>
        </div>
      </div>

      <div class="preview-pane" id="editor-preview-pane" aria-label="Reader Preview of article">
        <span class="preview-watermark">Live Reader Preview</span>
        <div class="preview-category-tag" id="preview-category"></div>
        <h1 class="preview-headline" id="preview-headline"></h1>
        <div class="preview-standfirst" id="preview-standfirst"></div>
        <div class="preview-byline" id="preview-byline"></div>
        <div id="preview-image-box"></div>
        <div class="preview-body" id="preview-body-content"></div>
      </div>
    </div>
  `;

  renderFeaturedImage(container);
  updateStatusDisplay(container);
  updatePreview(container);
  updateWordCount(container);
  renderBodyImages(container);
  bindEditorListeners(container);
  loadTipOrigin(container);
  offerRestore(container);
}

/** Does the form hold edits that the server does not have yet? */
export function isEditorDirty(container) {
  const st = container && stateOf(container);
  if (!st || !container.querySelector('#story-headline-input')) return false;
  return Object.keys(computeChanges(st, formValues(container))).length > 0;
}

/** Keep the sessionStorage copy equal to the unsaved edits: write while dirty, remove once saved. Never stores credentials. */
function syncLocalCopy(container) {
  const st = stateOf(container);
  const storage = localStore();
  if (!st || !storage || !container.querySelector('#story-headline-input')) return;
  if (isEditorDirty(container)) {
    saveLocalCopy(storage, st.currentStory.id, formValues(container), {
      userId: api.getCurrentUser()?.id ?? null, baseUpdatedAt: st.currentStory.updatedAt
    });
  } else {
    clearLocalCopy(storage, st.currentStory.id);
  }
}

function offerRestore(container) {
  const st = stateOf(container);
  const storage = localStore();
  const box = container.querySelector('#editor-restore');
  if (!st || !storage || !box || !canEdit(st.currentStory)) return;
  const copy = readLocalCopy(storage, st.currentStory.id, { userId: api.getCurrentUser()?.id ?? null });
  if (!copy) return;
  const values = { ...copy.values, bodyMd: stripImageLabels(copy.values.bodyMd) };
  if (st.currentStory.lossy) values.bodyMd = st.baseline.bodyMd;
  if (!copyDiffers(values, st.baseline)) { clearLocalCopy(storage, st.currentStory.id); return; }
  const changedOnServer = copy.baseUpdatedAt && st.currentStory.updatedAt && copy.baseUpdatedAt !== st.currentStory.updatedAt;
  box.querySelector('#editor-restore-text').textContent =
    'Unsaved text from your last session on this story was found in this browser tab.' +
    (changedOnServer ? ' The story has changed on the server since then, so restoring it may overwrite newer edits.' : '');
  box.style.display = 'block';
  box.querySelector('#btn-restore-copy').addEventListener('click', () => {
    container.querySelector('#story-headline-input').value = copy.values.title;
    container.querySelector('#story-slug-input').value = copy.values.slug;
    st.slugTouched = true;
    container.querySelector('#story-standfirst-input').value = copy.values.standfirst;
    container.querySelector('#story-byline-input').value = copy.values.bylineName;
    if (!st.currentStory.lossy) container.querySelector('#story-body-input').value = copy.values.bodyMd;
    const sel = container.querySelector('#story-category-select');
    if (copy.values.categoryId && [...sel.options].some(o => o.value === copy.values.categoryId)) sel.value = copy.values.categoryId;
    st.extraCategoryIds = cleanExtraIds(sel.value, copy.values.extraCategoryIds);
    renderExtraCategories(container);
    box.style.display = 'none';
    triggerAutosave(container);
    updatePreview(container);
    updateWordCount(container);
    renderBodyImages(container);
  });
  box.querySelector('#btn-restore-discard').addEventListener('click', () => {
    clearLocalCopy(storage, st.currentStory.id);
    box.style.display = 'none';
  });
}

/**
 * Called by the router before it leaves the editor. Flushes a pending autosave, then, if edits still are not on the server
 * (new story, in review, failed or conflicting save), asks. Resolves false when the user chooses to stay.
 */
export async function confirmLeaveEditor(container) {
  const st = container && stateOf(container);
  if (!st) return true;
  await flushEditor(container);
  if (st.inflight) await st.inflight.catch(() => null);
  if (!api.getCurrentUser()) return true; // session ended: the local copy is the safety net
  if (!isEditorDirty(container)) return true;
  syncLocalCopy(container);
  return askConfirm({
    title: 'Leave without saving?',
    message: 'This story has changes that are not saved to the CMS. A copy is kept in this browser tab, but leaving now will not save it.',
    confirmLabel: 'Leave without saving',
    testid: 'leave-editor'
  });
}

/** The address-bar hash of the editor on screen (a story saved for the first time has moved from #editor to #editor?id=N). */
export function editorHash(container) {
  const id = stateOf(container)?.currentStory?.id;
  return id ? `editor?id=${encodeURIComponent(id)}` : 'editor';
}

function showConflict(container) {
  const st = stateOf(container);
  st.conflict = true;
  clearTimeout(st.autosaveTimer);
  st.autosavePending = false;
  const panel = container.querySelector('#editor-conflict');
  if (!panel) return;
  panel.querySelector('#editor-conflict-text').textContent = CONTENT_CONFLICT_MESSAGE;
  panel.style.display = 'block';
}

function hideConflict(container) {
  const st = stateOf(container);
  st.conflict = false;
  const panel = container.querySelector('#editor-conflict');
  if (panel) panel.style.display = 'none';
}

async function copyMyText(container) {
  const v = formValues(container);
  const text = [v.title, v.standfirst, '', v.bodyMd].join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Your text was copied to the clipboard.', 'success');
  } catch {
    const body = container.querySelector('#story-body-input');
    body?.focus();
    body?.select();
    showToast('Could not use the clipboard. The story text is selected: copy it with Ctrl+C.', 'info', 8000);
  }
}

/** Called by the router before leaving the editor: stop timers and flush a pending autosave. */
export async function flushEditor(container) {
  const st = container && stateOf(container);
  if (!st) return;
  clearTimeout(st.autosaveTimer);
  const stillSignedIn = Boolean(api.getCurrentUser());
  if (st.autosavePending && stillSignedIn && container.querySelector('#story-headline-input')) {
    st.autosavePending = false;
    await performSave(container, { auto: true });
  }
}

function canEdit(story) {
  return api.can('story.edit', ctxFor(story));
}

function ctxFor(story) {
  const user = api.getCurrentUser();
  return {
    status: story.status,
    categoryId: story.categoryId,
    isAuthor: !story.id || (user && story.authorId && String(story.authorId) === String(user.id))
  };
}

function formValues(container) {
  const st = stateOf(container);
  return {
    title: container.querySelector('#story-headline-input').value.trim(),
    slug: container.querySelector('#story-slug-input').value.trim(),
    standfirst: container.querySelector('#story-standfirst-input').value.trim(),
    bylineName: container.querySelector('#story-byline-input').value.trim(),
    bodyMd: container.querySelector('#story-body-input').value.trim(),
    categoryId: container.querySelector('#story-category-select').value,
    extraCategoryIds: cleanExtraIds(container.querySelector('#story-category-select').value, st.extraCategoryIds),
    featuredImageId: st.currentStory.featuredImage?.id ? String(st.currentStory.featuredImage.id) : ''
  };
}

/** Only fields that differ from what the server last returned. */
function computeChanges(st, vals) {
  const changes = {};
  for (const key of Object.keys(vals)) {
    // Image labels are display-only: a body that differs only in them is unchanged.
    const current = key === 'bodyMd' ? stripImageLabels(vals[key]) : vals[key];
    if (current !== st.baseline[key]) changes[key] = vals[key];
  }
  if (st.currentStory.lossy) delete changes.bodyMd; // never rewrite a body the editor cannot represent
  return changes;
}

function setInlineError(container, message) {
  const el = container.querySelector('#editor-error');
  if (!el) return;
  el.textContent = message || '';
  el.style.display = message ? 'block' : 'none';
}

/**
 * Persist pending edits. Resolves { ok: true, changed } when the server state is up to date (`changed` is false when
 * there was nothing to send, so no CMS call was made) and { ok: false } when the save failed or was cancelled
 * (an error is shown). A save requested while another one is in flight waits for it, then runs on the fresh baseline.
 */
async function performSave(container, { auto = false } = {}) {
  const st = stateOf(container);
  let carriedChange = false;
  while (st.inflight) {
    const earlier = await st.inflight.catch(() => null);
    if (earlier?.ok && earlier.changed) carriedChange = true;
  }
  const run = doSave(container, { auto });
  st.inflight = run;
  try {
    const result = await run;
    if (result.ok && carriedChange) result.changed = true;
    return result;
  } finally {
    if (st.inflight === run) st.inflight = null;
  }
}

async function doSave(container, { auto }) {
  const st = stateOf(container);
  try {
    const vals = formValues(container);
    if (!st.currentStory.id) {
      if (!vals.title) throw new ApiError('Enter a headline before saving.', { status: 400 });
      const fields = { title: vals.title, standfirst: vals.standfirst, bodyMd: vals.bodyMd, categoryId: vals.categoryId };
      if (vals.extraCategoryIds) fields.extraCategoryIds = vals.extraCategoryIds;
      if (vals.slug) fields.slug = vals.slug;
      if (vals.bylineName) fields.bylineName = vals.bylineName;
      if (vals.featuredImageId) fields.featuredImageId = vals.featuredImageId;
      const res = await api.createArticle(fields);
      st.currentStory = res.data;
      // Only move the address bar when this editor is still the one on screen.
      if (container.isConnected) history.replaceState(null, '', `#editor?id=${encodeURIComponent(st.currentStory.id)}`);
      const storage = localStore();
      if (storage) clearLocalCopy(storage, null); // the unsaved-new-story copy now lives under the real id (if still dirty)
    } else {
      const changes = computeChanges(st, vals);
      if (!Object.keys(changes).length) return { ok: true, changed: false };

      const material = 'title' in changes || 'standfirst' in changes || 'bodyMd' in changes;
      if (st.currentStory.status === 'published' && material) {
        if (auto) return { ok: false };
        const note = await askText({
          title: 'Add a correction note',
          label: 'This story is published. The CMS requires a correction note describing what changed.',
          confirmLabel: 'Save with correction',
          testid: 'correction-note'
        });
        if (!note) return { ok: false };
        changes.corrections = [
          ...st.currentStory.corrections.map(c => ({ id: c.id, note: c.note, correctedAt: c.correctedAt })),
          { note }
        ];
      }
      const res = await api.updateArticle(st.currentStory.id, changes, { expectedUpdatedAt: st.currentStory.updatedAt });
      st.currentStory = res.data;
    }
    st.baseline = snapshot(st.currentStory);
    for (const [id, media] of Object.entries(st.currentStory.bodyMedia || {})) st.mediaCache.set(id, media);
    setInlineError(container, '');
    hideConflict(container);
    updateStatusDisplay(container);
    syncLocalCopy(container);
    return { ok: true, changed: true };
  } catch (err) {
    if (container.isConnected) syncLocalCopy(container);
    if (isStaleConflict(err) && st.currentStory.id) {
      showConflict(container);
      setInlineError(container, CONTENT_CONFLICT_MESSAGE);
      return { ok: false };
    }
    const msg = auto ? err.message : showApiError(err);
    setInlineError(container, msg);
    return { ok: false };
  }
}

function bindEditorListeners(container) {
  const st = stateOf(container);
  const headlineInput = container.querySelector('#story-headline-input');
  const standfirstInput = container.querySelector('#story-standfirst-input');
  container.querySelector('#story-byline-input').addEventListener('input', () => {
    triggerAutosave(container);
    updatePreview(container);
    updateTipBylineWarning(container);
  });
  const categorySelect = container.querySelector('#story-category-select');
  const slugInput = container.querySelector('#story-slug-input');
  const bodyInput = container.querySelector('#story-body-input');
  const togglePreviewBtn = container.querySelector('#btn-toggle-preview');

  container.querySelector('#btn-back-dashboard').addEventListener('click', () => store.setCurrentView('dashboard'));

  headlineInput.addEventListener('input', () => {
    if (!st.slugTouched) slugInput.value = slugify(headlineInput.value);
    triggerAutosave(container);
    updatePreview(container);
  });
  slugInput.addEventListener('input', () => { st.slugTouched = true; triggerAutosave(container); });
  standfirstInput.addEventListener('input', () => { triggerAutosave(container); updatePreview(container); });
  categorySelect.addEventListener('change', () => {
    // The primary section is never also an additional one.
    st.extraCategoryIds = cleanExtraIds(categorySelect.value, st.extraCategoryIds);
    renderExtraCategories(container);
    triggerAutosave(container);
    updatePreview(container);
  });
  renderExtraCategories(container);
  container.querySelector('#story-extra-categories').addEventListener('change', e => {
    const box = e.target.closest('input[type="checkbox"]');
    if (!box || box.disabled) return;
    st.extraCategoryIds = toggleExtra(categorySelect.value, st.extraCategoryIds, box.value);
    renderExtraCategories(container);
    triggerAutosave(container);
    updatePreview(container);
  });
  bodyInput.addEventListener('input', () => {
    triggerAutosave(container);
    updatePreview(container);
    updateWordCount(container);
    renderBodyImages(container);
  });

  container.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('data-fmt') === 'image') return insertImage(container);
      applyFormatting(bodyInput, btn.getAttribute('data-fmt'));
      triggerAutosave(container);
      updatePreview(container);
      updateWordCount(container);
    });
  });

  togglePreviewBtn.addEventListener('click', () => {
    const workspace = container.querySelector('#editor-workspace-grid');
    const previewPane = container.querySelector('#editor-preview-pane');
    const inputPane = container.querySelector('#editor-input-pane');
    if (window.innerWidth <= 768) {
      isMobilePreviewActive = !isMobilePreviewActive;
      inputPane.style.display = isMobilePreviewActive ? 'none' : 'flex';
      previewPane.style.display = isMobilePreviewActive ? 'block' : 'none';
      togglePreviewBtn.textContent = isMobilePreviewActive ? 'Show Editor' : 'Show Preview';
    } else {
      isSplitPreviewActive = !isSplitPreviewActive;
      workspace.classList.toggle('split-active', isSplitPreviewActive);
      previewPane.style.display = isSplitPreviewActive ? 'block' : 'none';
    }
  });

  container.querySelector('#btn-conflict-copy').addEventListener('click', () => copyMyText(container));
  container.querySelector('#btn-conflict-reload').addEventListener('click', async () => {
    clearTimeout(st.autosaveTimer);
    syncLocalCopy(container);
    await renderEditor(container, st.currentStory.id);
  });

  container.querySelector('#btn-save-draft').addEventListener('click', async () => {
    clearTimeout(st.autosaveTimer);
    st.autosavePending = false;
    const result = await performSave(container); // waits for an in-flight autosave first
    if (!result.ok) return;
    markSaved(container, 'All changes saved');
    if (result.changed) showToast('Draft saved successfully', 'success');
    else showToast('No changes to save', 'info');
  });
}

function markSaved(container, text) {
  const dot = container.querySelector('#autosave-dot');
  const label = container.querySelector('#autosave-label');
  if (dot) dot.className = 'autosave-dot';
  if (label) label.textContent = text;
}

function triggerAutosave(container) {
  const st = stateOf(container);
  const dot = container.querySelector('#autosave-dot');
  const label = container.querySelector('#autosave-label');
  if (dot) dot.className = 'autosave-dot dirty';
  syncLocalCopy(container);
  const autosaveAllowed = !st.conflict && st.currentStory.id && ['draft', 'changes_requested'].includes(st.currentStory.status) && canEdit(st.currentStory);
  if (label) label.textContent = autosaveAllowed ? 'Unsaved changes...' : 'Unsaved changes (use Save Draft)';
  clearTimeout(st.autosaveTimer);
  st.autosavePending = false;
  if (!autosaveAllowed) return;
  st.autosavePending = true;
  st.autosaveTimer = setTimeout(async () => {
    st.autosavePending = false;
    if (!container.isConnected) return; // the view was replaced; the router already flushed what it needed to
    if (label) label.textContent = 'Autosaving...';
    const result = await performSave(container, { auto: true });
    if (result.ok) markSaved(container, `Autosaved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    else if (label) label.textContent = 'Autosave failed (see message above)';
  }, 1500);
}

// ---------------------------------------------------------------------------------------------------
// Reader-tip provenance
// ---------------------------------------------------------------------------------------------------

/** The CMS convert endpoint pre-fills the byline with the submitter's name; warn editors who open such a story. */
async function loadTipOrigin(container) {
  const st = stateOf(container);
  if (!st.currentStory.id || !api.can('submission.review')) return;
  try {
    const tip = await api.getSubmissionForArticle(st.currentStory.id);
    if (!container.isConnected || stateOf(container) !== st) return;
    st.fromTip = Boolean(tip);
    updateTipBylineWarning(container);
  } catch { /* the warning is advisory; failures are not worth interrupting editing */ }
}

function updateTipBylineWarning(container) {
  const st = stateOf(container);
  const box = container.querySelector('#tip-byline-warning');
  const input = container.querySelector('#story-byline-input');
  if (!st || !box || !input) return;
  const show = st.fromTip && Boolean(input.value.trim());
  box.querySelector('p').textContent = show ? TIP_BYLINE_WARNING : '';
  box.style.display = show ? 'block' : 'none';
}

// ---------------------------------------------------------------------------------------------------
// Featured image
// ---------------------------------------------------------------------------------------------------

function renderFeaturedImage(container) {
  const st = stateOf(container);
  const box = container.querySelector('#featured-image-container');
  const img = st.currentStory.featuredImage;
  const editable = canEdit(st.currentStory);
  if (img) {
    box.innerHTML = `
      ${img.thumbUrl || img.url ? `<img src="${escapeHtml(img.thumbUrl || img.url)}" alt="${escapeHtml(img.alt)}" class="featured-image-thumb" data-testid="editor-featured-image-img">` : ''}
      <div class="featured-image-meta">
        <div style="font-weight: 600; font-size: 0.875rem;" data-testid="editor-featured-image-alt">${escapeHtml(img.alt || 'Selected image')}</div>
        <div style="font-size: 0.75rem; color: var(--color-muted);">
          ${escapeHtml(img.caption || 'No caption')} &middot; Credit: ${escapeHtml(img.credit || 'none recorded')}
        </div>
        ${editable ? `
        <div style="display: flex; gap: 0.5rem; margin-top: 0.35rem;">
          <button type="button" class="btn btn-outline btn-sm" id="btn-choose-media" data-testid="editor-choose-image">Change Image</button>
          <button type="button" class="btn btn-outline btn-sm" id="btn-remove-media" data-testid="editor-remove-image" style="color: #DC2626;">Remove</button>
        </div>` : ''}
      </div>`;
  } else {
    box.innerHTML = `
      <div style="text-align: center; width: 100%; padding: 0.5rem;">
        <p style="font-size: 0.8125rem; color: var(--color-muted); margin-bottom: 0.5rem;">
          No featured photograph selected.
        </p>
        ${editable ? `<button type="button" class="btn btn-secondary btn-sm" id="btn-choose-media" data-testid="editor-choose-image">Choose or upload a photograph</button>` : ''}
      </div>`;
  }

  box.querySelector('#btn-choose-media')?.addEventListener('click', () => {
    openMediaPicker({
      onSelect: media => {
        st.currentStory.featuredImage = media;
        renderFeaturedImage(container);
        updatePreview(container);
        triggerAutosave(container);
      }
    });
  });
  box.querySelector('#btn-remove-media')?.addEventListener('click', () => {
    st.currentStory.featuredImage = null;
    renderFeaturedImage(container);
    updatePreview(container);
    triggerAutosave(container);
  });
}

// ---------------------------------------------------------------------------------------------------
// Workflow (each button is one explicit server transition)
// ---------------------------------------------------------------------------------------------------

function renderWorkflowButtons(story) {
  const ctx = ctxFor(story);
  let html = '';
  if (api.can('story.submit_review', ctx)) {
    html += `<button type="button" class="btn btn-accent btn-sm" id="btn-submit-review" data-testid="editor-submit-review">Submit for Review</button>`;
  }
  if (story.id && api.can('story.request_changes', ctx)) {
    html += `<button type="button" class="btn btn-danger btn-sm" id="btn-request-changes" data-testid="editor-request-changes">Request Changes</button>`;
  }
  if (story.id && api.can('story.approve', ctx)) {
    html += `<button type="button" class="btn btn-success btn-sm" id="btn-approve-story" data-testid="editor-approve">Approve Story</button>`;
  }
  const archiveBlock = publishBlockReason(story, api.getCurrentUser());
  if (api.can('story.publish', ctx)) {
    html += `<button type="button" class="btn btn-primary btn-sm" id="btn-publish-story" data-testid="editor-publish" style="background-color: var(--color-forest-dark);"${archiveBlock ? ' disabled aria-describedby="archive-block-note"' : ''}>Publish Story</button>`;
  }
  if (archiveBlock) {
    html += `<p id="archive-block-note" class="archive-block-note" data-testid="editor-archive-blocked" role="note">${escapeHtml(archiveBlock)} <a href="#archive?id=${encodeURIComponent(story.id)}">Go to Archive review</a></p>`;
  }
  if (story.id && api.can('story.archive', ctx)) {
    html += `<button type="button" class="btn btn-outline btn-sm" id="btn-archive-story" data-testid="editor-archive">Archive</button>`;
  }
  return html;
}

async function runTransition(container, status, { reviewNotes, success, savePending = true }) {
  const st = stateOf(container);
  clearTimeout(st.autosaveTimer);
  st.autosavePending = false;
  try {
    if (savePending) {
      const saved = await performSave(container);
      if (!saved.ok) return;
    }
    // Approve what you saw: the version on screen (after any pending edit was saved above) is the one being acted on.
    const res = await api.transitionArticle(st.currentStory.id, status, {
      ...(reviewNotes !== undefined ? { reviewNotes } : {}),
      expectedUpdatedAt: st.currentStory.updatedAt
    });
    st.currentStory = res.data;
    st.baseline = snapshot(st.currentStory);
    setInlineError(container, '');
    updateStatusDisplay(container);
    showToast(success, 'success');
  } catch (err) {
    if (isStaleConflict(err)) {
      await reloadAfterConflict(container, st.currentStory.id, err.message || STALE_MESSAGE);
      return;
    }
    setInlineError(container, showApiError(err));
  }
}

/** The story changed on the server after it was opened (409): reload it so the editor reviews the current version. */
async function reloadAfterConflict(container, storyId, message) {
  await renderEditor(container, storyId);
  if (!container.isConnected || !container.querySelector('#story-headline-input')) return;
  setInlineError(container, message);
  showToast(message, 'info');
}

function bindWorkflowActions(container) {
  const wrap = container.querySelector('#workflow-action-buttons');
  if (!wrap) return;

  wrap.querySelector('#btn-submit-review')?.addEventListener('click', () =>
    runTransition(container, 'in_review', { success: 'Story submitted for editorial review! Moved to Review Queue.' }));

  wrap.querySelector('#btn-request-changes')?.addEventListener('click', async () => {
    const notes = await askText({
      title: 'Request Editorial Changes',
      label: 'Feedback and revision guidance for the reporter:',
      confirmLabel: 'Send Revision Request',
      placeholder: 'Explain what needs corroboration, sourcing or style changes...',
      testid: 'request-changes'
    });
    if (!notes) return;
    await runTransition(container, 'changes_requested', { reviewNotes: notes, success: 'Changes requested. Story flagged for revisions.' });
  });

  wrap.querySelector('#btn-approve-story')?.addEventListener('click', () =>
    runTransition(container, 'approved', { success: 'Story approved for publication!' }));

  wrap.querySelector('#btn-publish-story')?.addEventListener('click', async () => {
    const ok = await askConfirm({
      title: 'Publish story',
      message: 'Publish this story to the Church Times Nigeria live web feed now?',
      confirmLabel: 'Publish now',
      testid: 'publish'
    });
    if (!ok) return;
    await runTransition(container, 'published', { success: 'Story is now live and published!' });
  });

  wrap.querySelector('#btn-archive-story')?.addEventListener('click', async () => {
    const ok = await askConfirm({ title: 'Archive story', message: 'Archive this story and remove it from the public site?', confirmLabel: 'Archive', testid: 'archive' });
    if (!ok) return;
    await runTransition(container, 'archived', { success: 'Story archived.', savePending: false });
  });
}

/**
 * Scheduling control: shown only to roles that may schedule (api.can('story.schedule')) for a saved story. The time is
 * sent to the CMS as is; the CMS decides whether it is acceptable and its message is shown in the inline alert.
 */
function updateSchedulePanel(container) {
  const st = stateOf(container);
  const panel = container.querySelector('#schedule-panel');
  if (!st || !panel) return;
  const story = st.currentStory;
  const show = Boolean(story.id) && api.can('story.schedule', ctxFor(story));
  if (!show) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }
  // Keep what the editor typed across re-renders (a failed save or a server error must not wipe the field).
  const typed = panel.querySelector('#schedule-at-input')?.value;
  const fourEyes = fourEyesReason(story.provenance, api.getCurrentUser());
  const scheduled = story.status === 'scheduled' && story.scheduledFor;
  const value = typed || (scheduled ? isoToLocalInput(story.scheduledFor) : defaultScheduleValue());
  panel.style.display = 'block';
  panel.innerHTML = `
    <h4 style="margin-top:0;">Schedule publication</h4>
    ${fourEyes ? `<p class="archive-block-note" data-testid="editor-schedule-four-eyes" role="note" style="margin:0 0 0.5rem;">${escapeHtml(fourEyes)}</p>` : ''}
    ${scheduled ? `<p style="margin:0 0 0.5rem;" data-testid="editor-scheduled-for" data-iso="${escapeHtml(story.scheduledFor)}">Scheduled to publish automatically on <strong>${escapeHtml(formatScheduled(story.scheduledFor))}</strong>.</p>` : ''}
    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
      <label for="schedule-at-input" class="form-label" style="margin:0;">Publish at (your local time)</label>
      <input type="datetime-local" step="1" id="schedule-at-input" data-testid="editor-schedule-at" class="form-input" style="width:auto;" value="${escapeHtml(value)}" />
      <button type="button" class="btn btn-primary btn-sm" id="btn-schedule-story" data-testid="editor-schedule"${fourEyes ? ' disabled' : ''}>${scheduled ? 'Reschedule' : 'Schedule'}</button>
    </div>`;
  panel.querySelector('#btn-schedule-story').addEventListener('click', () => runSchedule(container));
}

async function runSchedule(container) {
  const st = stateOf(container);
  const input = container.querySelector('#schedule-at-input');
  const parsed = parseScheduleInput(input?.value);
  if (!parsed.ok) {
    setInlineError(container, parsed.message);
    return;
  }
  if (st.scheduling) return; // a double click must not send a second PATCH
  st.scheduling = true;
  const btn = container.querySelector('#btn-schedule-story');
  if (btn) btn.disabled = true;
  clearTimeout(st.autosaveTimer);
  st.autosavePending = false;
  try {
    const saved = await performSave(container);
    if (!saved.ok) return;
    const res = await api.scheduleArticle(st.currentStory.id, parsed.iso);
    st.currentStory = res.data;
    st.baseline = snapshot(st.currentStory);
    setInlineError(container, '');
    const panel = container.querySelector('#schedule-panel');
    const field = panel?.querySelector('#schedule-at-input');
    if (field) field.value = ''; // show the saved value, not the typed one
    updateStatusDisplay(container);
    showToast(`Story scheduled for ${formatScheduled(st.currentStory.scheduledFor)}.`, 'success');
  } catch (err) {
    setInlineError(container, showApiError(err));
  } finally {
    st.scheduling = false;
    const current = container.querySelector('#btn-schedule-story');
    if (current) current.disabled = false;
  }
}

function updateStatusDisplay(container) {
  const st = stateOf(container);
  const badge = container.querySelector('#story-status-badge-container');
  if (badge) {
    badge.innerHTML = statusBadge(st.currentStory.status);
    badge.setAttribute('data-status', st.currentStory.status);
  }

  const banner = container.querySelector('#review-notes-banner');
  const text = container.querySelector('#review-notes-text');
  if (banner && text) {
    text.textContent = st.currentStory.reviewNotes || '';
    banner.style.display = st.currentStory.reviewNotes ? 'block' : 'none';
  }

  const wrap = container.querySelector('#workflow-action-buttons');
  if (wrap) {
    wrap.innerHTML = renderWorkflowButtons(st.currentStory);
    bindWorkflowActions(container);
  }
  updateSchedulePanel(container);
}

// ---------------------------------------------------------------------------------------------------
// Preview, word count, formatting
// ---------------------------------------------------------------------------------------------------

/** The "also appears in" chips: one checkbox chip per section except the primary; unchecked ones are disabled at the cap. */
function renderExtraCategories(container) {
  const st = stateOf(container);
  const host = container.querySelector('#story-extra-categories');
  if (!host) return;
  const primary = container.querySelector('#story-category-select').value;
  const chosen = parseIds(cleanExtraIds(primary, st.extraCategoryIds));
  st.extraCategoryIds = chosen.join(',');
  const editable = canEdit(st.currentStory);
  const full = chosen.length >= MAX_EXTRA_CATEGORIES;
  host.innerHTML = st.categories
    .filter(c => String(c.id) !== String(primary))
    .map(c => {
      const on = chosen.includes(String(c.id));
      const off = !editable || (full && !on);
      return `<label class="chip ${on ? 'chip-on' : ''}"><input type="checkbox" value="${escapeHtml(c.id)}" data-testid="editor-extra-category" ${on ? 'checked' : ''} ${off ? 'disabled' : ''} />${escapeHtml(c.title)}</label>`;
    })
    .join('');
}

function updatePreview(container) {
  const st = stateOf(container);
  const headline = container.querySelector('#story-headline-input').value;
  const standfirst = container.querySelector('#story-standfirst-input').value;
  const categoryId = container.querySelector('#story-category-select').value;
  const body = container.querySelector('#story-body-input').value;
  const catTitle = st.categories.find(c => String(c.id) === String(categoryId))?.title || '';

  const extraTitles = parseIds(cleanExtraIds(categoryId, st.extraCategoryIds))
    .map(id => st.categories.find(c => String(c.id) === id)?.title).filter(Boolean);
  container.querySelector('#preview-category').textContent = [catTitle, ...extraTitles].filter(Boolean).join(' · ');
  container.querySelector('#preview-headline').textContent = headline || 'Untitled Headline';
  container.querySelector('#preview-standfirst').textContent = standfirst || 'Lead summary will appear here.';
  container.querySelector('#preview-byline').innerHTML =
    `By <strong>${escapeHtml(container.querySelector('#story-byline-input').value.trim() || st.currentStory.authorName || api.getCurrentUser()?.name || '')}</strong> &middot; <span>${escapeHtml(formatDate(st.currentStory.publishedAt || st.currentStory.updatedAt))}</span>`;
  container.querySelector('#preview-body-content').innerHTML =
    body.trim() ? markdownToHtml(body, { media: id => st.mediaCache.get(id) }) : '<p>Story body will render here as you type...</p>';

  const img = st.currentStory.featuredImage;
  container.querySelector('#preview-image-box').innerHTML = img && (img.url || img.thumbUrl) ? `
    <img src="${escapeHtml(img.url || img.thumbUrl)}" alt="${escapeHtml(img.alt)}" class="preview-hero-img">
    <div class="preview-img-caption">${escapeHtml(img.caption || '')}${img.credit ? ` &middot; Credit: ${escapeHtml(img.credit)}` : ''}</div>` : '';
}

// ---------------------------------------------------------------------------------------------------
// Images inside the body
// ---------------------------------------------------------------------------------------------------

function insertImage(container) {
  const st = stateOf(container);
  const bodyInput = container.querySelector('#story-body-input');
  if (!st || !bodyInput || bodyInput.readOnly) return;
  // The picker is a dialog: remember where the cursor was before focus leaves the textarea.
  const start = bodyInput.selectionStart;
  const end = bodyInput.selectionEnd;
  openMediaPicker({
    title: 'Insert Image into Story',
    validate: mediaImageProblem,
    onSelect: media => {
      if (!container.isConnected || stateOf(container) !== st) return;
      st.mediaCache.set(String(media.id), media);
      const edited = insertBlockLine(bodyInput.value, start, end, imageToken(media.id, media.alt));
      bodyInput.value = edited.value;
      bodyInput.focus();
      bodyInput.selectionStart = bodyInput.selectionEnd = edited.caret;
      triggerAutosave(container);
      updatePreview(container);
      updateWordCount(container);
      renderBodyImages(container);
    }
  });
}

/** Small list under the toolbar: which images the body contains (thumbnail, alt text, id), with a remove button. */
function renderBodyImages(container) {
  const st = stateOf(container);
  const box = container.querySelector('#body-images');
  const bodyInput = container.querySelector('#story-body-input');
  if (!st || !box || !bodyInput) return;
  const images = listImages(bodyInput.value);
  box.style.display = images.length ? 'flex' : 'none';
  box.innerHTML = images.map((img, i) => {
    if (img.missing) {
      return `
      <div class="body-image-item body-image-item-missing" data-testid="editor-body-image-missing" role="alert">
        <span class="body-image-thumb body-image-thumb-missing" aria-hidden="true"></span>
        <span class="body-image-label"><strong>Missing image</strong><br>This picture no longer exists in the media library. The CMS will not save the story until you remove it.</span>
        ${bodyInput.readOnly ? '' : `<button type="button" class="btn btn-outline btn-sm" data-remove-image="${i}" data-testid="editor-remove-body-image" aria-label="Remove the missing image from the story">Remove</button>`}
      </div>`;
    }
    const media = st.mediaCache.get(img.id);
    const src = media && (media.thumbUrl || media.url);
    const alt = (media && media.alt) || img.alt;
    return `
      <div class="body-image-item" data-testid="editor-body-image" data-media-id="${escapeHtml(img.id)}">
        ${src ? `<img src="${escapeHtml(src)}" alt="" class="body-image-thumb">` : '<span class="body-image-thumb body-image-thumb-missing" aria-hidden="true"></span>'}
        <span class="body-image-label"><strong>Image #${escapeHtml(img.id)}</strong><br>${escapeHtml(alt || 'No alt text recorded')}</span>
        ${bodyInput.readOnly ? '' : `<button type="button" class="btn btn-outline btn-sm" data-remove-image="${i}" data-testid="editor-remove-body-image" aria-label="Remove image ${escapeHtml(img.id)} from the story">Remove</button>`}
      </div>`;
  }).join('');
  box.querySelectorAll('[data-remove-image]').forEach(btn => {
    btn.addEventListener('click', () => {
      bodyInput.value = removeImageLine(bodyInput.value, Number(btn.getAttribute('data-remove-image')));
      triggerAutosave(container);
      updatePreview(container);
      updateWordCount(container);
      renderBodyImages(container);
    });
  });
}

function updateWordCount(container) {
  const words = countWords(container.querySelector('#story-body-input').value);
  const badge = container.querySelector('#word-count-badge');
  if (badge) badge.textContent = `${words} words · ${Math.ceil(words / 200)} min read`;
}

function applyFormatting(textarea, format) {
  if (textarea.readOnly) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  const selected = val.substring(start, end);

  let replacement = '';
  switch (format) {
    case 'bold': replacement = `**${selected || 'bold text'}**`; break;
    case 'italic': replacement = `*${selected || 'italic text'}*`; break;
    case 'h2': replacement = `\n\n## ${selected || 'Section Heading'}\n\n`; break;
    case 'h3': replacement = `\n\n### ${selected || 'Sub-heading'}\n\n`; break;
    case 'quote': replacement = `\n\n> ${selected || 'Important source quote'}\n\n`; break;
    case 'list': replacement = `\n- ${selected || 'First item'}\n- Second item\n`; break;
    case 'link': replacement = `[${selected || 'link text'}](https://)`; break;
    default: return;
  }

  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = start + replacement.length;
}
