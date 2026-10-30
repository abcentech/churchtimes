// Whether giving is on, from GET <VITE_PUBLIC_GIVING_URL>/settings, cached for 10 minutes in this tab.
import { givingEndpointFrom } from './endpoint.js';

const KEY = 'ct-give-enabled';
const TTL = 10 * 60 * 1000;
let pending;

export function givingEnabled(endpoint = givingEndpointFrom(import.meta.env.VITE_PUBLIC_GIVING_URL), now = Date.now()) {
  if (!endpoint) return Promise.resolve(false);
  try {
    const cached = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (cached && now - cached.at < TTL && typeof cached.enabled === 'boolean') return Promise.resolve(cached.enabled);
  } catch {}
  return pending ||= fetch(`${endpoint}/settings`, { headers: { Accept: 'application/json' }, credentials: 'omit' })
    .then(r => (r.ok ? r.json() : null))
    .then(data => {
      const enabled = data?.enabled === true;
      try { sessionStorage.setItem(KEY, JSON.stringify({ at: now, enabled })); } catch {}
      return enabled;
    })
    .catch(() => false)
    .finally(() => { pending = undefined; });
}
