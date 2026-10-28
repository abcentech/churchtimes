import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
// Same-origin synthetic CMS (stubbed per test) and a synthetic GA4 ID: no real endpoint or measurement.
export default defineConfig({...existing,testDir:'./reader-main-tests',use:{...existing.use,baseURL:'http://127.0.0.1:6398/'},webServer:{command:'npm run dev -- --port 6398 --strictPort',url:'http://127.0.0.1:6398',reuseExistingServer:false,env:{VITE_PUBLIC_CMS_URL:'http://127.0.0.1:6398',VITE_PUBLIC_INDEXABLE:'true',VITE_PUBLIC_GA4_ID:'G-STUB0000'}}});
