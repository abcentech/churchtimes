/**
 * Vitest globalSetup for the integration project.
 *
 * - TEST_DATABASE_URL set (CI): use that database as-is.
 * - Otherwise: start embedded PostgreSQL on a free port with a temporary data directory and a fresh
 *   database; both are removed in teardown.
 *
 * Environment is set here (before any worker forks) so `payload.config.ts` sees it on import.
 */
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import EmbeddedPostgres from 'embedded-postgres'

let pg: EmbeddedPostgres | undefined
let dataDir: string | undefined

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })

export async function setup(): Promise<void> {

  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  } else {
    const port = await freePort()
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-cms-test-pg-'))
    const user = 'churchtimes'
    const password = 'churchtimes-test'
    pg = new EmbeddedPostgres({
      databaseDir: dataDir,
      user,
      password,
      port,
      persistent: false,
      onLog: () => {},
      onError: () => {},
    })
    await pg.initialise()
    await pg.start()
    await pg.createDatabase('churchtimes_test')
    process.env.DATABASE_URL = `postgres://${user}:${password}@127.0.0.1:${port}/churchtimes_test`
  }

  // Deterministic, obviously-fake values. Never real secrets.
  process.env.PAYLOAD_SECRET = 'test-only-payload-secret-0123456789abcdef0123'
  process.env.PREVIEW_SECRET = 'test-only-preview-secret-0123456789abcdef'
  process.env.IP_HASH_SALT = 'test-only-ip-salt-0123456789'
  process.env.CMS_PUBLIC_URL = ''
  process.env.PUBLIC_SUBMISSION_ORIGINS = 'http://allowed.test'
  process.env.SUBMISSION_RATE_LIMIT = '5'
  process.env.SUBMISSION_RATE_WINDOW_SECONDS = '900'
  process.env.TRUST_PROXY = 'true' // tests isolate rate-limit buckets with x-forwarded-for
  process.env.SCHEDULER_ENABLED = 'false'
  process.env.PAYLOAD_DB_PUSH = 'false'
}

export async function teardown(): Promise<void> {
  if (pg) {
    try {
      await pg.stop()
    } catch {
      // ignore
    }
    pg = undefined
  }
  if (dataDir) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // temp dir; the OS will clean it eventually
    }
    dataDir = undefined
  }
}
