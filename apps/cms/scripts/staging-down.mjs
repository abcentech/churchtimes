// Stop the disposable staging environment and delete its data. Idempotent.
//
//   npm run staging:down            stop server + PostgreSQL, delete .staging/
//   npm run staging:down -- --keep  stop them but keep .staging/ (logs, env, credentials) for inspection
import fs from 'node:fs'

import { files, isOwnProcess, killTree, markers, pidAlive, readJson, sleep, stagingDir } from './staging-lib.mjs'

const keep = process.argv.includes('--keep')
const state = readJson(files.state)

const stopped = []
const killed = []
if (state) {
  // Server first (it holds DB connections), then PostgreSQL.
  for (const [name, pid, marker] of [
    ['server', state.server?.pid, markers.server],
    ['postgres', state.postgres?.pid, markers.postgres],
  ]) {
    if (isOwnProcess(pid, marker)) {
      killTree(pid)
      killed.push(pid)
      stopped.push(`${name} (pid ${pid})`)
    } else if (pidAlive(pid)) {
      console.error(`[staging] pid ${pid} (${name} in a stale state.json) now belongs to another program; not killing it.`)
    }
  }
  // Wait briefly for the processes to exit so the data directory can be deleted.
  for (let i = 0; i < 40 && killed.some(pidAlive); i++) await sleep(250)
  for (const pid of killed) {
    if (pidAlive(pid)) console.error(`[staging] WARNING: pid ${pid} is still running.`)
  }
}

console.log(stopped.length ? `[staging] stopped: ${stopped.join(', ')}` : '[staging] nothing was running')

if (keep) {
  console.log(`[staging] --keep: leaving ${stagingDir} in place (it contains generated secrets; delete it when done).`)
} else if (fs.existsSync(stagingDir)) {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    console.log('[staging] deleted .staging/')
  } catch (err) {
    console.error(`[staging] could not fully delete ${stagingDir}: ${err instanceof Error ? err.message : err}`)
    process.exitCode = 1
  }
}
