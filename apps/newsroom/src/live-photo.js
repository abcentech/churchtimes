/**
 * Pure helpers for the optional photo on a live-coverage update (unit-testable in plain Node).
 * Every value is escaped; the image URL must pass `safeUrl` (the CMS asset-url guard: root-relative or same-CMS-origin
 * http(s)) or no <img> is produced at all.
 */
import { escapeHtml } from './util.js';

/**
 * @param {{ url?: string, thumbUrl?: string, alt?: string } | null | undefined} image normalised media view-model
 * @param {(url: string) => string} safeUrl returns '' for an unsafe URL
 * @returns {string} an <img> element, or '' when there is nothing safe to show
 */
export function livePhotoHtml(image, safeUrl, { testid = 'live-update-photo' } = {}) {
  if (!image || typeof safeUrl !== 'function') return '';
  const src = safeUrl(image.thumbUrl || image.url || '') || safeUrl(image.url || '');
  if (!src) return '';
  return `<img class="live-photo-thumb" data-testid="${escapeHtml(testid)}" src="${escapeHtml(src)}" alt="${escapeHtml(image.alt || '')}" loading="lazy">`;
}

/** The body of POST /api/live-updates (image is the media id, a number; omitted when there is no photo). */
export function liveUpdatePayload({ eventId, body, publishNow = false, imageId = null }) {
  const payload = { event: Number(eventId), body };
  if (publishNow) payload.status = 'approved';
  if (imageId !== null && imageId !== undefined && imageId !== '') payload.image = Number(imageId);
  return payload;
}
