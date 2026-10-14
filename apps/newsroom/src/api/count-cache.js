/**
 * Short-lived cache for the per-status article counts (dashboard metrics and the nav review badge).
 *
 * - Concurrent callers share one in-flight load: the dashboard and the route badge update ask at the same time.
 * - A successful result is reused for `ttlMs` only. A failed load is never cached.
 * - invalidate() drops the entry. The CMS adapter calls it after every article write it makes, so the user's own
 *   changes show on the next read. A load already in flight keeps serving the callers that joined it, but nothing
 *   started after invalidate() reuses it.
 *
 * Server totals stay the source of truth: this only avoids repeating identical requests inside a short window.
 * Changes made by other staff, or by the scheduler, appear once the window expires.
 */

export const ARTICLE_COUNTS_TTL_MS = 15000;

export function createCountCache({ ttlMs = ARTICLE_COUNTS_TTL_MS, now = () => Date.now() } = {}) {
  let entry = null; // { promise, done, expires }

  return {
    /** Returns the shared promise for `load()`, starting it only when there is no fresh or in-flight entry. */
    get(load) {
      if (entry && (!entry.done || entry.expires > now())) return entry.promise;
      const current = { promise: null, done: false, expires: 0 };
      current.promise = Promise.resolve()
        .then(load)
        .then(
          value => {
            if (entry === current) {
              current.done = true;
              current.expires = now() + ttlMs;
            }
            return value;
          },
          err => {
            if (entry === current) entry = null;
            throw err;
          }
        );
      entry = current;
      return current.promise;
    },

    /** Forget any cached or in-flight result. The next get() makes a fresh request. */
    invalidate() {
      entry = null;
    }
  };
}
