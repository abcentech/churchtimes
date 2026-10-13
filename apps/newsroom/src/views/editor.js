/**
 * Story Editor View for Church Times Nigeria Newsroom
 * 
 * Features:
 * - Headline with auto-slug generator
 * - Category picker, standfirst and body editor with markdown formatting
 * - Image selection with accessible alt text and credits
 * - Real-time word count & reading time calculation
 * - Debounced autosave engine with visual status indicator
 * - Live reader preview (desktop split view / mobile tab toggle)
 * - Role-governed workflow: Save Draft -> Submit for Review -> Request Changes -> Approve -> Publish
 */

import { apiAdapter } from '../api/adapter.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';
import { openModal, closeModal } from '../components/modal.js';

let autosaveTimer = null;
let currentStory = null;
let isSplitPreviewActive = true;
let isMobilePreviewActive = false;

export async function renderEditor(container, storyId = null) {
  const currentUser = store.getCurrentUser();

  if (storyId) {
    try {
      const res = await apiAdapter.getArticle(storyId);
      currentStory = res.data;
    } catch (err) {
      showToast('Could not load requested story, creating new draft', 'error');
      currentStory = createBlankStory(currentUser);
    }
  } else {
    currentStory = createBlankStory(currentUser);
  }

  container.innerHTML = `
    <!-- Top Bar: Navigation, Status and Actions -->
    <div class="editor-sticky-bar" id="editor-actions-bar">
      <div style="display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;">
        <button type="button" class="btn btn-outline btn-sm" id="btn-back-dashboard" aria-label="Return to newsroom dashboard">
          ← Dashboard
        </button>
        <div id="story-status-badge-container">
          ${renderStatusBadge(currentStory.status)}
        </div>
        <div class="autosave-indicator" id="autosave-indicator" aria-live="polite">
          <span class="autosave-dot" id="autosave-dot"></span>
          <span id="autosave-label">Saved</span>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
        <span style="font-size: 0.75rem; color: var(--color-muted); margin-right: 0.5rem;" id="word-count-badge">
          0 words · 0 min read
        </span>

        <!-- Mobile Preview Toggle -->
        <button type="button" class="btn btn-outline btn-sm" id="btn-toggle-preview" aria-pressed="false">
          👁️ Toggle Preview
        </button>

        <!-- Save Draft Button -->
        <button type="button" class="btn btn-secondary btn-sm" id="btn-save-draft">
          💾 Save Draft
        </button>

        <!-- Dynamic Role-Governed Workflow Action Buttons -->
        <div id="workflow-action-buttons" style="display: inline-flex; gap: 0.5rem;">
          ${renderWorkflowButtons(currentStory, currentUser)}
        </div>
      </div>
    </div>

    <!-- Review Notes Callout (if changes requested or reviewed) -->
    <div id="review-notes-banner" style="${currentStory.reviewNotes ? 'display: block;' : 'display: none;'}" class="ethics-notice-box" style="margin-bottom: 1rem;">
      <h4 id="review-notes-title">Editorial Review Notes</h4>
      <p id="review-notes-text">${escapeHtml(currentStory.reviewNotes || '')}</p>
    </div>

    <!-- Main Workspace: Editor Form + Preview -->
    <div class="editor-workspace split-active" id="editor-workspace-grid">
      <!-- Editor Column -->
      <div class="editor-pane" id="editor-input-pane">
        <!-- Headline -->
        <div class="form-group">
          <label for="story-headline-input" class="form-label">Headline (Story Title)</label>
          <textarea
            id="story-headline-input"
            class="headline-textarea"
            rows="2"
            placeholder="Enter working headline..."
            aria-required="true"
          >${escapeHtml(currentStory.title || '')}</textarea>
        </div>

        <!-- Standfirst / Lead Summary -->
        <div class="form-group">
          <label for="story-standfirst-input" class="form-label">Standfirst / Deck (1-2 sentence lead)</label>
          <textarea
            id="story-standfirst-input"
            class="standfirst-textarea"
            rows="2"
            placeholder="Brief editorial summary introducing the report to readers..."
          >${escapeHtml(currentStory.standfirst || '')}</textarea>
        </div>

        <!-- Metadata Row: Category, Reporter Byline, Slug -->
        <div class="form-grid-2">
          <div class="form-group">
            <label for="story-category-select" class="form-label">Editorial Section</label>
            <select id="story-category-select" class="form-select">
              <option value="faith-society" ${currentStory.category === 'faith-society' ? 'selected' : ''}>Faith & Society</option>
              <option value="church-ministry" ${currentStory.category === 'church-ministry' ? 'selected' : ''}>Church & Ministry</option>
              <option value="people-purpose" ${currentStory.category === 'people-purpose' ? 'selected' : ''}>People & Purpose</option>
              <option value="business-vocation" ${currentStory.category === 'business-vocation' ? 'selected' : ''}>Business & Vocation</option>
              <option value="culture-ideas" ${currentStory.category === 'culture-ideas' ? 'selected' : ''}>Culture & Ideas</option>
            </select>
          </div>

          <div class="form-group">
            <label for="story-slug-input" class="form-label">URL Slug</label>
            <input
              type="text"
              id="story-slug-input"
              class="form-input"
              value="${escapeHtml(currentStory.slug || '')}"
              placeholder="e.g. omololu-falobi-legacy"
            />
          </div>
        </div>

        <!-- Featured Media Section -->
        <div class="form-group">
          <label class="form-label">Featured Photograph & Rights</label>
          <div class="featured-image-box" id="featured-image-container">
            ${renderFeaturedImageContent(currentStory.featuredImage)}
          </div>
        </div>

        <!-- Body Formatting Toolbar -->
        <div class="form-group">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.25rem;">
            <label for="story-body-input" class="form-label" style="margin: 0;">Story Content (Markdown / Text)</label>
            <span style="font-size: 0.75rem; color: var(--color-muted);">Supports paragraphs, quotes and lists</span>
          </div>

          <div class="format-bar" role="toolbar" aria-label="Text formatting toolbar">
            <button type="button" class="format-btn" data-fmt="bold" title="Bold text"><strong>B</strong></button>
            <button type="button" class="format-btn" data-fmt="italic" title="Italic text"><em>I</em></button>
            <button type="button" class="format-btn" data-fmt="h2" title="Section Heading">H2</button>
            <button type="button" class="format-btn" data-fmt="h3" title="Sub-heading">H3</button>
            <button type="button" class="format-btn" data-fmt="quote" title="Pullquote / Blockquote">Quote</button>
            <button type="button" class="format-btn" data-fmt="list" title="Bullet List">• List</button>
          </div>

          <textarea
            id="story-body-input"
            class="story-body-textarea"
            placeholder="Write the full report here with independent sourcing and evidence..."
            aria-required="true"
          >${escapeHtml(currentStory.body || '')}</textarea>
        </div>
      </div>

      <!-- Live Reader Preview Column -->
      <div class="preview-pane" id="editor-preview-pane" aria-label="Reader Preview of article">
        <span class="preview-watermark">Live Reader Preview</span>
        <div class="preview-category-tag" id="preview-category">
          ${getCategoryTitle(currentStory.category)}
        </div>
        <h1 class="preview-headline" id="preview-headline">
          ${escapeHtml(currentStory.title || 'Untitled Headline')}
        </h1>
        <div class="preview-standfirst" id="preview-standfirst">
          ${escapeHtml(currentStory.standfirst || 'Lead summary will appear here.')}
        </div>
        <div class="preview-byline" id="preview-byline">
          By <strong>${escapeHtml(currentStory.author?.name || currentUser.name)}</strong> ·
          <span>${formatDate(currentStory.publishedAt || currentStory.updatedAt)}</span>
        </div>

        <div id="preview-image-box">
          ${currentStory.featuredImage ? `
            <img src="${escapeHtml(currentStory.featuredImage.url)}" alt="${escapeHtml(currentStory.featuredImage.alt)}" class="preview-hero-img" id="preview-img-el">
            <div class="preview-img-caption" id="preview-img-caption">
              ${escapeHtml(currentStory.featuredImage.caption || '')} · Credit: ${escapeHtml(currentStory.featuredImage.credit || '')}
            </div>
          ` : ''}
        </div>

        <div class="preview-body" id="preview-body-content">
          ${formatBodyMarkdown(currentStory.body || 'Story body will render here as you type...')}
        </div>
      </div>
    </div>
  `;

  // Bind Listeners
  bindEditorListeners(container);
  updateWordCount(container);
}

function createBlankStory(author) {
  return {
    id: null,
    title: '',
    slug: '',
    category: 'faith-society',
    standfirst: '',
    body: '',
    featuredImage: null,
    status: 'draft',
    author: author || { name: 'Gbenga Osinaike', desk: 'Reporter' },
    reviewNotes: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revisionCount: 1
  };
}

function bindEditorListeners(container) {
  const headlineInput = container.querySelector('#story-headline-input');
  const standfirstInput = container.querySelector('#story-standfirst-input');
  const categorySelect = container.querySelector('#story-category-select');
  const slugInput = container.querySelector('#story-slug-input');
  const bodyInput = container.querySelector('#story-body-input');
  const backBtn = container.querySelector('#btn-back-dashboard');
  const saveDraftBtn = container.querySelector('#btn-save-draft');
  const togglePreviewBtn = container.querySelector('#btn-toggle-preview');

  backBtn.addEventListener('click', () => {
    store.setCurrentView('dashboard');
  });

  // Auto-slug when headline changes and slug is empty or matches previous auto-slug
  headlineInput.addEventListener('input', () => {
    const title = headlineInput.value;
    if (!currentStory.id || !slugInput.value) {
      slugInput.value = slugify(title);
    }
    triggerAutosave(container);
    updatePreview(container);
    updateWordCount(container);
  });

  standfirstInput.addEventListener('input', () => {
    triggerAutosave(container);
    updatePreview(container);
    updateWordCount(container);
  });

  categorySelect.addEventListener('change', () => {
    triggerAutosave(container);
    updatePreview(container);
  });

  slugInput.addEventListener('input', () => {
    triggerAutosave(container);
  });

  bodyInput.addEventListener('input', () => {
    triggerAutosave(container);
    updatePreview(container);
    updateWordCount(container);
  });

  // Formatting Toolbar
  container.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const fmt = btn.getAttribute('data-fmt');
      applyFormatting(bodyInput, fmt);
      triggerAutosave(container);
      updatePreview(container);
      updateWordCount(container);
    });
  });

  // Featured Image Actions
  bindImageSelector(container);

  // Toggle Preview
  togglePreviewBtn.addEventListener('click', () => {
    const workspace = container.querySelector('#editor-workspace-grid');
    const previewPane = container.querySelector('#editor-preview-pane');
    const inputPane = container.querySelector('#editor-input-pane');

    if (window.innerWidth <= 768) {
      isMobilePreviewActive = !isMobilePreviewActive;
      if (isMobilePreviewActive) {
        inputPane.style.display = 'none';
        previewPane.style.display = 'block';
        togglePreviewBtn.textContent = '✏️ Show Editor';
      } else {
        inputPane.style.display = 'flex';
        previewPane.style.display = 'none';
        togglePreviewBtn.textContent = '👁️ Show Preview';
      }
    } else {
      isSplitPreviewActive = !isSplitPreviewActive;
      if (isSplitPreviewActive) {
        workspace.classList.add('split-active');
        previewPane.style.display = 'block';
      } else {
        workspace.classList.remove('split-active');
        previewPane.style.display = 'none';
      }
    }
  });

  // Manual Save Draft
  saveDraftBtn.addEventListener('click', async () => {
    await performSave(container, false);
    showToast('Draft saved successfully', 'success');
  });

  // Workflow Action Buttons
  bindWorkflowActions(container);
}

function bindImageSelector(container) {
  const chooseBtn = container.querySelector('#btn-choose-media');
  const removeBtn = container.querySelector('#btn-remove-media');

  if (chooseBtn) {
    chooseBtn.addEventListener('click', async () => {
      openMediaPickerModal(async (selectedMedia) => {
        currentStory.featuredImage = selectedMedia;
        container.querySelector('#featured-image-container').innerHTML = renderFeaturedImageContent(selectedMedia);
        bindImageSelector(container);
        updatePreview(container);
        triggerAutosave(container);
      });
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      currentStory.featuredImage = null;
      container.querySelector('#featured-image-container').innerHTML = renderFeaturedImageContent(null);
      bindImageSelector(container);
      updatePreview(container);
      triggerAutosave(container);
    });
  }

  // Handle alt text and caption inline edits
  const altInput = container.querySelector('#story-image-alt-input');
  const captionInput = container.querySelector('#story-image-caption-input');
  if (altInput && currentStory.featuredImage) {
    altInput.addEventListener('input', () => {
      currentStory.featuredImage.alt = altInput.value;
      updatePreview(container);
      triggerAutosave(container);
    });
  }
  if (captionInput && currentStory.featuredImage) {
    captionInput.addEventListener('input', () => {
      currentStory.featuredImage.caption = captionInput.value;
      updatePreview(container);
      triggerAutosave(container);
    });
  }
}

async function openMediaPickerModal(onSelect) {
  const res = await apiAdapter.getMedia();
  const mediaList = res.data;

  const html = `
    <div style="margin-bottom: 1rem;">
      <p style="font-size: 0.875rem; color: var(--color-muted);">
        Select a verified photograph from the newsroom archive or upload a new asset.
      </p>
    </div>
    <div class="media-grid" style="max-height: 400px; overflow-y: auto;">
      ${mediaList.map(item => `
        <div class="media-item-card" data-media-id="${item.id}" role="button" tabindex="0">
          <img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.alt)}" class="media-item-thumb">
          <div class="media-item-info">
            <div class="media-item-title">${escapeHtml(item.title)}</div>
            <div class="media-item-meta">${escapeHtml(item.credit || 'Church Times')}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;

  openModal({
    title: 'Select Featured Photograph',
    contentHtml: html,
    onRender: (modalBody, close) => {
      modalBody.querySelectorAll('.media-item-card').forEach(card => {
        card.addEventListener('click', () => {
          const id = card.getAttribute('data-media-id');
          const found = mediaList.find(m => m.id === id);
          if (found) {
            onSelect(found);
            close();
          }
        });
      });
    }
  });
}

function bindWorkflowActions(container) {
  const actionWrapper = container.querySelector('#workflow-action-buttons');
  if (!actionWrapper) return;

  // Submit for Review
  const submitReviewBtn = actionWrapper.querySelector('#btn-submit-review');
  if (submitReviewBtn) {
    submitReviewBtn.addEventListener('click', async () => {
      await performSave(container, false);
      const res = await apiAdapter.updateArticleStatus(currentStory.id, 'in_review', 'Submitted by reporter for editorial review');
      currentStory = res.data;
      updateStatusDisplay(container);
      showToast('Story submitted for editorial review! Moved to Review Queue.', 'success');
    });
  }

  // Request Changes
  const reqChangesBtn = actionWrapper.querySelector('#btn-request-changes');
  if (reqChangesBtn) {
    reqChangesBtn.addEventListener('click', () => {
      openModal({
        title: 'Request Editorial Changes',
        contentHtml: `
          <div class="form-group" style="margin-bottom: 1rem;">
            <label for="modal-feedback-notes" class="form-label">Feedback & Revision Guidance for Reporter:</label>
            <textarea id="modal-feedback-notes" class="form-textarea" rows="4" placeholder="Explain what facts need corroboration, missing sources, or stylistic adjustments..."></textarea>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
            <button type="button" class="btn btn-outline" id="modal-cancel-feedback">Cancel</button>
            <button type="button" class="btn btn-accent" id="modal-submit-feedback">Send Revision Request</button>
          </div>
        `,
        onRender: (modalBody, close) => {
          modalBody.querySelector('#modal-cancel-feedback').addEventListener('click', close);
          modalBody.querySelector('#modal-submit-feedback').addEventListener('click', async () => {
            const notes = modalBody.querySelector('#modal-feedback-notes').value.trim();
            if (!notes) {
              alert('Please enter revision guidance notes for the reporter.');
              return;
            }
            await performSave(container, false);
            const res = await apiAdapter.updateArticleStatus(currentStory.id, 'changes_requested', notes);
            currentStory = res.data;
            updateStatusDisplay(container);
            close();
            showToast('Changes requested. Story flagged for revisions.', 'info');
          });
        }
      });
    });
  }

  // Approve Story
  const approveBtn = actionWrapper.querySelector('#btn-approve-story');
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      await performSave(container, false);
      const res = await apiAdapter.updateArticleStatus(currentStory.id, 'approved', 'Editorial fact-check and dignity checks passed');
      currentStory = res.data;
      updateStatusDisplay(container);
      showToast('Story approved for publication!', 'success');
    });
  }

  // Publish Story
  const publishBtn = actionWrapper.querySelector('#btn-publish-story');
  if (publishBtn) {
    publishBtn.addEventListener('click', async () => {
      const confirmed = confirm('Publish this story to the Church Times Nigeria live web feed now?');
      if (!confirmed) return;
      await performSave(container, false);
      const res = await apiAdapter.updateArticleStatus(currentStory.id, 'published', 'Published by Editor-in-Chief');
      currentStory = res.data;
      updateStatusDisplay(container);
      showToast('🚀 Story is now live and published!', 'success');
    });
  }
}

function updateStatusDisplay(container) {
  const badgeContainer = container.querySelector('#story-status-badge-container');
  if (badgeContainer) {
    badgeContainer.innerHTML = renderStatusBadge(currentStory.status);
  }

  const notesBanner = container.querySelector('#review-notes-banner');
  const notesText = container.querySelector('#review-notes-text');
  if (notesBanner && notesText) {
    if (currentStory.reviewNotes) {
      notesText.textContent = currentStory.reviewNotes;
      notesBanner.style.display = 'block';
    } else {
      notesBanner.style.display = 'none';
    }
  }

  const actionWrapper = container.querySelector('#workflow-action-buttons');
  if (actionWrapper) {
    actionWrapper.innerHTML = renderWorkflowButtons(currentStory, store.getCurrentUser());
    bindWorkflowActions(container);
  }
}

function triggerAutosave(container) {
  const dot = container.querySelector('#autosave-dot');
  const label = container.querySelector('#autosave-label');
  if (dot) dot.className = 'autosave-dot dirty';
  if (label) label.textContent = 'Unsaved changes...';

  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    if (dot) dot.className = 'autosave-dot dirty';
    if (label) label.textContent = 'Autosaving...';

    await performSave(container, true);

    if (dot) dot.className = 'autosave-dot';
    if (label) {
      const now = new Date();
      label.textContent = `Autosaved ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }
  }, 1200);
}

async function performSave(container, isAutosave = false) {
  const title = container.querySelector('#story-headline-input').value.trim();
  const standfirst = container.querySelector('#story-standfirst-input').value.trim();
  const category = container.querySelector('#story-category-select').value;
  const slug = container.querySelector('#story-slug-input').value.trim() || slugify(title);
  const body = container.querySelector('#story-body-input').value;

  const payload = {
    ...currentStory,
    title,
    standfirst,
    category,
    slug,
    body
  };

  const res = await apiAdapter.saveArticle(payload);
  currentStory = res.data;

  if (!isAutosave) {
    const dot = container.querySelector('#autosave-dot');
    const label = container.querySelector('#autosave-label');
    if (dot) dot.className = 'autosave-dot';
    if (label) label.textContent = 'All changes saved';
  }
}

function updatePreview(container) {
  const headline = container.querySelector('#story-headline-input').value;
  const standfirst = container.querySelector('#story-standfirst-input').value;
  const category = container.querySelector('#story-category-select').value;
  const body = container.querySelector('#story-body-input').value;

  const pCat = container.querySelector('#preview-category');
  const pHead = container.querySelector('#preview-headline');
  const pStand = container.querySelector('#preview-standfirst');
  const pBody = container.querySelector('#preview-body-content');
  const pImgBox = container.querySelector('#preview-image-box');

  if (pCat) pCat.textContent = getCategoryTitle(category);
  if (pHead) pHead.textContent = headline || 'Untitled Headline';
  if (pStand) pStand.textContent = standfirst || 'Lead summary will appear here.';
  if (pBody) pBody.innerHTML = formatBodyMarkdown(body || 'Story body will render here as you type...');

  if (pImgBox) {
    if (currentStory.featuredImage) {
      pImgBox.innerHTML = `
        <img src="${escapeHtml(currentStory.featuredImage.url)}" alt="${escapeHtml(currentStory.featuredImage.alt)}" class="preview-hero-img">
        <div class="preview-img-caption">
          ${escapeHtml(currentStory.featuredImage.caption || '')} · Credit: ${escapeHtml(currentStory.featuredImage.credit || '')}
        </div>
      `;
    } else {
      pImgBox.innerHTML = '';
    }
  }
}

function updateWordCount(container) {
  const body = container.querySelector('#story-body-input').value.trim();
  const words = body ? body.split(/\s+/).length : 0;
  const readTime = Math.ceil(words / 200);
  const badge = container.querySelector('#word-count-badge');
  if (badge) {
    badge.textContent = `${words} words · ${readTime} min read`;
  }
}

function renderStatusBadge(status) {
  const labels = {
    draft: 'Draft',
    in_review: 'In Review',
    changes_requested: 'Changes Requested',
    approved: 'Approved',
    published: 'Published'
  };
  return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

function renderWorkflowButtons(story, user) {
  if (!user) {
    return `<button type="button" class="btn btn-outline btn-sm" id="btn-editor-login-prompt">🔐 Sign in to Edit</button>`;
  }

  const status = story?.status || 'draft';
  let buttons = '';

  // Submit for Review: Reporter, Section Editor, EIC, Admin
  if (apiAdapter.hasPermission('story.submit_review') && (status === 'draft' || status === 'changes_requested')) {
    buttons += `<button type="button" class="btn btn-accent btn-sm" id="btn-submit-review">📤 Submit for Review</button>`;
  }

  // Request Changes: Section Editor, EIC, Admin
  if (apiAdapter.hasPermission('story.request_changes') && status === 'in_review') {
    buttons += `<button type="button" class="btn btn-danger btn-sm" id="btn-request-changes">✏️ Request Changes</button>`;
  }

  // Approve: Section Editor, EIC, Admin
  if (apiAdapter.hasPermission('story.approve') && status === 'in_review') {
    buttons += `<button type="button" class="btn btn-success btn-sm" id="btn-approve-story">✅ Approve Story</button>`;
  }

  // Publish: Editor-in-Chief, Admin, or Trusted-Publisher (for own story)
  const isAuthor = story?.author?.id === user?.id || story?.author?.email === user?.email;
  if (apiAdapter.hasPermission('story.publish', { isAuthor }) && (status === 'approved' || status === 'in_review')) {
    buttons += `<button type="button" class="btn btn-primary btn-sm" id="btn-publish-story" style="background-color: var(--color-forest-dark);">🚀 Publish Story</button>`;
  }

  return buttons;
}

function renderFeaturedImageContent(img) {
  if (img) {
    return `
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt)}" class="featured-image-thumb">
      <div class="featured-image-meta">
        <div style="font-weight: 600; font-size: 0.875rem;">${escapeHtml(img.title || 'Selected Image')}</div>
        <div class="form-group" style="margin-top: 0.25rem;">
          <input type="text" id="story-image-alt-input" class="form-input" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" placeholder="Accessible Alt text description..." value="${escapeHtml(img.alt || '')}">
        </div>
        <div class="form-group" style="margin-top: 0.25rem;">
          <input type="text" id="story-image-caption-input" class="form-input" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;" placeholder="Caption & Photo Credit..." value="${escapeHtml(img.caption || '')}">
        </div>
        <div style="display: flex; gap: 0.5rem; margin-top: 0.35rem;">
          <button type="button" class="btn btn-outline btn-sm" id="btn-choose-media">Change Image</button>
          <button type="button" class="btn btn-outline btn-sm" id="btn-remove-media" style="color: #DC2626;">Remove</button>
        </div>
      </div>
    `;
  }
  return `
    <div style="text-align: center; width: 100%; padding: 0.5rem;">
      <p style="font-size: 0.8125rem; color: var(--color-muted); margin-bottom: 0.5rem;">
        No featured photograph selected. Add a verified documentary image with rights clearance.
      </p>
      <button type="button" class="btn btn-secondary btn-sm" id="btn-choose-media">
        🖼️ Choose Photograph from Media Library
      </button>
    </div>
  `;
}

function applyFormatting(textarea, format) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  const selected = val.substring(start, end);

  let replacement = '';
  switch (format) {
    case 'bold':
      replacement = `**${selected || 'bold text'}**`;
      break;
    case 'italic':
      replacement = `*${selected || 'italic text'}*`;
      break;
    case 'h2':
      replacement = `\n\n## ${selected || 'Section Heading'}\n\n`;
      break;
    case 'h3':
      replacement = `\n\n### ${selected || 'Sub-heading'}\n\n`;
      break;
    case 'quote':
      replacement = `\n\n> "${selected || 'Important source quote or editorial pullquote'}"\n\n`;
      break;
    case 'list':
      replacement = `\n- ${selected || 'First item'}\n- Second item\n`;
      break;
    default:
      return;
  }

  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  textarea.focus();
  textarea.selectionStart = start + replacement.length;
  textarea.selectionEnd = start + replacement.length;
}

function formatBodyMarkdown(raw) {
  if (!raw) return '';
  const escaped = escapeHtml(raw);

  // Parse simple markdown headings, quotes, bold, italic
  return escaped
    .replace(/^### (.*$)/gim, '<h3 style="font-family: var(--font-serif); font-size: 1.25rem; margin: 1.25rem 0 0.5rem 0; color: var(--color-forest);">$1</h3>')
    .replace(/^## (.*$)/gim, '<h2 style="font-family: var(--font-serif); font-size: 1.45rem; margin: 1.5rem 0 0.5rem 0; color: var(--color-forest); border-bottom: 1px solid var(--color-rule-soft); padding-bottom: 0.25rem;">$1</h2>')
    .replace(/^\> "(.*)"$/gim, '<blockquote style="border-left: 3px solid var(--color-clay); padding-left: 1rem; font-style: italic; margin: 1rem 0; color: var(--color-ink-light); font-size: 1.2rem;">"$1"</blockquote>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/\n\n/g, '<p style="margin-bottom: 1rem;"></p>')
    .replace(/\n/g, '<br>');
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
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

function formatDate(iso) {
  if (!iso) return 'Today';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (e) {
    return 'Recently';
  }
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
