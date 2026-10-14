import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import { createPublicRoutes } from './src/lib/public-routes.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const basePath = env.VITE_PUBLIC_CMS_URL ? createPublicRoutes({ siteUrl: env.VITE_PUBLIC_SITE_URL }).basePath : '';
  return ({
  base: './',
  plugins: [{
    name: 'churchtimes-source-entry',
    transformIndexHtml: {
      order: 'pre',
      handler: (entry, ctx) => {
        if (/^\/(?:apps\/)?newsroom(?:\/|$)/.test(ctx?.path || '')) return entry;
        const html = readFileSync(new URL('./src/index.template.html', import.meta.url), 'utf8');
        // Relative build assets must resolve from the site root on fresh deep URLs.
        return basePath ? html.replace('<head>', `<head>\n    <base href="${basePath}">`) : html;
      },
    },
  }],
});
});
