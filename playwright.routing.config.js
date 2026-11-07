import {defineConfig,devices} from '@playwright/test';
import {existsSync} from 'node:fs';
export default defineConfig({testDir:'./routing-tests',workers:1,use:{launchOptions:{executablePath:process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']}},projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['Pixel 7']}}]});
