import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({...existing,testDir:'./reader-integration-tests',use:{...existing.use,baseURL:'http://127.0.0.1:6396/'},webServer:{command:'npm run dev -- --port 6396 --strictPort',url:'http://127.0.0.1:6396',reuseExistingServer:false,env:{VITE_PUBLIC_CMS_URL:'http://127.0.0.1:6396',VITE_PUBLIC_COMMENTS_URL:'http://127.0.0.1:6396/api/legacy-comments',VITE_PUBLIC_ONESIGNAL_APP_ID:'11111111-1111-4111-8111-111111111111',VITE_PUBLIC_INDEXABLE:'false'}}});
// CMS, comments and provider UUID above are synthetic STUB fixtures; no real endpoint or push application.
