// Capture once, remove credentials before optional third-party code can run. Never persist the token.
export function captureNewsletterLink(location, history) {
  // Match the actual route suffix. A relative <base> on a static clean URL
  // can point at /newsletter/ instead of the deployment root. It is not a route authority.
  const action = location.pathname.startsWith('/') && location.pathname.match(/\/newsletter\/(confirm|unsubscribe)\/?$/)?.[1];
  if (!action) return null;
  const params = new URLSearchParams(location.search);
  const values = params.getAll('token');
  const token = values.length === 1 && values[0].length <= 4096 ? values[0] : '';
  history.replaceState(null, '', location.pathname);
  return { action, token };
}
