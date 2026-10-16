// C3 endpoint is proposed: tests use a labelled synthetic stub, not live CMS.
const empty = () => ({ campaigns: [], adsense: { enabled: false, reviewed: false } });
export function createAdvertisingDelivery({ endpoint = '', fetch: request = globalThis.fetch, now = Date.now, timeout = 1500 } = {}) {
  let cached, etag, expires = 0, pending;
  let url;
  try { const parsed = new URL(endpoint, globalThis.location?.origin); if (!(parsed.protocol==='https:' || (parsed.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(parsed.hostname))) || parsed.username || parsed.password || parsed.search || parsed.hash) return { load: async () => empty() }; url = parsed.href; } catch { return { load: async () => empty() }; }
  if (!endpoint) return { load: async () => empty() };
  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),timeout);
    try {
      const response = await request(url,{ credentials:'omit', signal:controller.signal, headers:etag?{'If-None-Match':etag}:{} });
      if (response.status === 304 && cached) { expires = now()+60000; return cached; }
      if (!response.ok || Number(response.headers.get('content-length')) > 1048576) throw new Error('Unavailable');
      const body = await response.text();
      if (body.length > 1048576) throw new Error('Too large');
      const data = JSON.parse(body);
      if (!Array.isArray(data.campaigns) || data.campaigns.length>100) throw new Error('Invalid');
      // No AdSense script or reviewed-unit adapter is ever supplied.
      cached = { campaigns:data.campaigns, adsense:{ enabled:false,reviewed:false } };
      etag = response.headers.get('etag'); expires=now()+60000; return cached;
    } catch { cached=undefined; etag=undefined; expires=now()+10000; return empty(); }
    finally { clearTimeout(timer); }
  }
  return { load() { if(now()<expires) return Promise.resolve(cached || empty()); if(!pending) pending=refresh().finally(()=>{pending=undefined;}); return pending; } };
}
