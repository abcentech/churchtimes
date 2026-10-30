import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
// W12 reader furniture, author and trust pages against a same-origin synthetic CMS (stubbed per test; no real endpoint).
export default defineConfig({...existing,testDir:'./reader-trust-tests',use:{...existing.use,baseURL:'http://127.0.0.1:6402/'},webServer:{command:'npm run dev -- --port 6402 --strictPort',url:'http://127.0.0.1:6402',reuseExistingServer:false,env:{VITE_PUBLIC_CMS_URL:'http://127.0.0.1:6402',VITE_PUBLIC_SITE_URL:'https://public.example.test',VITE_PUBLIC_INDEXABLE:'false'}}});
