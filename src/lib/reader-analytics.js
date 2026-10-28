// IDs are public configuration; no identifier or transport exists when disabled.
export function analyticsConfig(env = {}) {
  return {
    enabled: env.VITE_PUBLIC_INDEXABLE === 'true' && /^G-[A-Z0-9]{4,20}$/.test(env.VITE_PUBLIC_GA4_ID || ''),
    id: env.VITE_PUBLIC_GA4_ID,
  };
}
const ROUTES = new Set(['home','about','contact','advertise','submit','saved','latest','live','section','story','category','report','search']);
// Reportable route: the pathname plus, for known hash routes, the route and (for slug routes) a plain slug.
// Search terms, tokens and unknown fragments are never included.
export function reportableRoute(location) {
  const base = location?.pathname || '/';
  let hash = '';
  try { hash = decodeURIComponent((location?.hash || '').slice(1)); } catch { return base; }
  const [route, slug] = hash.split('/');
  if (!ROUTES.has(route)) return base;
  const safeSlug = route !== 'search' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '') ? `/${slug}` : '';
  return `${base}#${route}${safeSlug}`;
}
export function reportableTitle(location, title) {
  return reportableRoute(location).endsWith('#search') ? 'Search — Church Times Nigeria' : title;
}
export function createAnalytics({ env = {}, window: win = globalThis.window, document: doc = globalThis.document, onReady } = {}) {
  const config = analyticsConfig(env);
  let loaded = false, ready = false;
  return {
    update(consented) {
      if (!config.enabled) return;
      win[`ga-disable-${config.id}`] = !consented;
      if (!consented) {
        for(const name of ['_ga', `_ga_${config.id.slice(2)}`]) {
          doc.cookie=`${name}=; Max-Age=0; path=/; SameSite=Lax`;
          const parts=win.location.hostname?.split('.')||[];
          for(let index=0;index<parts.length-1;index++)doc.cookie=`${name}=; Max-Age=0; path=/; domain=.${parts.slice(index).join('.')}; SameSite=Lax`;
        }
        return;
      }
      if (loaded) return;
      loaded = true;
      win.dataLayer = win.dataLayer || [];
      win.gtag = function() { win.dataLayer.push(arguments); };
      // Never send query strings (newsletter tokens) or automatic history events.
      win.gtag('js', new Date());
      win.gtag('config', config.id, { page_location: `${win.location.origin}${reportableRoute(win.location)}`, page_referrer: '', send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
      const script = doc.createElement('script');
      script.async = true; script.referrerPolicy = 'no-referrer';
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.id)}`;
      // With onReady the host decides when its page is complete enough to report (async routes); otherwise report at load.
      script.addEventListener('load', () => { ready=true; if (onReady) onReady(); else if (!win[`ga-disable-${config.id}`]) this.page(); }, { once: true });
      doc.head.append(script);
    },
    page() {
      if (!ready || win[`ga-disable-${config.id}`]) return;
      win.gtag('event','page_view',{ page_location: `${win.location.origin}${reportableRoute(win.location)}`, page_title: reportableTitle(win.location, doc.title) });
    },
  };
}
