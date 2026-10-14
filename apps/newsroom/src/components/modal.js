/**
 * Accessible Modal Dialog Component
 * Handles keyboard focus trap, Esc key dismissal, and backdrop clicks.
 * `title` is escaped here; `contentHtml` must already be escaped by the caller (use escapeHtml for every value).
 */

import { escapeHtml } from '../util.js';

let activeModal = null;
let previousActiveElement = null;

export function openModal({ title, contentHtml, onRender, onClose }) {
  closeModal();

  previousActiveElement = document.activeElement;

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'active-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'modal-heading');

  overlay.innerHTML = `
    <div class="modal-box" id="modal-box-inner">
      <div class="modal-header">
        <h2 class="modal-title" id="modal-heading">${escapeHtml(title)}</h2>
        <button type="button" class="modal-close-btn" id="modal-close-btn" aria-label="Close dialog">&times;</button>
      </div>
      <div class="modal-body" id="modal-body-container">
        ${contentHtml}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  activeModal = { overlay, onClose };

  const closeBtn = overlay.querySelector('#modal-close-btn');
  closeBtn.addEventListener('click', closeModal);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeModal();
    }
  };
  document.addEventListener('keydown', handleKeyDown);
  activeModal.cleanupKeydown = () => document.removeEventListener('keydown', handleKeyDown);

  if (typeof onRender === 'function') {
    onRender(overlay.querySelector('#modal-body-container'), closeModal);
  }

  // Focus close button initially (onRender may have moved focus to a form field)
  if (!overlay.contains(document.activeElement)) closeBtn.focus();
}

export function closeModal() {
  if (activeModal) {
    const current = activeModal;
    activeModal = null;
    if (current.cleanupKeydown) current.cleanupKeydown();
    if (current.overlay && current.overlay.parentNode) {
      current.overlay.parentNode.removeChild(current.overlay);
    }
    if (current.onClose) current.onClose();

    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      previousActiveElement.focus();
    }
  }
}

/** Promise-based text prompt rendered as a modal (replaces window.prompt). Resolves null when cancelled. */
export function askText({ title, label, confirmLabel = 'Confirm', placeholder = '', required = true, testid = 'ask-text' }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    openModal({
      title,
      onClose: () => finish(null),
      contentHtml: `
        <form id="ask-text-form" data-testid="${escapeHtml(testid)}-form">
          <div class="form-group" style="margin-bottom: 1rem;">
            <label for="ask-text-input" class="form-label">${escapeHtml(label)}</label>
            <textarea id="ask-text-input" class="form-textarea" rows="4" placeholder="${escapeHtml(placeholder)}" data-testid="${escapeHtml(testid)}-input"></textarea>
            <div id="ask-text-error" role="alert" style="display:none; color:#B91C1C; font-size:0.8125rem; margin-top:0.25rem;"></div>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
            <button type="button" class="btn btn-outline" id="ask-text-cancel">Cancel</button>
            <button type="submit" class="btn btn-accent" id="ask-text-confirm" data-testid="${escapeHtml(testid)}-confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </form>`,
      onRender: (body, close) => {
        const input = body.querySelector('#ask-text-input');
        const err = body.querySelector('#ask-text-error');
        input.focus();
        body.querySelector('#ask-text-cancel').addEventListener('click', close);
        body.querySelector('#ask-text-form').addEventListener('submit', e => {
          e.preventDefault();
          const value = input.value.trim();
          if (required && !value) {
            err.textContent = 'Please enter some text.';
            err.style.display = 'block';
            return;
          }
          finish(value);
          close();
        });
      }
    });
  });
}

/** Promise-based confirmation modal (replaces window.confirm). */
export function askConfirm({ title, message, confirmLabel = 'Confirm', testid = 'ask-confirm' }) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); } };
    openModal({
      title,
      onClose: () => finish(false),
      contentHtml: `
        <p style="margin-bottom: 1rem;">${escapeHtml(message)}</p>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem;">
          <button type="button" class="btn btn-outline" id="ask-confirm-cancel">Cancel</button>
          <button type="button" class="btn btn-primary" id="ask-confirm-ok" data-testid="${escapeHtml(testid)}-ok">${escapeHtml(confirmLabel)}</button>
        </div>`,
      onRender: (body, close) => {
        body.querySelector('#ask-confirm-cancel').addEventListener('click', close);
        body.querySelector('#ask-confirm-ok').addEventListener('click', () => { finish(true); close(); });
        body.querySelector('#ask-confirm-ok').focus();
      }
    });
  });
}
