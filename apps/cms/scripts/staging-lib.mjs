// Shared helpers for the disposable staging environment (staging-up.mjs / staging-down.mjs / staging-pg.mjs).
// Nothing here prints secrets.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Staging data lives in STAGING_DIR (default apps/cms/.staging, gitignored). staging:up/down delete it recursively, so it
 * must be apps/cms/.staging or a sibling apps/cms/.staging-<name> (also git/docker-ignored). Anything else is refused.
 */
export const stagingDir = path.resolve(root, process.env.STAGING_DIR || '.staging')
if (path.dirname(stagingDir) !== root || !/^\.staging(-[A-Za-z0-9_-]+)?$/.test(path.basename(stagingDir))) {
  throw new Error(`STAGING_DIR must be ".staging" or ".staging-<name>" inside ${root} (got "${process.env.STAGING_DIR}").`)
}
export const files = {
  env: path.join(stagingDir, '.env.staging'),
  credentials: path.join(stagingDir, 'credentials.json'),
  state: path.join(stagingDir, 'state.json'),
  pgData: path.join(stagingDir, 'pgdata'),
  pgReady: path.join(stagingDir, 'pg.ready'),
  pgLog: path.join(stagingDir, 'postgres.log'),
  serverLog: path.join(stagingDir, 'server.log'),
}

// The server runs with Cloudflare's always-pass Turnstile secret and trusts X-Forwarded-For: never bind beyond loopback.
const stagingHost = () => {
  const host = process.env.STAGING_HOST || '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('STAGING_HOST must be 127.0.0.1 or localhost (loopback only).')
  return host
}

export const settings = () => {
  const port = Number(process.env.STAGING_PORT || 3100)
  const pgPort = Number(process.env.STAGING_PG_PORT || 55432)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('STAGING_PORT must be a valid port.')
  if (!Number.isInteger(pgPort) || pgPort < 1 || pgPort > 65535) throw new Error('STAGING_PG_PORT must be a valid port.')
  return {
    port,
    pgPort,
    host: stagingHost(),
    newsroomOrigin: process.env.STAGING_NEWSROOM_ORIGIN || 'http://newsroom.churchtimes.localhost:5174',
    publicOrigin: process.env.STAGING_PUBLIC_ORIGIN || 'http://www.churchtimes.localhost:5173',
    submissionRateLimit: process.env.STAGING_SUBMISSION_RATE_LIMIT || '3',
    authLoginRateLimit: process.env.STAGING_AUTH_LOGIN_RATE_LIMIT || '200',
  }
}

export const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Parse a simple KEY=VALUE env file (no quoting, no expansion). */
export const parseEnvFile = (file) => {
  const out = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Command line of a running process ('' when unknown). */
const commandLine = (pid) => {
  const res =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
          { encoding: 'utf8', windowsHide: true },
        )
      : spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
  return res.status === 0 ? String(res.stdout).trim() : ''
}

/** Absolute script paths that appear in the command lines of the processes staging-up.mjs spawns. */
export const markers = {
  postgres: path.join(root, 'scripts', 'staging-pg.mjs'),
  server: path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'),
}

/**
 * True when `pid` is alive AND its command line contains `marker`, so a stale state.json (e.g. after a reboot, with the
 * pid reused by an unrelated program) never makes staging:down kill somebody else's process tree.
 */
export const isOwnProcess = (pid, marker) => pidAlive(pid) && commandLine(pid).includes(marker)

/** Kill a process and its children. Windows: taskkill /T /F; POSIX: process group, then the pid. */
export const killTree = (pid) => {
  if (!pidAlive(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** True when something is listening on host:port. */
export const portInUse = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

/** Wait until `fn` resolves truthy or the timeout passes. */
export const waitFor = async (fn, { timeoutMs, intervalMs = 500, what }) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      if (err?.fatal) throw err
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}.`)
    await sleep(intervalMs)
  }
}
