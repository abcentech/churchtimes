import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { buildCsp } from './csp.js';

// Standalone config for the staff newsroom SPA (`vite build apps/newsroom`).
// Build-time settings: VITE_CMS_URL (CMS base URL), optional VITE_PUBLIC_SITE_URL.
//
// The mock backend (demo accounts, role switcher) is a dev-server-only tool. A build in mock mode, or with the
// VITE_NEWSROOM_MOCK flag set, is refused outright rather than silently producing a bundle that merely ignores it.
export default defineConfig(({ command, mode }) => {
  if (command === 'build' && (mode === 'mock' || process.env.VITE_NEWSROOM_MOCK === '1')) {
    throw new Error(
      'Refusing to build the newsroom app in mock mode (mode=mock or VITE_NEWSROOM_MOCK=1). ' +
      'The mock backend exists only in the dev server; unset VITE_NEWSROOM_MOCK and build without --mode mock.'
    );
  }
  // Content-Security-Policy meta (index.html carries the placeholder). The CMS origin is the only cross-origin connection.
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  const cmsUrl = env.VITE_CMS_URL !== undefined && env.VITE_CMS_URL !== '' ? env.VITE_CMS_URL : (command === 'serve' ? 'http://localhost:3000' : '');
  const csp = buildCsp({ cmsUrl, dev: command === 'serve' });
  return {
    base: './',
    build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
    plugins: [{
      name: 'newsroom-csp',
      transformIndexHtml: html => html.replace('__NEWSROOM_CSP__', csp.replace(/"/g, '&quot;'))
    }]
  };
});
