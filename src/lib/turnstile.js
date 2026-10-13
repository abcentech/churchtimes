const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading;

function loadTurnstile() {
  if (window.turnstile?.render) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    const timer = setTimeout(() => fail(), 15000);
    function fail() {
      clearTimeout(timer);
      script.remove();
      loading = undefined;
      reject(new Error('Turnstile could not load'));
    }
    script.onerror = fail;
    script.onload = () => {
      clearTimeout(timer);
      if (window.turnstile?.render) resolve(window.turnstile);
      else fail();
    };
    document.head.append(script);
  });
  return loading;
}

export function mountTurnstile(container, { siteKey, action, onToken, onExpired, onError, onReady }) {
  let disposed = false;
  let widget;
  let api;
  let size;
  async function start() {
    try {
      api = await loadTurnstile();
      if (disposed || !container.isConnected) return;
      size = container.clientWidth < 300 ? 'compact' : 'flexible';
      widget = api.render(container, {
        sitekey: siteKey, action, size, theme: 'light',
        'response-field': false, retry: 'never', 'refresh-expired': 'manual',
        callback: token => { if (!disposed) onToken(token); },
        'expired-callback': () => { if (!disposed) onExpired(); },
        'timeout-callback': () => { if (!disposed) onExpired(); },
        'error-callback': () => { if (!disposed) onError(); return true; },
      });
      onReady?.();
    } catch { if (!disposed) onError(); }
  }
  // Turnstile's flexible layout has a 300px minimum. Recreate the challenge
  // when a narrow viewport needs compact mode, invalidating the old token.
  const observer = new ResizeObserver(() => {
    if (disposed || widget === undefined || !api) return;
    const nextSize = container.clientWidth < 300 ? 'compact' : 'flexible';
    if (nextSize === size) return;
    onExpired();
    try { api.remove(widget); widget = undefined; start(); } catch { onError(); }
  });
  observer.observe(container);
  start();
  return {
    reset() {
      if (disposed) return;
      if (widget !== undefined && api) {
        try { api.reset(widget); onReady?.(); } catch { onError(); }
      } else start();
    },
    dispose() {
      disposed = true;
      observer.disconnect();
      if (widget !== undefined && api) {
        try { api.remove(widget); } catch { /* Navigation must still work. */ }
      }
    },
  };
}
