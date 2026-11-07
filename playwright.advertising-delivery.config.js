import { defineConfig } from '@playwright/test';
import existing from './playwright.config.js';
export default defineConfig({...existing,testDir:'./advertising-delivery-tests',use:{...existing.use,baseURL:'http://127.0.0.1:6193/'},webServer:{command:'npm run dev -- --port 6193 --strictPort',url:'http://127.0.0.1:6193',reuseExistingServer:false,env:{VITE_PUBLIC_ADVERTISING_URL:'http://127.0.0.1:6193/api/public/advertising'}}});
