import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';
const cmsUrl = process.env.PUBLIC_CMS_TEST_URL || 'http://127.0.0.1:3201';
export default defineConfig({
  ...existing,testDir:'./cms-integration-tests',fullyParallel:false,workers:1,
  use:{...existing.use,baseURL:'http://127.0.0.1:5177/'},
  webServer:{command:'npm run dev -- --port 5177 --strictPort',url:'http://127.0.0.1:5177',reuseExistingServer:false,
    env:{VITE_PUBLIC_CMS_URL:cmsUrl,VITE_PUBLIC_SUBMISSIONS_URL:cmsUrl+'/api/public/submissions',
      VITE_PUBLIC_CONTACT_URL:'',VITE_TURNSTILE_SITE_KEY:'1x00000000000000000000AA',VITE_TURNSTILE_ACTION:'submit-story'},
  },
});
