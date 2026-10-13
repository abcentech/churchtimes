/**
 * Adapter selection. Production builds ALWAYS use the live CMS adapter: `MOCK` is a build-time constant that is
 * `false` outside the dev server, so the dynamic imports below (and the mock modules) are removed from the bundle.
 */
import { MOCK } from '../config.js';
import { CmsAdapter } from './cms.js';

let impl = null;
let devUi = null;

export async function initApi() {
  if (impl) return impl;
  if (MOCK) {
    const [{ MockAdapter }, ui] = await Promise.all([import('./mock.js'), import('./mock-ui.js')]);
    impl = new MockAdapter();
    devUi = ui;
  } else {
    impl = new CmsAdapter();
  }
  return impl;
}

/** Dev-only UI hooks (null in production). */
export function getDevUi() { return MOCK ? devUi : null; }

/** Stable facade so views can `import { api }` and call methods after initApi() has resolved. */
export const api = new Proxy({}, {
  get(_target, prop) {
    if (!impl) throw new Error('API used before initApi()');
    const value = impl[prop];
    return typeof value === 'function' ? value.bind(impl) : value;
  }
});
