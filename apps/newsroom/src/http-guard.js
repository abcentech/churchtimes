/** Request timeout helper and connectivity state. Pure (timers and fetch injectable) so it runs in plain Node. */

export class RequestTimeoutError extends Error {
  constructor(ms) { super(`Request timed out after ${ms} ms`); this.name = 'RequestTimeoutError'; }
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

export function timeoutFor({ form } = {}) { return form ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS; }

/** Run `run(signal)`; abort the signal and reject with RequestTimeoutError when it takes longer than `ms`. */
export async function withTimeout(ms, run, { setT = setTimeout, clearT = clearTimeout } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setT(() => { timedOut = true; controller.abort(); }, ms);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (timedOut) throw new RequestTimeoutError(ms);
    throw err;
  } finally {
    clearT(timer);
  }
}

/** Online = the browser says online AND the last CMS call did not fail at the network level. */
export function createConnectionState(onChange = () => {}, browserOnline = true) {
  let failed = false;
  let browser = browserOnline;
  let last = browser && !failed;
  const update = () => {
    const now = browser && !failed;
    if (now !== last) { last = now; onChange(now); }
  };
  return {
    isOnline: () => last,
    reportFailure() { failed = true; update(); },
    reportSuccess() { failed = false; update(); },
    setBrowserOnline(v) { browser = Boolean(v); if (browser) failed = false; update(); }
  };
}

/** Text for the live-feed stale indicator, or '' while the feed is fresh. */
export function liveStaleMessage(lastOkAt, failing) {
  if (!failing) return '';
  const when = lastOkAt ? new Date(lastOkAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : null;
  return when
    ? `Live feed may be out of date: could not refresh since ${when}. Retrying automatically.`
    : 'Live feed could not be loaded. Retrying automatically.';
}

/** Keep-alive: refresh the session while the user is active. */
export const REFRESH_EVERY_MS = 30 * 60 * 1000;
export function shouldRefreshSession({ now, lastActivity, lastRefresh, everyMs = REFRESH_EVERY_MS }) {
  if (now - lastRefresh < everyMs) return false;
  return now - lastActivity < everyMs; // only while the user has been active within the window
}
