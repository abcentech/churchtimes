// IDs are public configuration; no identifier or transport exists when disabled.
export function analyticsConfig(env = {}) {
  return {
    enabled: env.VITE_PUBLIC_INDEXABLE === 'true' && /^G-[A-Z0-9]{4,20}$/.test(env.VITE_PUBLIC_GA4_ID || ''),
    id: env.VITE_PUBLIC_GA4_ID,
  };
}
export function createAnalytics({ env = {}, window: win = globalThis.window, document: doc = globalThis.document } = {}) {
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
      win.gtag('config', config.id, { page_location: `${win.location.origin}${win.location.pathname}`, page_referrer: '', send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false });
      const script = doc.createElement('script');
      script.async = true; script.referrerPolicy = 'no-referrer';
      script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(config.id)}`;
      script.addEventListener('load', () => { ready=true; if (!win[`ga-disable-${config.id}`]) this.page(); }, { once: true });
      doc.head.append(script);
    },
    page() {
      if (!ready || win[`ga-disable-${config.id}`]) return;
      win.gtag('event','page_view',{ page_location: `${win.location.origin}${win.location.pathname}`, page_title: doc.title });
    },
  };
}
