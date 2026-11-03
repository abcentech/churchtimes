import {defineConfig} from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({...base,testDir:'./cms-home-tests',workers:1,use:{...base.use,baseURL:'http://127.0.0.1:6288/'},webServer:{command:'npm run dev -- --host 127.0.0.1 --port 6288 --strictPort',url:'http://127.0.0.1:6288/',reuseExistingServer:false,env:{VITE_PUBLIC_CMS_URL:'http://127.0.0.1:6288',VITE_PUBLIC_ADVERTISING_URL:'',VITE_PUBLIC_NEWSLETTER_URL:'',VITE_PUBLIC_CONTACT_URL:''}}});
