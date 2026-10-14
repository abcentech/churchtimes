// Clean public-CMS URLs. The static edition retains its existing hash routes.
export function createPublicRoutes({ siteUrl, origin = 'http://localhost' } = {}) {
  const base = new URL(siteUrl || origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Public site URL must be an HTTPS base URL (loopback HTTP is allowed).');
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const path = (route, value = '') => {
    const segment = encodeURIComponent(value);
    const relative = route === 'report' ? `reports/${segment}/`
      : route === 'latest' ? 'reports/'
      : route === 'section' ? `sections/${segment}/`
      : route === 'search' ? `search/?q=${segment}` : '';
    return new URL(relative, base).pathname + (route === 'search' ? `?q=${segment}` : '');
  };
  function parse({ pathname, search = '' }) {
    if (!pathname.startsWith(base.pathname)) return null;
    const relative = pathname.slice(base.pathname.length).replace(/\/$/, '');
    let parts;
    try { parts = relative.split('/').map(decodeURIComponent); } catch { return ['404', '']; }
    if (parts.length === 1 && parts[0] === 'reports') return ['latest', ''];
    if (parts.length === 2 && parts[0] === 'reports') return ['report', parts[1]];
    if (parts.length === 2 && parts[0] === 'sections') return ['section', parts[1]];
    if (parts.length === 1 && parts[0] === 'search') return ['search', new URLSearchParams(search).get('q') || ''];
    return relative ? ['404', ''] : ['home', ''];
  }
  return { path, parse, basePath: base.pathname,
    canonical: (route, value) => new URL(path(route, value), base.origin).href,
  };
}
