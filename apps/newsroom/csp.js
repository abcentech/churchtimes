/**
 * Content-Security-Policy for the staff newsroom SPA, injected into index.html as a meta tag at build and in the dev server.
 *
 * - No inline scripts, no eval, no plugins, no <base>. All scripts come from the app's own origin.
 * - connect-src is the app origin plus the CMS origin (VITE_CMS_URL; empty means the CMS is proxied under /api on the same origin).
 * - img-src allows https: because staff-uploaded media and a CMS on another origin are shown as images; the CMS origin is added
 *   explicitly so an http CMS in local development still works.
 * - style-src keeps 'unsafe-inline' because the views set inline style attributes; scripts are the part that matters here.
 * - Dev only: the Vite dev server's HMR websocket (ws:) and the dev CMS origin.
 * - frame-ancestors is ignored in a meta tag, so it is NOT here. The web server must send it as a response header
 *   (apps/cms/docs/security.md, "Newsroom CSP and archive link review").
 */
export function cmsOrigin(cmsUrl) {
  if (!cmsUrl) return '';
  try {
    const u = new URL(cmsUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : '';
  } catch {
    return '';
  }
}

export function buildCsp({ cmsUrl = '', dev = false } = {}) {
  const cms = cmsOrigin(cmsUrl);
  const connect = ["'self'", cms, dev ? 'ws:' : ''].filter(Boolean).join(' ');
  const img = ["'self'", 'data:', 'https:', cms.startsWith('http:') ? cms : ''].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `connect-src ${connect}`,
    `img-src ${img}`
  ].join('; ');
}
