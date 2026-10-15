/**
 * Media picker + real multipart upload (POST /api/media via api.uploadMedia).
 * Used by the story editor (featured image) and the media library.
 */
import { api } from '../api/index.js';
import { openModal } from './modal.js';
import { showToast } from './toast.js';
import { showApiError } from './notify.js';
import { escapeHtml, debounce } from '../util.js';

export const ACCEPTED_IMAGE_TYPES = 'image/jpeg,image/png,image/webp';

/**
 * Picker `validate` for images that go into published content (story body, live update): the media record must have a
 * numeric id and alt text. Returns '' when fine, otherwise a message for the writer.
 */
export function mediaImageProblem(media) {
  if (!media || !/^\d+$/.test(String(media.id ?? ''))) return 'This media item cannot be used here (it has no numeric id).';
  if (!String(media.alt || '').trim()) {
    return 'Alt text is required for images in published content and this image has none. Upload the picture again with alt text (the upload form requires it), or ask an editor to add alt text to the media record in the CMS admin.';
  }
  return '';
}

/** HTML for the upload form (all values static). Ids are stable for E2E tests. */
export function uploadFormHtml(prefix = 'media') {
  return `
    <form id="${prefix}-upload-form" data-testid="${prefix}-upload-form" novalidate>
      <div class="form-group" style="margin-bottom: 0.75rem;">
        <label for="${prefix}-upload-file" class="form-label">Image file (JPEG, PNG or WebP, max 10 MB) <span style="color:#DC2626;">*</span></label>
        <input type="file" id="${prefix}-upload-file" data-testid="media-upload-input" class="form-input" accept="${ACCEPTED_IMAGE_TYPES}" />
      </div>
      <div class="form-group" style="margin-bottom: 0.75rem;">
        <label for="${prefix}-upload-alt" class="form-label">Alt text (describe the image) <span style="color:#DC2626;">*</span></label>
        <textarea id="${prefix}-upload-alt" data-testid="media-upload-alt" class="form-textarea" rows="2" maxlength="300"></textarea>
      </div>
      <div class="form-grid-2" style="margin-bottom: 0.75rem;">
        <div class="form-group">
          <label for="${prefix}-upload-credit" class="form-label">Photographer / credit</label>
          <input type="text" id="${prefix}-upload-credit" data-testid="media-upload-credit" class="form-input" />
        </div>
        <div class="form-group">
          <label for="${prefix}-upload-caption" class="form-label">Caption</label>
          <input type="text" id="${prefix}-upload-caption" data-testid="media-upload-caption" class="form-input" />
        </div>
      </div>
      <div id="${prefix}-upload-error" data-testid="media-upload-error" role="alert" style="display:none; color:#B91C1C; font-size:0.8125rem; margin-bottom:0.5rem;"></div>
      <div style="display:flex; justify-content:flex-end;">
        <button type="submit" class="btn btn-primary" id="${prefix}-upload-submit" data-testid="media-upload-submit">Upload to Media Library</button>
      </div>
    </form>`;
}

/**
 * Wire the upload form. Calls onUploaded(mediaVm) ONLY after the CMS answered 2xx.
 */
export function bindUploadForm(root, prefix, onUploaded) {
  const form = root.querySelector(`#${prefix}-upload-form`);
  const errorEl = root.querySelector(`#${prefix}-upload-error`);
  const submit = root.querySelector(`#${prefix}-upload-submit`);
  const setError = msg => {
    errorEl.textContent = msg || '';
    errorEl.style.display = msg ? 'block' : 'none';
  };
  form.addEventListener('submit', async e => {
    e.preventDefault();
    setError('');
    const file = root.querySelector(`#${prefix}-upload-file`).files?.[0];
    const alt = root.querySelector(`#${prefix}-upload-alt`).value.trim();
    const credit = root.querySelector(`#${prefix}-upload-credit`).value.trim();
    const caption = root.querySelector(`#${prefix}-upload-caption`).value.trim();
    if (!file) return setError('Choose an image file to upload.');
    if (!alt) return setError('Alt text is required.');
    submit.disabled = true;
    submit.textContent = 'Uploading...';
    try {
      const res = await api.uploadMedia(file, { alt, credit, caption });
      showToast('Photograph uploaded to the media library.', 'success');
      await onUploaded(res.data);
    } catch (err) {
      setError(showApiError(err));
    } finally {
      submit.disabled = false;
      submit.textContent = 'Upload to Media Library';
    }
  });
}

export function mediaCardHtml(item) {
  const src = item.thumbUrl || item.url;
  return `
    <div class="media-item-card" data-testid="media-card" data-media-id="${escapeHtml(item.id)}" role="button" tabindex="0" aria-label="${escapeHtml(item.alt || item.filename || 'Media')}">
      ${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.alt)}" class="media-item-thumb" loading="lazy">` : ''}
      <div class="media-item-info">
        <div class="media-item-title">${escapeHtml(item.alt || item.filename || 'Untitled')}</div>
        <div class="media-item-meta">
          ${item.width && item.height ? `<span>${escapeHtml(item.width)}x${escapeHtml(item.height)}</span><br>` : ''}
          <span style="color: var(--color-forest); font-weight: 500;">${escapeHtml(item.credit || 'No credit recorded')}</span>
        </div>
      </div>
    </div>`;
}

/**
 * Pick an existing image from /api/media (or upload a new one). onSelect(mediaVm).
 * `validate(mediaVm)` may return a message to refuse a choice (it is shown in the dialog, which stays open).
 * `title` is the dialog heading.
 */
export async function openMediaPicker({ onSelect, validate, title = 'Select Featured Photograph' }) {
  let list = [];
  try {
    list = (await api.getMedia()).data;
  } catch (err) {
    showApiError(err, 'Could not load the media library: ');
    return;
  }

  openModal({
    title,
    contentHtml: `
      <div data-testid="media-picker">
        <div id="picker-error" data-testid="media-picker-error" role="alert" style="display:none; color:#B91C1C; font-size:0.8125rem; margin-bottom:0.5rem;"></div>
        <div class="filter-group" style="margin-bottom: 0.75rem;">
          <input type="search" id="picker-search" class="search-input" placeholder="Search by alt text..." aria-label="Search media" data-testid="media-picker-search">
        </div>
        <div class="media-grid" id="picker-grid" data-testid="media-picker-grid" style="max-height: 320px; overflow-y: auto;"></div>
        <details style="margin-top: 1rem;" id="picker-upload-details">
          <summary style="cursor:pointer; font-weight:600;" data-testid="media-picker-upload-toggle">Upload a new photograph</summary>
          <div style="margin-top: 0.75rem;">${uploadFormHtml('picker')}</div>
        </details>
      </div>`,
    onRender: (body, close) => {
      const grid = body.querySelector('#picker-grid');
      const pickerError = body.querySelector('#picker-error');
      // Returns true (and closes) when the choice is accepted.
      const accept = chosen => {
        const problem = typeof validate === 'function' ? validate(chosen) : '';
        pickerError.textContent = problem || '';
        pickerError.style.display = problem ? 'block' : 'none';
        if (problem) return false;
        onSelect(chosen);
        close();
        return true;
      };
      const paint = items => {
        list = items;
        grid.innerHTML = items.length
          ? items.map(m => mediaCardHtml(m)).join('')
          : '<div style="grid-column: 1 / -1; padding: 1rem; color: var(--color-muted);">No photographs found.</div>';
        grid.querySelectorAll('.media-item-card').forEach(card => {
          const choose = () => {
            const found = list.find(m => m.id === card.getAttribute('data-media-id'));
            if (found) accept(found);
          };
          card.addEventListener('click', choose);
          card.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
          });
        });
      };
      paint(list);

      body.querySelector('#picker-search').addEventListener('input', debounce(async e => {
        try {
          paint((await api.getMedia({ search: e.target.value })).data);
        } catch (err) {
          showApiError(err);
        }
      }, 250));

      bindUploadForm(body, 'picker', async uploaded => { accept(uploaded); });
    }
  });
}
