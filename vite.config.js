import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [{
    name: 'churchtimes-source-entry',
    transformIndexHtml: {
      order: 'pre',
      handler: (html, ctx) => {
        if (ctx?.path && ctx.path.includes('newsroom')) {
          return html;
        }
        return readFileSync(new URL('./src/index.template.html', import.meta.url), 'utf8');
      },
    },
  }],
}));

