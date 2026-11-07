import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
// Growth features (search suggestions/filters, topics, Following, WhatsApp prompt, connect-band sign-up) against STUBBED CMS routes.
const port=Number(process.env.GROWTH_TEST_PORT||5241),origin=`http://127.0.0.1:${port}`;
export default defineConfig({...existing,testDir:'./growth-tests',use:{...existing.use,baseURL:origin+'/'},webServer:{command:`npm run dev -- --port ${port} --strictPort`,url:origin,reuseExistingServer:false,env:{VITE_PUBLIC_CMS_URL:origin,VITE_PUBLIC_NEWSLETTER_URL:origin+'/api/public/newsletter/subscribe',VITE_TURNSTILE_SITE_KEY:'1x00000000000000000000AA',VITE_PUBLIC_INDEXABLE:'false',VITE_PUBLIC_GA4_ID:''}}});
