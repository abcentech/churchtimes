import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: './',
  plugins: [{
    name: 'churchtimes-source-entry',
    transformIndexHtml: {
      order: 'pre',
      handler: () => readFileSync(new URL('./src/index.template.html', import.meta.url), 'utf8'),
    },
  }],
}));
