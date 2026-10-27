// HTTP development endpoints are allowed only on reserved loopback names.
export const isLoopbackHostname = hostname => ['localhost','127.0.0.1','[::1]'].includes(hostname) || hostname.endsWith('.localhost');
export function publicOrigin(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHostname(url.hostname)))) return '';
    return url.origin;
  } catch { return ''; }
}
