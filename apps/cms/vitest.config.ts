import path from 'path'
import { fileURLToPath } from 'url'

import { defineConfig } from 'vitest/config'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: { '@payload-config': path.resolve(dirname, 'src/payload.config.ts') },
  },
})
