// Persistent local PostgreSQL for development, using embedded-postgres (no Docker needed).
//
// Usage: npm run db:local          (Ctrl+C to stop cleanly)
//
// The credentials below are LOCAL-ONLY, bound to 127.0.0.1, and are NOT secrets.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import EmbeddedPostgres from 'embedded-postgres'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, '.local-postgres')
const port = Number(process.env.LOCAL_PG_PORT || 54329)
const user = 'churchtimes'
const password = 'churchtimes-local'
const dbName = 'churchtimes'

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  onLog: () => {},
  onError: (e) => console.error('[postgres]', e),
})

if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
  console.log('Initialising new local cluster in', dataDir)
  await pg.initialise()
}

await pg.start()

try {
  await pg.createDatabase(dbName)
  console.log(`Created database "${dbName}"`)
} catch (err) {
  const msg = String(err?.message ?? err)
  if (!/already exists/i.test(msg)) throw err
}

console.log('')
console.log('Local PostgreSQL is running. Set in apps/cms/.env:')
console.log(`DATABASE_URL=postgres://${user}:${password}@127.0.0.1:${port}/${dbName}`)
console.log('Press Ctrl+C to stop.')

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  console.log('\nStopping local PostgreSQL...')
  try {
    await pg.stop()
  } catch (err) {
    console.error('Error while stopping:', err)
  }
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('SIGBREAK', stop)

// Keep the process alive.
setInterval(() => {}, 1 << 30)
