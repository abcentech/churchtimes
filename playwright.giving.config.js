import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
// STUB contract harness for the Give page: the CMS giving API and Turnstile are routed in the browser; no network.
export default defineConfig({...existing,testDir:'./giving-tests',workers:2,use:{...existing.use,baseURL:'http://127.0.0.1:6293/'},webServer:{command:'npx vite --config giving-tests/vite.config.js --host 127.0.0.1 --port 6293 --strictPort',url:'http://127.0.0.1:6293',reuseExistingServer:false,env:{VITE_PUBLIC_GIVING_URL:'http://127.0.0.1:6293/api/public/giving',VITE_TURNSTILE_SITE_KEY:'synthetic-site-key'}}});
