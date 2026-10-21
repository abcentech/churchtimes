import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({...existing,testDir:'./reader-shell-tests',use:{...existing.use,baseURL:'http://127.0.0.1:6198/'},webServer:{command:'npm run build && node tools/test-reader-shell.mjs',url:'http://127.0.0.1:6198/',reuseExistingServer:false,env:{VITE_PUBLIC_NEWSLETTER_URL:'http://127.0.0.1:6198/api/public/newsletter/subscribe',VITE_PUBLIC_GA4_ID:'',VITE_PUBLIC_INDEXABLE:'false'}}});
