import path from 'path'
import { fileURLToPath } from 'url'

import { defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const alias = { '@payload-config': path.resolve(dirname, 'src/payload.config.ts') }

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        // Pure unit tests: no database, no Payload boot.
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          // Unit files run in parallel workers (one per file); some do real PBKDF2 at production cost
          // (600k iterations) or cold-import Payload. Under load the 5 s default flaked. Assertions are
          // unchanged, only the ceiling is raised.
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        // Integration tests: boot Payload against PostgreSQL (TEST_DATABASE_URL, else embedded).
        // Strictly sequential: files share one database.
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60000,
          hookTimeout: 180000,
        },
      },
      {
        // Black-box security regression suite (docs/security.md). Same database bootstrap as integration.
        resolve: { alias },
        test: {
          name: 'security',
          environment: 'node',
          include: ['tests/security/**/*.test.ts'],
          globalSetup: ['tests/integration/global-setup.ts'],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 60000,
          hookTimeout: 180000,
        },
      },
    ],
  },
})
