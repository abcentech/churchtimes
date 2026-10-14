import { showToast } from './toast.js';

/**
 * Show a failed CMS call to the user. The message is the server's own message (rendered with textContent).
 * 401 is handled centrally (back to the login screen), so no extra toast is shown for it.
 * Returns the message so callers can also place it in an inline alert.
 */
export function showApiError(err, prefix = '') {
  const message = err?.message || 'Something went wrong.';
  if (err?.status === 401) return message;
  showToast(`${prefix}${message}`, 'error', 6500);
  return message;
}
