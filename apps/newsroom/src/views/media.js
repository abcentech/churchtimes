/**
 * Media Library View
 *
 * Lists /api/media and uploads with a real multipart POST (file + _payload JSON). Image URLs come from the CMS
 * response (absolute, or made absolute with the build-time CMS URL). Alt text is required by the CMS.
 */

import { api } from '../api/index.js';
import { openModal } from '../components/modal.js';
import { showApiError } from '../components/notify.js';
import { uploadFormHtml, bindUploadForm, mediaCardHtml } from '../components/media-picker.js';
import { escapeHtml, debounce, latestGuard } from '../util.js';

const beginGrid = latestGuard();

export async function renderMedia(container) {
  const canUpload = api.can('media.upload');
  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Newsroom Media Library</h1>
          <p class="view-subtitle">Photographic archive with credits and accessible alt-text records.</p>
        </div>
        <div>
          ${canUpload ? '<button type="button" class="btn btn-primary" id="btn-upload-media" data-testid="media-upload-open">Upload Photograph</button>' : ''}
        </div>
      </div>
    </div>

    <div id="media-error" data-testid="media-error" role="alert" class="validation-summary-alert" style="display:none; margin-bottom: 1rem;"></div>

    <div class="filter-bar">
      <div class="filter-group">
        <input type="search" id="media-search-input" data-testid="media-search" class="search-input" placeholder="Search by alt text..." aria-label="Search media library" />
      </div>
      <div class="filter-group">
        <span style="font-size: 0.8125rem; color: var(--color-muted);" id="media-count-badge">Loading media...</span>
      </div>
    </div>

    <div class="media-grid" id="media-assets-grid" data-testid="media-grid" role="region" aria-label="Media asset thumbnails">
      <div style="text-align: center; padding: 3rem;">Loading newsroom photographs...</div>
    </div>
  `;

  const searchInput = container.querySelector('#media-search-input');
  searchInput.addEventListener('input', debounce(() => refreshMediaGrid(container, searchInput.value), 300));
  container.querySelector('#btn-upload-media')?.addEventListener('click', () => openUploadModal(container));

  await refreshMediaGrid(container, '');
}

async function refreshMediaGrid(container, search = '') {
  const grid = container.querySelector('#media-assets-grid');
  const count = container.querySelector('#media-count-badge');
  const errEl = container.querySelector('#media-error');
  if (!grid) return;

  const isCurrent = beginGrid();
  let res;
  try {
    res = await api.getMedia({ search });
    if (!isCurrent()) return;
  } catch (err) {
    if (!isCurrent()) return;
    grid.innerHTML = '<div style="grid-column: 1 / -1; text-align:center; padding: 3rem;">Media could not be loaded.</div>';
    if (count) count.textContent = 'unavailable';
    errEl.textContent = showApiError(err, 'Could not load media: ');
    errEl.style.display = 'block';
    return;
  }
  errEl.style.display = 'none';
  const list = res.data;
  if (count) count.textContent = `${res.totalDocs ?? list.length} assets`;

  if (!list.length) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--color-muted);" data-testid="media-empty">No media assets found${search ? ` matching "${escapeHtml(search)}"` : ''}.</div>`;
    return;
  }

  grid.innerHTML = list.map(item => mediaCardHtml(item)).join('');
  grid.querySelectorAll('.media-item-card').forEach(card => {
    const open = () => {
      const item = list.find(m => m.id === card.getAttribute('data-media-id'));
      if (item) inspectMediaModal(item);
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

function inspectMediaModal(item) {
  openModal({
    title: item.alt || item.filename || 'Media',
    contentHtml: `
      <div style="display: flex; flex-direction: column; gap: 1rem;" data-testid="media-detail">
        ${item.url ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt)}" style="width: 100%; max-height: 340px; object-fit: contain; background: #000; border-radius: var(--radius-sm);">` : ''}
        <div style="background-color: var(--color-parchment-light); border: 1px solid var(--color-rule); border-radius: var(--radius-md); padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.875rem;">
          <div><strong>Accessible Alt Text:</strong> ${escapeHtml(item.alt)}</div>
          <div><strong>Caption:</strong> ${escapeHtml(item.caption || 'None provided')}</div>
          <div><strong>Credit / Photographer:</strong> ${escapeHtml(item.credit || 'None recorded')}</div>
          <div><strong>File:</strong> ${escapeHtml(item.filename)}${item.width && item.height ? ` &middot; ${escapeHtml(item.width)}x${escapeHtml(item.height)}` : ''}</div>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-outline" id="modal-close-media">Close</button>
        </div>
      </div>`,
    onRender: (body, close) => body.querySelector('#modal-close-media').addEventListener('click', close)
  });
}

function openUploadModal(container) {
  openModal({
    title: 'Upload Media Asset',
    contentHtml: uploadFormHtml('media'),
    onRender: (body, close) => {
      bindUploadForm(body, 'media', async () => {
        close();
        await refreshMediaGrid(container, '');
      });
    }
  });
}
