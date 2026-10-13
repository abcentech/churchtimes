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
    ],
  },
})
