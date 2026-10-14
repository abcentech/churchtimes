import { defineConfig, devices } from '@playwright/test'

import { extraBrowserProjects } from './e2e/cross-app/support/browsers'
import { isHeaded, isRemote } from './e2e/cross-app/support/remote'

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
 *
 * REMOTE mode (XAPP_REMOTE=1, `npm run test:e2e:remote`): the same journeys against a deployed https staging; nothing is booted, no
 * --host-resolver-rules (real DNS and real Let's Encrypt certificates), real Turnstile keys. URLs from XAPP_PUBLIC_URL / XAPP_NEWSROOM_URL /
 * XAPP_CMS_URL, logins from the JSON file named by XAPP_REMOTE_CREDENTIALS; XAPP_HEADED=1 runs headed so a human can click a Turnstile
 * challenge; XAPP_REMOTE_SCHEDULER_SECONDS (default 60) is the deployed scheduler tick. Evidence goes to docs/evidence/remote/ (gitignored).
 * Operator guide: docs/staging.md, "Remote mode". Local behaviour is unchanged when XAPP_REMOTE is not 1.
 */
const hostRules = 'MAP *.churchtimes.localhost 127.0.0.1'
const launchOptions = isRemote ? {} : { args: [`--host-resolver-rules=${hostRules}`] }

// Opt-in extra engines (XAPP_ALL_BROWSERS=1; needs `npx playwright install firefox webkit`). --host-resolver-rules is
// Chromium-only; Firefox and Playwright's WebKit resolve *.localhost to loopback natively (probed), see support/browsers.ts.
const extraProjects = process.env.XAPP_ALL_BROWSERS === '1' ? extraBrowserProjects(devices) : []

export default defineConfig({
  testDir: './e2e/cross-app',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/cross-app/global-setup.ts',
  globalTeardown: './e2e/cross-app/global-teardown.ts',
  // One shared CMS instance with in-memory rate limits and a journey that builds on earlier state: sequential.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: isRemote ? (isHeaded ? 600_000 : 180_000) : 120_000, // remote: network latency; headed: time for a human to click a Turnstile challenge
  expect: { timeout: isRemote ? 30_000 : 20_000 },
  reporter: [['list'], ['./e2e/cross-app/support/evidence-reporter.ts']],
  outputDir: isRemote ? './test-results/cross-app-remote' : './test-results/cross-app',
  use: {
    ...(isHeaded ? { headless: false } : {}),
    launchOptions,
    trace: 'off',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: 'android-pixel7', use: { ...devices['Pixel 7'], launchOptions } },
    ...extraProjects,
  ],
})
