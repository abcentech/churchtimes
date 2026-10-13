import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';

export default defineConfig({
  ...existing,
  testDir: './newsroom-tests',
  use: { ...existing.use, baseURL:'http://127.0.0.1:5174/' },
  webServer: {
    command: 'npm run dev -- --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
    env: { VITE_PUBLIC_CMS_URL:'http://127.0.0.1:5174' },
  },
});
