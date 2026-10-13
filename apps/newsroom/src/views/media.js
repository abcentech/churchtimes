/**
 * Media Library View for Church Times Nigeria Newsroom
 * 
 * Features:
 * - Searchable asset gallery of verified photographs and illustrations
 * - Metadata inspector (alt text, caption, photographer credit, rights license)
 * - Accessible upload dialog requiring alt text description
 * - One-click insert into Story Editor
 */

import { apiAdapter } from '../api/adapter.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';

export async function renderMedia(container) {
  container.innerHTML = `
    <div class="view-header">
      <div class="view-header-row">
        <div>
          <h1 class="view-title">Newsroom Media Library</h1>
          <p class="view-subtitle">
            Curated photographic archive, rights clearances, and accessible alt-text records.
          </p>
        </div>

        <div>
          <button type="button" class="btn btn-primary" id="btn-upload-media">
            📤 Upload Photograph
          </button>
        </div>
      </div>
    </div>

    <!-- Filter & Search Toolbar -->
    <div class="filter-bar">
      <div class="filter-group">
        <input
          type="search"
          id="media-search-input"
          class="search-input"
          placeholder="Search by caption, person or photographer..."
          aria-label="Search media library"
        />
      </div>
      <div class="filter-group">
        <span style="font-size: 0.8125rem; color: var(--color-muted);" id="media-count-badge">Loading media...</span>
      </div>
    </div>

    <!-- Media Grid -->
    <div class="media-grid" id="media-assets-grid" role="region" aria-label="Media asset thumbnails">
      <div style="text-align: center; padding: 3rem;">Loading newsroom photographs...</div>
    </div>
  `;

  const searchInput = container.querySelector('#media-search-input');
  searchInput.addEventListener('input', debounce(async () => {
    await refreshMediaGrid(container, searchInput.value);
  }, 250));

  container.querySelector('#btn-upload-media').addEventListener('click', () => {
    openUploadModal(container);
  });

  await refreshMediaGrid(container, '');
}

async function refreshMediaGrid(container, search = '') {
  const gridEl = container.querySelector('#media-assets-grid');
  const countBadge = container.querySelector('#media-count-badge');
  if (!gridEl) return;

  const res = await apiAdapter.getMedia({ search });
  const mediaList = res.data;

  if (countBadge) {
    countBadge.textContent = `${mediaList.length} assets verified`;
  }

  if (mediaList.length === 0) {
    gridEl.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--color-muted);">
        No media assets found matching "${escapeHtml(search)}".
      </div>
    `;
    return;
  }

  gridEl.innerHTML = mediaList.map(item => `
    <div class="media-item-card" data-media-id="${item.id}" role="button" tabindex="0" aria-label="View media details: ${escapeHtml(item.title)}">
      <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt)}" class="media-item-thumb" loading="lazy">
      <div class="media-item-info">
        <div class="media-item-title">${escapeHtml(item.title)}</div>
        <div class="media-item-meta">
          <span>${escapeHtml(item.dimensions)} · ${escapeHtml(item.filesize)}</span>
          <br>
          <span style="color: var(--color-forest); font-weight: 500;">${escapeHtml(item.credit || 'Church Times')}</span>
        </div>
      </div>
    </div>
  `).join('');

  gridEl.querySelectorAll('.media-item-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-media-id');
      const item = mediaList.find(m => m.id === id);
      if (item) inspectMediaModal(item, container);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });
  });
}

function inspectMediaModal(item, container) {
  openModal({
    title: item.title,
    contentHtml: `
      <div style="display: flex; flex-direction: column; gap: 1rem;">
        <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt)}" style="width: 100%; max-height: 340px; object-fit: contain; background: #000; border-radius: var(--radius-sm);">

        <div style="background-color: var(--color-parchment-light); border: 1px solid var(--color-rule); border-radius: var(--radius-md); padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.875rem;">
          <div><strong>Accessible Alt Text:</strong> ${escapeHtml(item.alt)}</div>
          <div><strong>Caption:</strong> ${escapeHtml(item.caption || 'None provided')}</div>
          <div><strong>Rights / Photographer:</strong> ${escapeHtml(item.credit || 'Church Times Newsroom')}</div>
          <div><strong>License Type:</strong> <span class="badge badge-category">${escapeHtml(item.license || 'Staff')}</span></div>
          <div><strong>Dimensions & Size:</strong> ${escapeHtml(item.dimensions)} · ${escapeHtml(item.filesize)}</div>
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-outline" id="modal-close-media">Close</button>
          <button type="button" class="btn btn-primary" id="modal-use-in-editor">
            ✍️ Attach to Story Editor
          </button>
        </div>
      </div>
    `,
    onRender: (modalBody, close) => {
      modalBody.querySelector('#modal-close-media').addEventListener('click', close);
      modalBody.querySelector('#modal-use-in-editor').addEventListener('click', () => {
        close();
        showToast('Media selected! Opening editor...', 'success');
        store.setCurrentView('editor');
      });
    }
  });
}

function openUploadModal(container) {
  openModal({
    title: 'Upload Media Asset',
    contentHtml: `
      <form id="upload-media-form">
        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="up-file-title" class="form-label">Asset Title <span style="color: #DC2626;">*</span></label>
          <input type="text" id="up-file-title" class="form-input" placeholder="e.g. Bishop presiding over Synod communion" required />
        </div>

        <div class="form-group" style="margin-bottom: 1rem;">
          <label for="up-file-alt" class="form-label">Accessible Alt Text (WCAG 2.2 AA) <span style="color: #DC2626;">*</span></label>
          <textarea id="up-file-alt" class="form-textarea" rows="2" placeholder="Describe the scene accurately for blind and low-vision readers..." required></textarea>
        </div>

        <div class="form-grid-2" style="margin-bottom: 1rem;">
          <div class="form-group">
            <label for="up-file-credit" class="form-label">Photographer / Credit <span style="color: #DC2626;">*</span></label>
            <input type="text" id="up-file-credit" class="form-input" placeholder="e.g. Derin Adeogun / Church Times" required />
          </div>

          <div class="form-group">
            <label for="up-file-license" class="form-label">License Record</label>
            <select id="up-file-license" class="form-select">
              <option value="Staff Photograph">Staff Photograph</option>
              <option value="Editorial Archive Use">Editorial Archive Use</option>
              <option value="Attributed Press Handout">Attributed Press Handout</option>
              <option value="Creative Commons Byline">Creative Commons Byline</option>
            </select>
          </div>
        </div>

        <div class="form-group" style="margin-bottom: 1.25rem;">
          <label for="up-file-caption" class="form-label">Editorial Caption</label>
          <input type="text" id="up-file-caption" class="form-input" placeholder="Context of where and when photo was taken..." />
        </div>

        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-outline" id="modal-cancel-upload">Cancel</button>
          <button type="submit" class="btn btn-primary">Save to Media Library</button>
        </div>
      </form>
    `,
    onRender: (modalBody, close) => {
      modalBody.querySelector('#modal-cancel-upload').addEventListener('click', close);
      modalBody.querySelector('#upload-media-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = modalBody.querySelector('#up-file-title').value.trim();
        const alt = modalBody.querySelector('#up-file-alt').value.trim();
        const credit = modalBody.querySelector('#up-file-credit').value.trim();
        const license = modalBody.querySelector('#up-file-license').value;
        const caption = modalBody.querySelector('#up-file-caption').value.trim();

        if (!title || !alt || !credit) return;

        await apiAdapter.uploadMedia({
          title,
          alt,
          credit,
          license,
          caption,
          url: '/site/news-media/29276.jpg', // Local sample asset
          filename: 'uploaded-photo.jpg'
        });

        close();
        showToast('Photograph added to newsroom archive!', 'success');
        await refreshMediaGrid(container, '');
      });
    }
  });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
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
