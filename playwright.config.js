import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

export default defineConfig({
  testDir: './tests',
  // Newsroom specs need the newsroom app server; run them with npm run test:newsroom-app.
  testIgnore: ['**/newsroom.spec.js', '**/newsroom-security.spec.js'],
  fullyParallel: true,
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5173/',
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined), args: ['--no-sandbox'] },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.TEST_BASE_URL ? undefined : { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', reuseExistingServer: true },
});
