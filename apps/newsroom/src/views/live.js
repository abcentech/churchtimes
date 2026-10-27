/**
 * Live Coverage Console (staff)
 *
 * Real CMS workflow (docs/api-contracts.md §6.2):
 *   event: POST /api/live-events (draft) -> PATCH status live -> ended
 *   update: POST /api/live-updates { event, body } (server decides pending/approved from the caller's role)
 *   review: PATCH /api/live-updates/:id { status: approved | rejected }
 * The public timeline is served by the CMS polling endpoint; this console lists staff-visible updates.
 */

import { api } from '../api/index.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { openModal } from '../components/modal.js';
import { showApiError } from '../components/notify.js';
import { escapeHtml, formatTimeAgo } from '../util.js';
import { openMediaPicker, mediaImageProblem } from '../components/media-picker.js';
import { cmsAssetUrl } from '../config.js';
import { livePhotoHtml } from '../live-photo.js';
import { isStaleConflict } from '../stale-guard.js';
import { sortPublishedNewestFirst } from '../live-order.js';
import { liveStaleMessage } from '../http-guard.js';

const POLL_MS = 20000;
let pollingTimer = null;
let currentEventId = null;
let renderSeq = 0;
let lastLiveOkAt = null;

/** Show (or clear) the "feed may be out of date" notice above the timeline. Polling errors are otherwise silent. */
function setLiveStale(container, feedEl, failing) {
  let el = container.querySelector('#live-stale-indicator');
  const text = liveStaleMessage(lastLiveOkAt, failing);
  if (!text) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'live-stale-indicator';
    el.className = 'live-stale-indicator';
    el.setAttribute('role', 'status');
    el.setAttribute('data-testid', 'live-stale-indicator');
    feedEl.parentNode.insertBefore(el, feedEl);
  }
  el.textContent = text;
}

function eventStatusLabel(status) {
  return { draft: 'DRAFT', live: 'LIVE NOW', ended: 'ENDED' }[status] || String(status).toUpperCase();
}

export async function renderLive(container) {
  clearInterval(pollingTimer);
  // Each call owns a sequence number; after every await a superseded or detached render must not touch module state or the DOM.
  const seq = ++renderSeq;
  const isStale = () => seq !== renderSeq || !container.isConnected;

  let events;
  let categories;
  try {
    [events, categories] = await Promise.all([api.getLiveEvents().then(r => r.data), api.getCategories()]);
  } catch (err) {
    if (isStale()) return;
    container.innerHTML = `
      <div class="card" style="padding:2rem; text-align:center;" data-testid="live-load-error" role="alert">
        <h2 style="margin-bottom:0.5rem;">Live coverage could not be loaded</h2>
        <p id="live-load-error-text" style="color: var(--color-muted);"></p>
      </div>`;
    container.querySelector('#live-load-error-text').textContent = showApiError(err);
    return;
  }

  if (isStale()) return;

  const canManage = api.can('live.manage');
  let activeEvent = events.find(e => e.id === currentEventId) || events[0] || null;
  currentEventId = activeEvent ? activeEvent.id : null;

  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Live Coverage &amp; Real-Time Updates</h1>
          <p class="view-subtitle">Coverage for ecclesiastical conferences, national summits and breaking developments.</p>
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; max-width: 100%;">
          ${events.length ? `
          <select id="live-event-select" data-testid="live-event-select" class="select-input" style="flex: 1 1 12rem; min-width: 0;" aria-label="Select live event">
            ${events.map(ev => `<option value="${escapeHtml(ev.id)}" ${activeEvent && ev.id === activeEvent.id ? 'selected' : ''}>${escapeHtml(eventStatusLabel(ev.status))}: ${escapeHtml(ev.title)}</option>`).join('')}
          </select>` : ''}
          ${canManage ? '<button type="button" class="btn btn-outline btn-sm" id="btn-create-event" data-testid="live-new-event">+ New Event</button>' : ''}
        </div>
      </div>
    </div>

    <div id="live-error" data-testid="live-error" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;"></div>

    ${!activeEvent ? `
      <div class="card" style="text-align:center; padding: 2.5rem;" data-testid="live-empty">
        <h3 style="font-family: var(--font-serif); color: var(--color-forest);">No live events yet</h3>
        <p style="color: var(--color-muted);">${canManage ? 'Create an event to begin coverage.' : 'An editor can create a live event.'}</p>
      </div>` : `
    <div class="card" style="margin-bottom: 1.5rem; background-color: var(--color-forest); color: var(--color-parchment);" data-testid="live-event-banner" data-event-status="${escapeHtml(activeEvent.status)}">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
        <div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem;">
            <span class="badge ${activeEvent.status === 'live' ? 'badge-live' : 'badge-draft'}" data-testid="live-event-status">${escapeHtml(eventStatusLabel(activeEvent.status))}</span>
          </div>
          <h2 style="font-family: var(--font-serif); font-size: 1.35rem; color: #FFFFFF;">${escapeHtml(activeEvent.title)}</h2>
          ${activeEvent.summary ? `<p style="font-size: 0.875rem; color: var(--color-sage-soft); max-width: 650px; margin-top: 0.25rem;">${escapeHtml(activeEvent.summary)}</p>` : ''}
        </div>
        <div style="display: flex; align-items: center; gap: 0.75rem;">
          ${canManage && activeEvent.status === 'draft' ? '<button type="button" class="btn btn-outline btn-sm" id="btn-event-go-live" data-testid="live-go-live" style="color: var(--color-parchment); border-color: var(--color-sage);">Go Live</button>' : ''}
          ${canManage && activeEvent.status === 'live' ? '<button type="button" class="btn btn-outline btn-sm" id="btn-event-end" data-testid="live-end" style="color: var(--color-parchment); border-color: var(--color-sage);">End Coverage</button>' : ''}
        </div>
      </div>
    </div>

    <div class="live-console-grid">
      <div class="card" style="display: flex; flex-direction: column; gap: 1rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-rule); padding-bottom: 0.5rem;">
          <h3 style="font-family: var(--font-serif); font-size: 1.15rem; color: var(--color-forest);">Compose Live Update</h3>
          <span style="font-size: 0.75rem; color: var(--color-muted);">Posting as: <strong>${escapeHtml(api.getCurrentUser()?.name)}</strong></span>
        </div>
        <form id="live-update-form" novalidate>
          <div class="form-group" style="margin-bottom: 1rem;">
            <label for="upd-body-input" class="form-label">Update Content <span style="color: #DC2626;">*</span> (plain text, max 5000 characters)</label>
            <textarea id="upd-body-input" data-testid="live-update-body" class="form-textarea" rows="4" maxlength="5000"
              placeholder="Report specific facts, quotes, or proceedings..."></textarea>
          </div>
          <div id="upd-photo-box" class="live-photo-draft" data-testid="live-update-photo-box"></div>
          <button type="submit" class="btn btn-primary" id="btn-post-update" data-testid="live-update-post" style="width: 100%;">
            ${api.can('live.approve', { categoryId: activeEvent.categoryId }) ? 'Publish Live Update' : 'Submit Update for Editorial Review'}
          </button>
        </form>

        <div id="pending-live-updates-container" style="margin-top: 1rem; border-top: 1px solid var(--color-rule); padding-top: 1rem;">
          <h4 style="font-size: 0.875rem; font-weight: 700; color: var(--color-forest); margin-bottom: 0.5rem;">Updates Awaiting Approval</h4>
          <div id="pending-updates-list" data-testid="live-pending-list">Loading pending updates...</div>
        </div>
      </div>

      <div class="live-stream-box">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-rule); padding-bottom: 0.5rem;">
          <h3 style="font-family: var(--font-serif); font-size: 1.15rem; color: var(--color-forest);">Published Timeline</h3>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 0.75rem; color: var(--color-muted);" id="polling-status-label">Refreshes every ${POLL_MS / 1000}s</span>
            <button type="button" class="btn btn-outline btn-sm" id="btn-refresh-timeline" data-testid="live-refresh" title="Refresh timeline now">Refresh</button>
          </div>
        </div>
        <div class="live-timeline-feed" id="live-timeline-feed" data-testid="live-timeline" role="feed" aria-label="Live event timeline updates">
          <div style="text-align: center; padding: 2rem;">Loading live timeline...</div>
        </div>
      </div>
    </div>`}
  `;

  const errorEl = container.querySelector('#live-error');
  const setError = msg => { errorEl.textContent = msg || ''; errorEl.style.display = msg ? 'block' : 'none'; };

  container.querySelector('#live-event-select')?.addEventListener('change', e => {
    if (e.target.value === currentEventId) return;
    currentEventId = e.target.value;
    renderLive(container);
  });
  container.querySelector('#btn-create-event')?.addEventListener('click', () => openCreateEventModal(container, categories));

  if (!activeEvent) return;

  const setStatus = status => async () => {
    try {
      await api.setLiveEventStatus(activeEvent.id, status);
      showToast(`Event is now ${status.toUpperCase()}`, 'success');
      renderLive(container);
    } catch (err) {
      setError(showApiError(err));
    }
  };
  container.querySelector('#btn-event-go-live')?.addEventListener('click', setStatus('live'));
  container.querySelector('#btn-event-end')?.addEventListener('click', setStatus('ended'));

  // One optional photo for the update being composed (chosen through the shared media picker).
  let photo = null;
  const photoBox = container.querySelector('#upd-photo-box');
  const renderPhotoBox = () => {
    if (!photoBox) return;
    if (!photo) {
      photoBox.innerHTML = '<button type="button" class="btn btn-outline btn-sm" id="btn-add-photo" data-testid="live-add-photo">Add photo</button>';
      photoBox.querySelector('#btn-add-photo').addEventListener('click', () => openMediaPicker({
        title: 'Add Photo to Live Update',
        validate: mediaImageProblem,
        onSelect: media => { photo = media; renderPhotoBox(); }
      }));
      return;
    }
    photoBox.innerHTML = `${livePhotoHtml(photo, cmsAssetUrl, { testid: 'live-update-photo-draft' }) || '<span class="body-image-thumb body-image-thumb-missing" aria-hidden="true"></span>'}
      <span style="flex:1; min-width:0; overflow-wrap:anywhere;" data-testid="live-update-photo-alt">${escapeHtml(photo.alt)}</span>
      <button type="button" class="btn btn-outline btn-sm" id="btn-remove-photo" data-testid="live-remove-photo" style="color:#DC2626;">Remove photo</button>`;
    photoBox.querySelector('#btn-remove-photo').addEventListener('click', () => { photo = null; renderPhotoBox(); });
  };
  renderPhotoBox();

  container.querySelector('#live-update-form').addEventListener('submit', async e => {
    e.preventDefault();
    const bodyEl = container.querySelector('#upd-body-input');
    const body = bodyEl.value.trim();
    if (!body) { setError('Please enter update content.'); return; }
    const submit = container.querySelector('#btn-post-update');
    submit.disabled = true;
    try {
      const res = await api.postLiveUpdate({
        eventId: activeEvent.id,
        body,
        publishNow: api.can('live.approve', { categoryId: activeEvent.categoryId }),
        imageId: photo ? photo.id : null
      });
      bodyEl.value = '';
      photo = null;
      renderPhotoBox();
      setError('');
      showToast(res.data.status === 'approved'
        ? 'Live update published to public timeline!'
        : 'Update submitted for editor approval.', 'success');
      await refreshLiveStream(container, activeEvent, setError);
    } catch (err) {
      setError(showApiError(err));
    } finally {
      submit.disabled = false;
    }
  });

  container.querySelector('#btn-refresh-timeline').addEventListener('click', async () => {
    if (await refreshLiveStream(container, activeEvent, setError)) showToast('Timeline refreshed', 'info');
  });

  await refreshLiveStream(container, activeEvent, setError);
  if (isStale()) return;
  pollingTimer = setInterval(async () => {
    if (store.getCurrentView() === 'live' && container.isConnected && seq === renderSeq) {
      await refreshLiveStream(container, activeEvent, () => {});
    } else {
      clearInterval(pollingTimer);
    }
  }, POLL_MS);
}

export function stopLivePolling() {
  clearInterval(pollingTimer);
}

async function refreshLiveStream(container, event, setError) {
  const feedEl = container.querySelector('#live-timeline-feed');
  const pendingEl = container.querySelector('#pending-updates-list');
  if (!feedEl) return false;

  let updates;
  try {
    updates = (await api.getLiveUpdates(event.id)).data;
  } catch (err) {
    if (!container.isConnected) return false;
    setLiveStale(container, feedEl, true);
    setError(showApiError(err, 'Could not load updates: '));
    return false;
  }
  if (!container.isConnected) return false;
  lastLiveOkAt = Date.now();
  setLiveStale(container, feedEl, false);
  setError('');

  const approved = sortPublishedNewestFirst(updates.filter(u => u.status === 'approved'));
  const pending = updates.filter(u => u.status === 'pending');
  const canApprove = api.can('live.approve', { categoryId: event.categoryId });

  feedEl.innerHTML = approved.length === 0
    ? '<div style="text-align: center; padding: 2rem; color: var(--color-muted);">No updates published yet.</div>'
    : approved.map(upd => `
      <article class="live-update-card" data-testid="live-update-card" data-update-id="${escapeHtml(upd.id)}">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
          <span class="live-time-badge">${escapeHtml(new Date(upd.occurredAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</span>
        </div>
        <p style="font-size: 0.9375rem; color: var(--color-ink); line-height: 1.5; white-space: pre-wrap;">${escapeHtml(upd.body)}</p>
        ${livePhotoHtml(upd.image, cmsAssetUrl)}
        ${upd.authorName ? `<span style="font-size: 0.75rem; color: var(--color-muted);">By ${escapeHtml(upd.authorName)}</span>` : ''}
      </article>`).join('');

  if (pendingEl) {
    pendingEl.innerHTML = pending.length === 0
      ? '<span style="font-size: 0.75rem; color: var(--color-muted);">No updates waiting for approval.</span>'
      : pending.map(u => `
        <div style="background-color: #FEF3C7; border: 1px solid #FCD34D; border-radius: var(--radius-sm); padding: 0.5rem; margin-bottom: 0.5rem; font-size: 0.8125rem;" data-testid="live-pending-card" data-update-id="${escapeHtml(u.id)}">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
            <strong>${escapeHtml(formatTimeAgo(u.occurredAt))}${u.authorName ? ` &middot; ${escapeHtml(u.authorName)}` : ''}</strong>
            ${canApprove ? `
            <span style="display:inline-flex; gap:0.35rem;">
              <button type="button" class="btn btn-success btn-sm" data-testid="live-approve" data-approve-upd-id="${escapeHtml(u.id)}" data-updated-at="${escapeHtml(u.updatedAt || '')}">Approve &amp; Push Live</button>
              <button type="button" class="btn btn-outline btn-sm" data-testid="live-reject" data-reject-upd-id="${escapeHtml(u.id)}" data-updated-at="${escapeHtml(u.updatedAt || '')}" style="color:#B91C1C;">Reject</button>
            </span>` : '<span class="badge badge-pending">Awaiting editor</span>'}
          </div>
          <div style="white-space: pre-wrap;">${escapeHtml(u.body)}</div>
          ${livePhotoHtml(u.image, cmsAssetUrl)}
        </div>`).join('');

    const review = (attr, status, ok) => pendingEl.querySelectorAll(`[${attr}]`).forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          // Approve what you saw: the version shown on this card (its updatedAt) is the one being approved / rejected.
          await api.setLiveUpdateStatus(btn.getAttribute(attr), status, { expectedUpdatedAt: btn.getAttribute('data-updated-at') || undefined });
          showToast(ok, status === 'approved' ? 'success' : 'info');
          await refreshLiveStream(container, event, setError);
        } catch (err) {
          const message = showApiError(err);
          // 409: the update changed after it was shown. Reload the timeline so the card shows the current text, keep the message.
          if (isStaleConflict(err)) await refreshLiveStream(container, event, setError);
          setError(message);
        }
      });
    });
    review('data-approve-upd-id', 'approved', 'Update approved and broadcast to public stream!');
    review('data-reject-upd-id', 'rejected', 'Update rejected.');
  }
  return true;
}

function openCreateEventModal(container, categories) {
  openModal({
    title: 'Create New Live Event',
    contentHtml: `
      <form id="create-event-form" novalidate>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="new-ev-title" class="form-label">Event Title <span style="color: #DC2626;">*</span></label>
          <input type="text" id="new-ev-title" data-testid="live-event-title" class="form-input" maxlength="240" />
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="new-ev-category" class="form-label">Section</label>
          <select id="new-ev-category" data-testid="live-event-category" class="form-select">
            ${categories.map(c => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="new-ev-desc" class="form-label">Summary</label>
          <textarea id="new-ev-desc" data-testid="live-event-summary" class="form-textarea" rows="3" maxlength="1000"></textarea>
        </div>
        <div id="create-event-error" role="alert" data-testid="live-event-error" style="display:none; color:#B91C1C; font-size:0.8125rem; margin-bottom:0.5rem;"></div>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-outline" id="cancel-create-ev">Cancel</button>
          <button type="submit" class="btn btn-primary" data-testid="live-event-create">Create event (draft)</button>
        </div>
      </form>`,
    onRender: (body, close) => {
      body.querySelector('#cancel-create-ev').addEventListener('click', close);
      body.querySelector('#create-event-form').addEventListener('submit', async e => {
        e.preventDefault();
        const errEl = body.querySelector('#create-event-error');
        const title = body.querySelector('#new-ev-title').value.trim();
        if (!title) { errEl.textContent = 'Event title is required.'; errEl.style.display = 'block'; return; }
        try {
          const res = await api.createLiveEvent({
            title,
            categoryId: body.querySelector('#new-ev-category').value,
            summary: body.querySelector('#new-ev-desc').value.trim()
          });
          currentEventId = res.data.id;
          close();
          showToast('Live event created as a draft. Use Go Live when ready.', 'success');
          renderLive(container);
        } catch (err) {
          errEl.textContent = showApiError(err);
          errEl.style.display = 'block';
        }
      });
    }
  });
}
