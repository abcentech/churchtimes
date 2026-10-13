import { defineConfig, devices } from '@playwright/test'

/**
 * Browser E2E for cookie authentication against the real Payload CMS (issue #16 part 3).
 *
 *   npx playwright test -c playwright.config.ts                 # boots its own Postgres + CMS (ports 3200/55433)
 *   STAGING_URL=http://cms.churchtimes.localhost:3100 npx playwright test -c playwright.config.ts
 *
 * Env (staging mode): STAGING_URL, STAGING_CREDENTIALS_FILE (default .staging/credentials.json,
 * shape { "<role>": { "email", "password" } } with roles admin, reporter and one of section-editor /
 * editor-in-chief), optional E2E_NEWSROOM_ORIGIN / E2E_PUBLIC_ORIGIN (must be in the CMS CORS + CSRF
 * allowlists; defaults http://newsroom.churchtimes.localhost:5174 / http://www.churchtimes.localhost:5173).
 *
 * Chromium resolves *.localhost to loopback; the explicit host-resolver rules make that independent
 * of the OS resolver. churchtimes.localhost subdomains are "same-site"; othersite.localhost is not.
 */
const hostRules = 'MAP *.churchtimes.localhost 127.0.0.1, MAP *.othersite.localhost 127.0.0.1'

const launchOptions = { args: [`--host-resolver-rules=${hostRules}`] }

export default defineConfig({
  testDir: './e2e/browser',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/browser/global-setup.ts',
  globalTeardown: './e2e/browser/global-teardown.ts',
  // One shared CMS instance with in-memory rate limits and state: run strictly sequentially.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: './test-results/browser',
  use: {
    launchOptions,
    trace: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 120_000, // first admin hit compiles routes on `next dev`
  },
  projects: [
    {
      name: 'desktop-chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions },
    },
    {
      // Android-sized viewport (412x915, touch, mobile UA) in Chromium.
      name: 'android-pixel7',
      use: { ...devices['Pixel 7'], launchOptions },
    },
  ],
})
