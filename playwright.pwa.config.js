import {defineConfig,devices} from '@playwright/test';
import {existsSync} from 'node:fs';
// Real Chromium service workers against the production build and public host (CMS API STUBBED per test).
export default defineConfig({testDir:'./pwa-tests',workers:1,timeout:120000,use:{serviceWorkers:'allow',launchOptions:{executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']}},projects:[{name:'mobile',use:{...devices['Pixel 7']}}]});
