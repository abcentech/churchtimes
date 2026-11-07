import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({...existing,testDir:'./comments-tests',workers:2,use:{...existing.use,baseURL:'http://127.0.0.1:6194/'},webServer:{command:'npx vite --config comments-tests/vite.config.js --host 127.0.0.1 --port 6194 --strictPort',url:'http://127.0.0.1:6194',reuseExistingServer:false}});
