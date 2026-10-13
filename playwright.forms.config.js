import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({
  ...existing, testDir:'./forms-tests',
  use:{ ...existing.use, baseURL:'http://127.0.0.1:5175/' },
  webServer:{
    command:'npm run dev -- --port 5175 --strictPort',
    url:'http://127.0.0.1:5175',reuseExistingServer:false,
    env:{ VITE_PUBLIC_SUBMISSIONS_URL:'http://127.0.0.1:5175/api/public/submissions',
      VITE_PUBLIC_CONTACT_URL:'http://127.0.0.1:5175/api/public/contact',
      VITE_TURNSTILE_SITE_KEY:'1x00000000000000000000AA' },
  },
});
