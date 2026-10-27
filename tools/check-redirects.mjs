// Read-only cutover smoke. Explicit target required; never defaults to production.
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {isJunkPath, MAX_REDIRECT_BYTES, safeRedirectTarget} from './public-redirects.mjs';
import {publicOrigin} from '../src/lib/public-url.js';

function titleText(html) {
  const value = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '';
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos|nbsp);/gi, (_all, numeric, name) => {
    if (name) return named[name.toLowerCase()];
    const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).replace(/\s+/g, ' ').trim();
}

export function readRedirectChecks(input) {
  if (Buffer.byteLength(input) > MAX_REDIRECT_BYTES) throw new Error('Check input exceeds 5 MB');
  const trimmed = input.trim();
  let rows;
  if (trimmed.startsWith('[')) rows = JSON.parse(trimmed);
  else rows = trimmed.split(/\r?\n/).filter(Boolean);
  if (!Array.isArray(rows) || !rows.length || rows.length > 20000) throw new Error('Expected 1–20000 check paths');
  return rows.map(row => {
    const data = typeof row === 'string' ? {path: row} : row;
    if (!data || isJunkPath(data.path) || data.path.includes('#')) throw new Error('Expected root-relative check paths');
    if (data.expectedStatus != null && ![200, 301, 302, 404, 410].includes(data.expectedStatus)) throw new Error('Invalid expected status');
    if (data.expectedTitle != null && (typeof data.expectedTitle !== 'string' || !data.expectedTitle.trim() || data.expectedTitle.length > 1000)) throw new Error('Invalid expected title');
    return {path: data.path, expectedStatus: data.expectedStatus, expectedTitle: data.expectedTitle?.replace(/\s+/g, ' ').trim()};
  });
}

async function boundedHTML(response) {
  if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('HTML exceeds size cap');
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers.get('content-type') || '') || !response.body) return '';
  const chunks = []; let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('HTML exceeds size cap');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks).toString('utf8');
}

/** Results contain row numbers and metrics only, never paths, titles or tokens. */
export async function checkRedirects({target, checks, rate = 2, allowedHosts = [], fetchImpl = fetch, wait = pause, now = Date.now} = {}) {
  if (!target || !publicOrigin(target)) throw new Error('An explicit HTTPS or loopback HTTP --target is required');
  const origin = new URL(target);
  if (origin.search || origin.hash || origin.pathname !== '/') throw new Error('--target must be an origin without a path, query or fragment');
  if (!Number.isFinite(rate) || rate < 0.1 || rate > 10) throw new Error('--rate must be between 0.1 and 10 requests per second');
  // Validate allowlist before any network call.
  for (const host of allowedHosts) safeRedirectTarget('https://' + host + '/', {allowedHosts});
  const results = []; let nextStart = 0;
  async function request(url) {
    await wait(Math.max(0, nextStart - now()));
    nextStart = now() + 1000 / rate;
    return fetchImpl(url, {redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(10000), headers: {'User-Agent': 'ChurchTimesCutoverCheck/1.0'}});
  }
  for (const [index, row] of checks.entries()) {
    const result = {row: index + 1, status: 0, finalStatus: 0, hops: 0, titleMatches: false, ok: false};
    let response;
    try {
      if (isJunkPath(row.path)) throw new Error('Invalid check path');
      response = await request(new URL(row.path, origin));
      result.status = response.status;
      if ([301, 302].includes(response.status)) {
        const location = response.headers.get('location');
        // Only root-relative paths and explicit HTTPS hosts may be followed.
        const destination = safeRedirectTarget(location, {allowedHosts: [...allowedHosts, origin.host]});
        const next = new URL(destination, origin);
        if (next.origin !== origin.origin && !allowedHosts.includes(next.host)) throw new Error('Unapproved redirect host');
        if (next.href === new URL(row.path, origin).href) throw new Error('Redirect loop');
        await response.body?.cancel();
        response = await request(next); result.hops = 1;
      }
      result.finalStatus = response.status;
      if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error('More than one hop');
      const title = response.status === 200 ? titleText(await boundedHTML(response)) : '';
      if (response.status !== 200) await response.body?.cancel();
      result.titleMatches = row.expectedTitle ? title === row.expectedTitle : Boolean(title);
      const statusMatches = row.expectedStatus == null ? [200, 301, 302, 410].includes(result.status) : row.expectedStatus === result.status;
      const finalMatches = result.finalStatus === 200 ? result.titleMatches : row.expectedTitle == null && (result.finalStatus === 410 || (result.finalStatus === 404 && row.expectedStatus === result.status));
      result.ok = statusMatches && finalMatches;
    } catch { /* Private URLs and response bodies must never reach CI logs. */ }
    finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
    results.push(result);
  }
  return {total: results.length, passed: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length, results};
}

export async function redirectCheckCLI(args = process.argv.slice(2), {output = console.log, errors = console.error} = {}) {
  try {
    const options = {allowedHosts: []}; let urls, quiet = false;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (flag === '--quiet') { quiet = true; continue; }
      if (!['--target', '--urls', '--rate', '--allow-host'].includes(flag) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Invalid arguments');
      const value = args[++index];
      if (flag === '--target') options.target = value;
      if (flag === '--urls') urls = value;
      if (flag === '--rate') options.rate = Number(value);
      if (flag === '--allow-host') options.allowedHosts.push(value);
    }
    if (!options.target || !publicOrigin(options.target) || !urls) throw new Error('Explicit --target and --urls are required');
    options.checks = readRedirectChecks(await readFile(urls, 'utf8'));
    const summary = await checkRedirects(options);
    if (!quiet) for (const result of summary.results) output(JSON.stringify(result));
    output(JSON.stringify({total: summary.total, passed: summary.passed, failed: summary.failed}));
    return summary.failed ? 1 : 0;
  } catch { errors('Redirect check refused or could not complete. Supply explicit --target <origin> --urls <private-file>; no addresses are logged.'); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await redirectCheckCLI();
