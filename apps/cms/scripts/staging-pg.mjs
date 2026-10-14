// Internal: long-running embedded PostgreSQL for the disposable staging environment.
// Started detached by staging-up.mjs. Credentials arrive via the environment (never argv):
//   PG_DIR, PG_PORT, PG_USER, PG_PASSWORD, PG_DB, PG_READY_FILE
import fs from 'node:fs'
import path from 'node:path'

import EmbeddedPostgres from 'embedded-postgres'

const { PG_DIR, PG_PORT, PG_USER, PG_PASSWORD, PG_DB, PG_READY_FILE } = process.env
if (!PG_DIR || !PG_PORT || !PG_USER || !PG_PASSWORD || !PG_DB || !PG_READY_FILE) {
  console.error('staging-pg: missing environment (PG_DIR, PG_PORT, PG_USER, PG_PASSWORD, PG_DB, PG_READY_FILE).')
  process.exit(2)
}

const pg = new EmbeddedPostgres({
  databaseDir: PG_DIR,
  user: PG_USER,
  password: PG_PASSWORD,
  port: Number(PG_PORT),
  persistent: true,
  // Never listen beyond loopback, whatever the host's postgres defaults or config say.
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
})

if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) await pg.initialise()
await pg.start()
try {
  await pg.createDatabase(PG_DB)
} catch (err) {
  if (!/already exists/i.test(String(err?.message ?? err))) throw err
}
fs.writeFileSync(PG_READY_FILE, String(process.pid))

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  try {
    await pg.stop()
  } catch {
    // best effort
  }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('SIGBREAK', stop)
setInterval(() => {}, 1 << 30)
