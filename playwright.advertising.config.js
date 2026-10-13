import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({
  ...existing,testDir:'./advertising-tests',
  use:{...existing.use,baseURL:'http://127.0.0.1:5176/'},
  webServer:{command:'npm run dev -- --port 5176 --strictPort',url:'http://127.0.0.1:5176',reuseExistingServer:false},
});
