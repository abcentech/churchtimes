/**
 * Pure URL guard for media returned by the CMS (no import.meta, so it is unit-testable in plain Node).
 *
 * Returns '' unless the URL is either root-relative (resolved against the CMS base) or an absolute http(s) URL on the
 * CMS origin. Protocol-relative (`//host`), backslash tricks (`/\host`, which browsers read as `//host`), control
 * characters and every non-http(s) scheme are rejected.
 *
 * @param {unknown} url value from the CMS
 * @param {string} cmsUrl CMS base URL without trailing slash; '' means "same origin as the page"
 * @param {string} [pageOrigin] origin of the page, used only when cmsUrl is ''
 */
export function resolveAssetUrl(url, cmsUrl = '', pageOrigin = '') {
  if (typeof url !== 'string' || !url) return '';
  if (/[\\\x00-\x1f\x7f\s]/.test(url)) return '';
  let cmsOrigin = '';
  if (cmsUrl) {
    try { cmsOrigin = new URL(cmsUrl).origin; } catch { return ''; }
  } else {
    cmsOrigin = pageOrigin || '';
  }

  if (url.startsWith('//')) return '';
  if (url.startsWith('/')) {
    if (!cmsUrl) return url;
    try {
      const resolved = new URL(`${cmsUrl}${url}`);
      return resolved.origin === cmsOrigin ? resolved.href : '';
    } catch { return ''; }
  }

  let parsed;
  try { parsed = new URL(url); } catch { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (!cmsOrigin || parsed.origin !== cmsOrigin) return '';
  return parsed.href;
}
