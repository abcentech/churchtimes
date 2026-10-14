/**
 * Build-time configuration for the staff newsroom SPA.
 *
 * - MOCK is true ONLY in a Vite dev server started with VITE_NEWSROOM_MOCK=1 (e.g. `vite --mode mock`).
 *   `import.meta.env.DEV` is replaced by the literal `false` in production builds, so every branch guarded by
 *   `if (MOCK)` (and the dynamic imports inside it) is removed from the bundle.
 * - CMS_URL comes from VITE_CMS_URL at BUILD time. There is no user-editable backend URL.
 *   Empty string means "same origin" (the CMS is reverse-proxied under /api).
 */
import { resolveAssetUrl } from './asset-url.js';

export const MOCK = import.meta.env.DEV && import.meta.env.VITE_NEWSROOM_MOCK === '1';

const rawCmsUrl = import.meta.env.VITE_CMS_URL || (import.meta.env.DEV ? 'http://localhost:3000' : '');
export const CMS_URL = String(rawCmsUrl).replace(/\/+$/, '');

// Optional link target for the public tip form (the form itself lives on the public site).
export const PUBLIC_SITE_URL = String(import.meta.env.VITE_PUBLIC_SITE_URL || '').replace(/\/+$/, '');

export const CMS_HOST_LABEL = (() => {
  if (!CMS_URL) return 'same origin';
  try { return new URL(CMS_URL).host; } catch { return 'configured CMS'; }
})();

/** Absolute URL for media returned by the CMS: root-relative or same CMS origin over http(s); anything else is ''. */
export function cmsAssetUrl(url) {
  return resolveAssetUrl(url, CMS_URL, typeof location === 'undefined' ? '' : location.origin);
}
