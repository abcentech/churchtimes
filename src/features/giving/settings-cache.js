// Whether giving is on, from GET <VITE_PUBLIC_GIVING_URL>/settings. Kept in memory only (this page load, at most
// 10 minutes): the site writes nothing to localStorage or sessionStorage before the reader acts, so the ask must not.
import { givingEndpointFrom } from './endpoint.js';

const TTL = 10 * 60 * 1000;
let cached, pending;

export function givingEnabled(endpoint = givingEndpointFrom(import.meta.env.VITE_PUBLIC_GIVING_URL), now = Date.now()) {
  if (!endpoint) return Promise.resolve(false);
  if (cached && now - cached.at < TTL) return Promise.resolve(cached.enabled);
  return pending ||= fetch(`${endpoint}/settings`, { headers: { Accept: 'application/json' }, credentials: 'omit' })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      cached = { at: now, enabled: data?.enabled === true };
      return cached.enabled;
    })
    .catch(() => false)
    .finally(() => { pending = undefined; });
}
