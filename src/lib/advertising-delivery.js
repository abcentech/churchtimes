// C3 browser delivery; contract tests use a labelled synthetic endpoint stub.
import {createAdvertisingSlot, mountAdvertisingPlacements} from './advertising.js';
const empty = () => ({ campaigns: [], adsense: { enabled: false, reviewed: false } });
export function createAdvertisingDelivery({ endpoint = '', fetch: request = globalThis.fetch, now = Date.now, timeout = 1500 } = {}) {
  let cached, expires = 0, pending;
  const disabled={load:async()=>empty(),mount(root){root?.querySelectorAll('template[data-ad-placement]').forEach(marker=>marker.remove());}};
  let url;
  try { const parsed = new URL(endpoint, globalThis.location?.origin); if (!(parsed.protocol==='https:' || (parsed.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))) || parsed.username || parsed.password || parsed.search || parsed.hash) return disabled; url = parsed.href; } catch { return disabled; }
  if (!endpoint) return disabled;
  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),timeout);
    try {
      // Ordinary browser GET only: If-None-Match would trigger an unsupported
      // cross-origin preflight, and the CMS deliberately does not expose ETag.
      const response = await request(url,{ method:'GET', credentials:'omit', redirect:'error', signal:controller.signal });
      if (!response.ok || Number(response.headers.get('content-length')) > 1048576) throw new Error('Unavailable');
      const body = await response.text();
      if (body.length > 1048576) throw new Error('Too large');
      const data = JSON.parse(body);
      if (!Array.isArray(data.campaigns) || data.campaigns.length>100) throw new Error('Invalid');
      // No AdSense script or reviewed-unit adapter is ever supplied.
      cached = { campaigns:data.campaigns, adsense:{ enabled:false,reviewed:false } };
      const maxAge = response.headers.get('cache-control')?.match(/(?:^|,)\s*max-age=(\d+)(?:\s*(?:,|$))/i);
      const received = now();
      let duration = Math.min(60000, maxAge ? Number(maxAge[1])*1000 : 60000);
      for (const campaign of cached.campaigns) {
        for (const date of [campaign?.startsAt,campaign?.endsAt]) {
          const boundary = Date.parse(date);
          if (Number.isFinite(boundary) && boundary > received) duration = Math.min(duration,boundary-received);
        }
      }
      expires=received+duration; return cached;
    } catch { cached=undefined; expires=now()+10000; return empty(); }
    finally { clearTimeout(timer); }
  }
  const delivery = {
    load() { if(now()<expires) return Promise.resolve(cached || empty()); if(!pending) pending=refresh().finally(()=>{pending=undefined;}); return pending; },
    mount(root, options = {}) {
      const {signal} = options;
      if (!root?.isConnected || signal?.aborted) return;
      // A fresh, validated snapshot can reserve the fixed creative dimensions
      // synchronously while the new route is being assembled.
      if (cached && now()<expires) { mountAdvertisingPlacements(root,cached,{...options,now:now()}); return; }
      const markers = [...root.querySelectorAll('template[data-ad-placement]')].map(template => {
        const marker=root.ownerDocument.createElement('span');
        marker.dataset.pendingAdPlacement=template.dataset.adPlacement;
        marker.setAttribute('aria-hidden','true');
        marker.style.cssText='display:block;height:0;margin:0;padding:0;border:0;';
        template.replaceWith(marker); return marker;
      });
      if (!markers.length) return;
      return delivery.load().then(config => {
        if (signal?.aborted || !root.isConnected) return;
        for (const marker of markers) {
          if (!marker.isConnected || !root.contains(marker)) continue;
          const slot=createAdvertisingSlot(marker.dataset.pendingAdPlacement,config,{...options,now:now()});
          // Never push already-visible editorial content down to insert a late
          // ad. Below-viewport slots can safely reserve their known dimensions;
          // an on-screen/previously-passed opportunity is skipped for this view.
          if (slot && marker.getBoundingClientRect().top >= root.ownerDocument.defaultView.innerHeight) marker.replaceWith(slot);
          else marker.remove();
        }
      });
    },
  };
  return delivery;
}
