/**
 * TEST FIXTURE ONLY. A verbatim copy of the validation rules of the public host's redirect loader
 * (`tools/public-redirects.mjs` on branch agent/wave2-public-redirects: `isJunkPath`, `allowedHostSet`,
 * `safeRedirectTarget`, `compileRedirectMap`), kept here because that file imports public-site modules that do not
 * exist on this branch. Only `canonicalDestination` (which needs the public site's route tables) is left out; the
 * trailing-slash part of it is reproduced by the CMS's canonical form itself.
 *
 * It exists so the CMS tests can run every rule the CMS emits through the host's own rules: one rejected rule makes the
 * host reject the WHOLE list. If the host's rules change, update this copy. Nothing here is used at runtime.
 */

const LS_PS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\u0000-\\u0020\\u007f-\\u009f${LS_PS}]`);
const DECODED_CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${LS_PS}]`);

export const MAX_REDIRECT_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECT_RULES = 20000;

export function isJunkPath(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || CONTROL.test(value) || value.includes('\\')) return true;
  const path = value.split('?')[0];
  if (path.length > 2048 || /%(?:2f|5c|25)/i.test(path)) return true;
  let decoded;
  try { decoded = decodeURIComponent(path); if (DECODED_CONTROL.test(decodeURIComponent(value.slice(path.length)))) return true; } catch { return true; }
  return DECODED_CONTROL.test(decoded) || decoded.includes('\\') || decoded.includes('//') || /(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(decoded)
    || /(?:^|\/)(?:tel|mailto|javascript|data|https?):/i.test(decoded) || decoded.includes('#');
}

function allowedHostSet(value = []) {
  const values = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim()).filter(Boolean);
  return new Set(values.map(host => {
    if (typeof host !== 'string' || !host || /[\s/@?#\\]/.test(host)) throw new Error('Invalid redirect host allowlist');
    const url = new URL('https://' + host);
    if (url.host !== host.toLowerCase() || url.pathname !== '/' || url.username || url.password) throw new Error('Invalid redirect host allowlist');
    return url.host;
  }));
}

export function safeRedirectTarget(value, { allowedHosts = [] } = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048 || CONTROL.test(value) || value.includes('\\') || value.includes('#')) throw new Error('Invalid redirect destination');
  const hosts = allowedHosts instanceof Set ? allowedHosts : allowedHostSet(allowedHosts);
  if (value.startsWith('/')) {
    if (isJunkPath(value)) throw new Error('Invalid redirect destination');
    const url = new URL(value, 'https://public.invalid');
    return url.pathname + url.search;
  }
  if (!/^https:\/\//.test(value) || /%(?:2f|5c|25)/i.test(value)) throw new Error('Invalid redirect destination');
  const url = new URL(value);
  const remainder = value.match(/^https:\/\/[^/?#]+(.*)$/)?.[1] || '/';
  const rawPath = remainder.startsWith('?') ? '/' + remainder : remainder;
  if (url.username || url.password || !hosts.has(url.host) || isJunkPath(rawPath)) throw new Error('Invalid redirect destination');
  return url.href;
}

function targetPath(to, siteUrl) {
  if (to.startsWith('/')) return to.split('?')[0];
  if (siteUrl && new URL(to).origin === new URL(siteUrl).origin) return new URL(to).pathname;
  return null;
}

/** Atomic: one bad row rejects the entire list (throws). `siteUrl` is the host's PUBLIC_SITE_URL. */
export function compileRedirectMap(data, { allowedHosts = [], siteUrl } = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.rules) || data.rules.length > MAX_REDIRECT_RULES
    || data.count !== data.rules.length || typeof data.version !== 'string' || !/^sha256:[a-zA-Z0-9_-]{1,128}$/.test(data.version)
    || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))) throw new Error('Invalid redirect map');
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_REDIRECT_BYTES) throw new Error('Redirect map exceeds size cap');
  const hosts = allowedHostSet(allowedHosts);
  const rules = new Map();
  for (const row of data.rules) {
    if (!row || typeof row.from !== 'string' || row.from.length > 300 || row.from.includes('?') || isJunkPath(row.from)
      || ![301, 302, 410].includes(row.status) || !['manual', 'rank-math', 'legacy-url'].includes(row.source) || rules.has(row.from)) throw new Error('Invalid redirect rule');
    const to = row.status === 410 ? null : safeRedirectTarget(row.to, { allowedHosts: hosts });
    if (row.status === 410 && row.to != null && row.to !== '') safeRedirectTarget(row.to, { allowedHosts: hosts });
    rules.set(row.from, { status: row.status, to });
  }
  for (const row of rules.values()) if (row.to && rules.has(targetPath(row.to, siteUrl))) throw new Error('Redirect loops and chains are forbidden');
  return rules;
}
