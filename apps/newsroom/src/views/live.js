/**
 * Live Event Coverage & Real-Time Updates Console
 * 
 * Features:
 * - Live Event selector and status manager (Upcoming, Live, Concluded)
 * - Rapid update composer with timestamps, pinned highlight toggle, and reporter byline
 * - Editorial verification step (reporters submit -> editors approve -> timeline updates)
 * - Reader live timeline preview with pulsing LIVE indicator and polling simulation
 */

import { apiAdapter } from '../api/adapter.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';

let pollingTimer = null;
let currentEventSlug = 'ncef-2026-plenary';

export async function renderLive(container) {
  const currentUser = store.getCurrentUser();

  const eventsRes = await apiAdapter.getLiveEvents();
  const events = eventsRes.data;
  let activeEvent = events.find(e => e.slug === currentEventSlug) || events[0];

  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Live Coverage & Real-Time Updates</h1>
          <p class="view-subtitle">
            Synchronized coverage for ecclesiastical conferences, national summits, and breaking developments.
          </p>
        </div>

        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <select id="live-event-select" class="select-input" aria-label="Select live event">
            ${events.map(ev => `
              <option value="${ev.slug}" ${ev.slug === activeEvent.slug ? 'selected' : ''}>
                ${ev.status === 'live' ? '🔴 LIVE: ' : ''}${escapeHtml(ev.title)}
              </option>
            `).join('')}
          </select>
          <button type="button" class="btn btn-outline btn-sm" id="btn-create-event">
            + New Event
          </button>
        </div>
      </div>
    </div>

    <!-- Active Event Control Banner -->
    <div class="card" style="margin-bottom: 1.5rem; background-color: var(--color-forest); color: var(--color-parchment);">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap;">
        <div>
          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.35rem;">
            <span class="badge ${activeEvent.status === 'live' ? 'badge-live' : 'badge-draft'}">
              ${activeEvent.status === 'live' ? '🔴 LIVE NOW' : activeEvent.status.toUpperCase()}
            </span>
            <span style="font-size: 0.8125rem; color: var(--color-sage);">
              📍 ${escapeHtml(activeEvent.location)}
            </span>
          </div>
          <h2 style="font-family: var(--font-serif); font-size: 1.35rem; color: #FFFFFF;">
            ${escapeHtml(activeEvent.title)}
          </h2>
          <p style="font-size: 0.875rem; color: var(--color-sage-soft); max-width: 650px; margin-top: 0.25rem;">
            ${escapeHtml(activeEvent.description)}
          </p>
        </div>

        <div style="display: flex; align-items: center; gap: 0.75rem;">
          <div style="text-align: right;">
            <div style="font-size: 0.75rem; color: var(--color-sage); text-transform: uppercase;">Active Viewers</div>
            <div style="font-size: 1.25rem; font-weight: 700; color: #FFFFFF;" id="live-viewer-count">
              ${activeEvent.activeViewers || 1420}
            </div>
          </div>
          <button type="button" class="btn btn-outline btn-sm" id="btn-toggle-event-status" style="color: var(--color-parchment); border-color: var(--color-sage);">
            ${activeEvent.status === 'live' ? 'Pause Coverage' : 'Set as LIVE NOW'}
          </button>
        </div>
      </div>
    </div>

    <!-- Main Workspace: Update Composer + Live Reader Stream -->
    <div class="live-console-grid">
      <!-- Composer Column -->
      <div class="card" style="display: flex; flex-direction: column; gap: 1rem;">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-rule); padding-bottom: 0.5rem;">
          <h3 style="font-family: var(--font-serif); font-size: 1.15rem; color: var(--color-forest);">
            ✍️ Compose Live Update
          </h3>
          <span style="font-size: 0.75rem; color: var(--color-muted);">
            Posting as: <strong>${escapeHtml(currentUser.name)}</strong> (${currentUser.role})
          </span>
        </div>

        <form id="live-update-form">
          <div class="form-grid-2" style="margin-bottom: 1rem;">
            <div class="form-group">
              <label for="upd-time-input" class="form-label">Timestamp (WAT)</label>
              <input type="text" id="upd-time-input" class="form-input" value="${getCurrentWatTime()}" required />
            </div>

            <div class="form-group">
              <label for="upd-headline-input" class="form-label">Alert Headline (Optional)</label>
              <input type="text" id="upd-headline-input" class="form-input" placeholder="e.g. Keynote Address Concluded" />
            </div>
          </div>

          <div class="form-group" style="margin-bottom: 1rem;">
            <label for="upd-body-input" class="form-label">Update Content <span style="color: #DC2626;">*</span></label>
            <textarea
              id="upd-body-input"
              class="form-textarea"
              rows="4"
              placeholder="Report specific facts, quotes, or proceedings in real-time..."
              required
            ></textarea>
          </div>

          <div style="display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem;">
            <label style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; cursor: pointer;">
              <input type="checkbox" id="upd-pinned-chk">
              <span>📌 Pin as Major Highlight / Breaking Alert</span>
            </label>
          </div>

          <button type="submit" class="btn btn-primary" id="btn-post-update" style="width: 100%;">
            ${currentUser.role === 'reporter' ? 'Submit Update for Editorial Review' : '🚀 Publish Live Update Immediately'}
          </button>
        </form>

        <!-- Reporter Pending Updates Queue (for Section Editor / EIC approval) -->
        <div id="pending-live-updates-container" style="margin-top: 1rem; border-top: 1px solid var(--color-rule); padding-top: 1rem;">
          <h4 style="font-size: 0.875rem; font-weight: 700; color: var(--color-forest); margin-bottom: 0.5rem;">
            Pending Field Updates Awaiting Approval
          </h4>
          <div id="pending-updates-list">Loading pending updates...</div>
        </div>
      </div>

      <!-- Live Reader Timeline Column -->
      <div class="live-stream-box">
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--color-rule); padding-bottom: 0.5rem;">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span class="badge badge-live">🔴 LIVE STREAM</span>
            <h3 style="font-family: var(--font-serif); font-size: 1.15rem; color: var(--color-forest);">
              Public Timeline Feed
            </h3>
          </div>

          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <span style="font-size: 0.75rem; color: var(--color-muted);" id="polling-status-label">Live polling active (8s)</span>
            <button type="button" class="btn btn-outline btn-sm" id="btn-refresh-timeline" title="Refresh timeline now">
              🔄
            </button>
          </div>
        </div>

        <div class="live-timeline-feed" id="live-timeline-feed" role="feed" aria-label="Live event timeline updates">
          <div style="text-align: center; padding: 2rem;">Loading live timeline...</div>
        </div>
      </div>
    </div>
  `;

  // Bind Event Selector
  const eventSelect = container.querySelector('#live-event-select');
  eventSelect.addEventListener('change', () => {
    currentEventSlug = eventSelect.value;
    renderLive(container);
  });

  // Create Event Modal
  container.querySelector('#btn-create-event').addEventListener('click', () => {
    openCreateEventModal(container);
  });

  // Toggle Event Status
  container.querySelector('#btn-toggle-event-status').addEventListener('click', async () => {
    activeEvent.status = activeEvent.status === 'live' ? 'concluded' : 'live';
    showToast(`Event status updated to ${activeEvent.status.toUpperCase()}`, 'info');
    renderLive(container);
  });

  // Form Submit
  const updateForm = container.querySelector('#live-update-form');
  updateForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const time = container.querySelector('#upd-time-input').value.trim();
    const headline = container.querySelector('#upd-headline-input').value.trim();
    const body = container.querySelector('#upd-body-input').value.trim();
    const isPinned = container.querySelector('#upd-pinned-chk').checked;

    if (!body) {
      alert('Please enter update content.');
      return;
    }

    const isEditor = currentUser.role !== 'reporter';
    const status = isEditor ? 'approved' : 'pending_review';

    await apiAdapter.postLiveUpdate({
      eventId: activeEvent.id,
      eventSlug: activeEvent.slug,
      timestamp: time,
      headline,
      body,
      reporterName: currentUser.name,
      status,
      isPinned
    });

    // Reset inputs
    container.querySelector('#upd-body-input').value = '';
    container.querySelector('#upd-headline-input').value = '';
    container.querySelector('#upd-pinned-chk').checked = false;
    container.querySelector('#upd-time-input').value = getCurrentWatTime();

    showToast(isEditor ? 'Live update published to public timeline!' : 'Update submitted for editor approval.', 'success');
    await refreshLiveStream(container, activeEvent.slug);
  });

  // Manual Refresh
  container.querySelector('#btn-refresh-timeline').addEventListener('click', async () => {
    await refreshLiveStream(container, activeEvent.slug);
    showToast('Timeline refreshed', 'info');
  });

  // Initial stream render & Start polling
  await refreshLiveStream(container, activeEvent.slug);
  startPolling(container, activeEvent.slug);
}

async function refreshLiveStream(container, slug) {
  const feedEl = container.querySelector('#live-timeline-feed');
  const pendingEl = container.querySelector('#pending-updates-list');
  if (!feedEl) return;

  const res = await apiAdapter.getLiveUpdates(slug, true);
  const allUpdates = res.data;

  const approved = allUpdates.filter(u => u.status === 'approved');
  const pending = allUpdates.filter(u => u.status !== 'approved');

  // Render Public Approved Stream
  if (approved.length === 0) {
    feedEl.innerHTML = `
      <div style="text-align: center; padding: 2rem; color: var(--color-muted);">
        No updates published yet.
      </div>
    `;
  } else {
    feedEl.innerHTML = approved.map(upd => `
      <article class="live-update-card ${upd.isPinned ? 'pinned' : ''}">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;">
          <span class="live-time-badge">${escapeHtml(upd.timestamp)}</span>
          ${upd.isPinned ? `<span class="badge" style="background-color: var(--color-clay); color: #fff; font-size: 0.625rem;">📌 PINNED HIGHLIGHT</span>` : ''}
        </div>
        ${upd.headline ? `<h4 style="font-family: var(--font-serif); font-size: 1.1rem; color: var(--color-forest);">${escapeHtml(upd.headline)}</h4>` : ''}
        <p style="font-size: 0.9375rem; color: var(--color-ink); line-height: 1.5;">${escapeHtml(upd.body)}</p>
        <span style="font-size: 0.75rem; color: var(--color-muted);">By ${escapeHtml(upd.reporterName || 'Church Times Reporter')}</span>
      </article>
    `).join('');
  }

  // Render Pending List for Editors
  if (pendingEl) {
    if (pending.length === 0) {
      pendingEl.innerHTML = `<span style="font-size: 0.75rem; color: var(--color-muted);">No field updates waiting for approval.</span>`;
    } else {
      pendingEl.innerHTML = pending.map(u => `
        <div style="background-color: #FEF3C7; border: 1px solid #FCD34D; border-radius: var(--radius-sm); padding: 0.5rem; margin-bottom: 0.5rem; font-size: 0.8125rem;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.25rem;">
            <strong>${escapeHtml(u.timestamp)} · ${escapeHtml(u.reporterName)}</strong>
            <button type="button" class="btn btn-success btn-sm" data-approve-upd-id="${u.id}">
              ✅ Approve & Push Live
            </button>
          </div>
          <div>${escapeHtml(u.headline ? u.headline + ' — ' : '')}${escapeHtml(u.body)}</div>
        </div>
      `).join('');

      pendingEl.querySelectorAll('[data-approve-upd-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-approve-upd-id');
          await apiAdapter.approveLiveUpdate(id);
          showToast('Update approved and broadcast to public stream!', 'success');
          await refreshLiveStream(container, slug);
        });
      });
    }
  }
}

function startPolling(container, slug) {
  clearInterval(pollingTimer);
  pollingTimer = setInterval(async () => {
    // Polls only if page is still displaying live view
    if (store.getCurrentView() === 'live') {
      await refreshLiveStream(container, slug);
    } else {
      clearInterval(pollingTimer);
    }
  }, 8000);
}

function openCreateEventModal(container) {
  openModal({
    title: 'Create New Live Event',
    contentHtml: `
      <form id="create-event-form">
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="new-ev-title" class="form-label">Event Title <span style="color: #DC2626;">*</span></label>
          <input type="text" id="new-ev-title" class="form-input" placeholder="e.g. 2026 Anglican Youth Synod Opening" required />
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="new-ev-location" class="form-label">Location / City</label>
          <input type="text" id="new-ev-location" class="form-input" placeholder="e.g. Abuja International Conference Centre" />
        </div>
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="new-ev-desc" class="form-label">Brief Description</label>
          <textarea id="new-ev-desc" class="form-textarea" rows="3" placeholder="Context and scope of reporting..."></textarea>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-outline" id="cancel-create-ev">Cancel</button>
          <button type="submit" class="btn btn-primary">Create & Begin Coverage</button>
        </div>
      </form>
    `,
    onRender: (modalBody, close) => {
      modalBody.querySelector('#cancel-create-ev').addEventListener('click', close);
      modalBody.querySelector('#create-event-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = modalBody.querySelector('#new-ev-title').value.trim();
        const location = modalBody.querySelector('#new-ev-location').value.trim();
        const description = modalBody.querySelector('#new-ev-desc').value.trim();

        if (!title) return;

        const res = await apiAdapter.createLiveEvent({ title, location, description });
        currentEventSlug = res.data.slug;
        close();
        showToast('New live event initialized!', 'success');
        renderLive(container);
      });
    }
  });
}

function getCurrentWatTime() {
  const now = new Date();
  return `${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} WAT`;
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
