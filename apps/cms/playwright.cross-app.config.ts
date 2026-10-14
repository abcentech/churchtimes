import { defineConfig, devices } from '@playwright/test'

/**
 * REAL cross-app browser E2E (issue #16): the actual newsroom SPA (apps/newsroom, built with Vite) and the
 * actual public site (repository root, built with Vite) driven in Chromium against a real Payload CMS
 * (`next start` on the existing production build) and a disposable embedded PostgreSQL.
 *
 *   npx playwright test -c playwright.cross-app.config.ts            # from apps/cms
 *   npm run test:e2e:cross-app
 *
 * Ports (this lane only): CMS 3400 (recording proxy) -> 3401 (next start), PostgreSQL 55435, public site 5373,
 * newsroom 5374. Env: XAPP_KEEP_EVIDENCE=0 skips writing docs/evidence/cross-app-* files; XAPP_PORT_OFFSET=<n>
 * shifts every port by n so several checkouts can run the lane at the same time.
 *
 * `.next` must already exist (this lane never runs `next build`; build once with `npm run build`).
 * Chromium resolves *.churchtimes.localhost to loopback via --host-resolver-rules, so no hosts-file change is needed.
 * The Cloudflare Turnstile widget is the real one (challenges.cloudflare.com, always-pass TEST site key); the CMS
 * verifies it server-side against Cloudflare's always-pass TEST secret.
 */
const hostRules = 'MAP *.churchtimes.localhost 127.0.0.1'
const launchOptions = { args: [`--host-resolver-rules=${hostRules}`] }

export default defineConfig({
  testDir: './e2e/cross-app',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/cross-app/global-setup.ts',
  globalTeardown: './e2e/cross-app/global-teardown.ts',
  // One shared CMS instance with in-memory rate limits and a journey that builds on earlier state: sequential.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['./e2e/cross-app/support/evidence-reporter.ts']],
  outputDir: './test-results/cross-app',
  use: {
    launchOptions,
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: 'android-pixel7', use: { ...devices['Pixel 7'], launchOptions } },
  ],
})
