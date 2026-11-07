import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';

const port=Number(process.env.PUBLIC_NEWSROOM_TEST_PORT || 5174),origin=`http://127.0.0.1:${port}`;
export default defineConfig({
  ...existing,
  testDir: './newsroom-tests',
  use: { ...existing.use, baseURL:origin+'/' },
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    env: { VITE_PUBLIC_CMS_URL:origin },
  },
});
