import { defineConfig, devices } from '@playwright/test';

/**
 * Staff newsroom app tests (tests/newsroom.spec.js, tests/newsroom-security.spec.js).
 *
 * - Mock-mode UI tests run against `vite apps/newsroom --mode mock` (dev server only; the mock flag does not
 *   exist in production builds).
 * - "Stubbed CMS" tests (network fully intercepted with page.route; no CMS needed) run against a PRODUCTION build served on
 *   NEWSROOM_STUB_PORT (default 5277) with VITE_CMS_URL unset (same-origin /api), so they exercise the real adapter.
 * - Live-CMS tests run only when NEWSROOM_LIVE_CMS_URL and NEWSROOM_LIVE_CREDENTIALS are set. They build the app
 *   with VITE_CMS_URL=<that url> and serve the production bundle on NEWSROOM_LIVE_PORT (default 5274) at
 *   http://newsroom.churchtimes.localhost:<port>. See apps/newsroom/README.md.
 */
const liveCms = process.env.NEWSROOM_LIVE_CMS_URL;
const livePort = Number(process.env.NEWSROOM_LIVE_PORT || 5274);
const mockPort = Number(process.env.NEWSROOM_MOCK_PORT || 5276);
const stubPort = Number(process.env.NEWSROOM_STUB_PORT || 5277);

const webServer = [
  {
    command: `npx vite apps/newsroom --mode mock --port ${mockPort} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${mockPort}`,
    reuseExistingServer: false,
    timeout: 60_000
  }
];

webServer.push({
  command: `npx vite build apps/newsroom --outDir dist/stub && npx vite preview apps/newsroom --outDir dist/stub --port ${stubPort} --strictPort --host 127.0.0.1`,
  url: `http://127.0.0.1:${stubPort}`,
  reuseExistingServer: false,
  timeout: 120_000,
  env: { VITE_CMS_URL: '' }
});

if (liveCms) {
  webServer.push({
    command: `npx vite build apps/newsroom --outDir dist/live && npx vite preview apps/newsroom --outDir dist/live --port ${livePort} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${livePort}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { VITE_CMS_URL: liveCms }
  });
}

export default defineConfig({
  testDir: './tests',
  testMatch: ['newsroom.spec.js', 'newsroom-security.spec.js'],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${mockPort}/`,
    launchOptions: {
      args: [
        '--no-sandbox',
        '--host-resolver-rules=MAP *.churchtimes.localhost 127.0.0.1, MAP *.localhost 127.0.0.1'
      ]
    }
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer
});
