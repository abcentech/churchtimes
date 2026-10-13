import { defineConfig } from 'vitest/config'

/**
 * API end-to-end suite: real HTTP against a running staging server (`npm run staging:up`).
 * Deliberately NOT part of vitest.config.ts, so `npm test` stays self-contained (embedded DB, no server).
 * Run with `npm run test:e2e:api`.
 */
export default defineConfig({
  test: {
    name: 'e2e-api',
    environment: 'node',
    include: ['e2e/api/**/*.test.ts'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: ['verbose'],
  },
})
