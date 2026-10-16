import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({...existing,testDir:'./reader-forms-tests',workers:2,use:{...existing.use,baseURL:'http://127.0.0.1:6192/'},webServer:{command:'npm run dev -- --port 6192 --strictPort',url:'http://127.0.0.1:6192',reuseExistingServer:false}});
