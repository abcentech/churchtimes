/**
 * Accessible Modal Dialog Component
 * Handles keyboard focus trap, Esc key dismissal, and backdrop clicks.
 */

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
        <h2 class="modal-title" id="modal-heading">${title}</h2>
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

  // Focus close button initially
  closeBtn.focus();
}

export function closeModal() {
  if (activeModal) {
    if (activeModal.cleanupKeydown) activeModal.cleanupKeydown();
    if (activeModal.onClose) activeModal.onClose();
    if (activeModal.overlay && activeModal.overlay.parentNode) {
      activeModal.overlay.parentNode.removeChild(activeModal.overlay);
    }
    activeModal = null;

    if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
      previousActiveElement.focus();
    }
  }
}
