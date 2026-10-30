import {defineConfig} from '@playwright/test';
import existing from './playwright.config.js';
// Scripture reference cards and verse of the day, against the source modules (no build needed).
export default defineConfig({...existing,testDir:'./growth-scripture-tests',use:{...existing.use,baseURL:'http://127.0.0.1:5291/'},webServer:{command:'node tools/scripture/test-server.mjs',url:'http://127.0.0.1:5291/fixture.html',reuseExistingServer:false}});
