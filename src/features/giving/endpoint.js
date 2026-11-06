import { publicOrigin } from '../../lib/public-url.js';

/** `VITE_PUBLIC_GIVING_URL` (e.g. https://cms.example.org/api/public/giving): https or loopback http, no query or fragment. */
export function givingEndpointFrom(value) {
  if (!value || !publicOrigin(value)) return '';
  try {
    const url = new URL(value);
    return url.search || url.hash ? '' : url.href.replace(/\/+$/, '');
  } catch { return ''; }
}
