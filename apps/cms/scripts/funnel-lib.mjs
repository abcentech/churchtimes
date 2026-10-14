// Shared helpers for the on-demand staging that runs on the owner's PC and is published with Tailscale Funnel
// (funnel-up.mjs / funnel-down.mjs / funnel-status.mjs / funnel-serve.mjs). See deploy/staging/funnel/README.md.
//
// Nothing in this file prints secrets. All state lives OUTSIDE the repository (see stateDir()).
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { isOwnProcess, killTree, markers as stagingMarkers, parseEnvFile, pidAlive, portInUse, readJson, root, sleep, waitFor } from './staging-lib.mjs'

export { isOwnProcess, killTree, parseEnvFile, pidAlive, portInUse, readJson, root, sleep, waitFor }

export const repoRoot = path.resolve(root, '..', '..')
const here = path.dirname(fileURLToPath(import.meta.url))

/** Absolute script paths that appear in the command lines of the processes funnel-up.mjs spawns (used to avoid killing a stale pid). */
export const markers = {
  postgres: stagingMarkers.postgres,
  cms: stagingMarkers.server,
  serve: path.join(here, 'funnel-serve.mjs'),
}

export const log = (msg) => console.log(`[funnel] ${msg}`)
export const warn = (msg) => console.warn(`[funnel] WARNING: ${msg}`)
export const fail = (msg, code = 1) => {
  console.error(`[funnel] ERROR: ${msg}`)
  process.exit(code)
}

// --------------------------------------------------------------------------------------------------------------------
// Arguments
// --------------------------------------------------------------------------------------------------------------------

/** Tiny argv parser. `flags` are booleans, `options` take a value (`--host x` or `--host=x`). Unknown arguments are an error. */
export function parseArgs(argv, { flags = [], options = [] }) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    const [name, inline] = raw.startsWith('--') ? raw.slice(2).split(/=(.*)/s, 2) : [null, undefined]
    if (name && flags.includes(name) && inline === undefined) out[name] = true
    else if (name && options.includes(name)) {
      const value = inline ?? argv[++i]
      if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`)
      out[name] = value
    } else fail(`Unknown argument "${raw}". Allowed: ${[...flags, ...options.map((o) => `${o} <value>`)].map((f) => `--${f}`).join(', ')}`)
  }
  return out
}

// --------------------------------------------------------------------------------------------------------------------
// State directory (outside the repo) and configuration
// --------------------------------------------------------------------------------------------------------------------

/**
 * %LOCALAPPDATA%\churchtimes-staging-funnel on Windows, ~/.churchtimes-staging-funnel elsewhere. FUNNEL_STATE_DIR overrides it
 * (tests); the folder name must contain "churchtimes-staging-funnel" so that `funnel-down --wipe` can never delete anything else.
 */
export function stateDir() {
  const override = process.env.FUNNEL_STATE_DIR
  const dir = override
    ? path.resolve(override)
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'churchtimes-staging-funnel')
      : path.join(os.homedir(), '.churchtimes-staging-funnel')
  if (!/churchtimes-staging-funnel/.test(path.basename(dir))) {
    fail(`FUNNEL_STATE_DIR must end in a folder whose name contains "churchtimes-staging-funnel" (got "${dir}").`)
  }
  if (override) {
    // `--wipe` deletes this folder recursively, so an override is only accepted inside the user's own profile.
    const allowed = [os.homedir(), process.env.LOCALAPPDATA].filter(Boolean).map((d) => path.resolve(d))
    const inside = (base) => {
      const r = path.relative(base, dir)
      return r !== '' && !r.startsWith('..') && !path.isAbsolute(r)
    }
    if (!allowed.some(inside)) fail(`FUNNEL_STATE_DIR must be inside your user profile (${allowed.join(' or ')}); got "${dir}".`)
  }
  const rel = path.relative(repoRoot, dir)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) fail(`The state directory must be OUTSIDE the repository (got "${dir}").`)
  return dir
}

export const pathsFor = (dir) => ({
  dir,
  secrets: path.join(dir, 'secrets.json'),
  turnstile: path.join(dir, 'turnstile.json'),
  media: path.join(dir, 'media'),
  state: path.join(dir, 'state.json'),
  credentialsHuman: path.join(dir, 'staff-logins.txt'),
  credentialsRemote: path.join(dir, 'xapp-remote-credentials.json'),
  seedUsers: path.join(dir, 'seed-users.json'),
  pgData: path.join(dir, 'pgdata'),
  pgReady: path.join(dir, 'pg.ready'),
  logs: path.join(dir, 'logs'),
  distPublic: path.join(dir, 'dist', 'public'),
  distNewsroom: path.join(dir, 'dist', 'newsroom'),
  buildInfo: path.join(dir, 'dist', 'BUILD_INFO.json'),
})

const intEnv = (name, fallback, { min = 1, max = 65535 } = {}) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be an integer between ${min} and ${max} (got "${raw}").`)
  return n
}

/** Ports, rate limits and proxy settings. Every value can be overridden with the FUNNEL_* variables documented in the README. */
export function loadConfig() {
  const cfg = {
    publicPort: intEnv('FUNNEL_PUBLIC_PORT', 48501),
    newsroomPort: intEnv('FUNNEL_NEWSROOM_PORT', 48502),
    cmsPort: intEnv('FUNNEL_CMS_PORT', 48503),
    pgPort: intEnv('FUNNEL_PG_PORT', 48500),
    // Tailscale's serve proxy overwrites X-Forwarded-For with the real client address (single entry) = one trusted hop.
    trustProxyHops: intEnv('FUNNEL_TRUST_PROXY_HOPS', 1, { min: 1, max: 10 }),
    authLoginRateLimit: intEnv('FUNNEL_AUTH_LOGIN_RATE_LIMIT', 200, { min: 200, max: 100000 }),
    submissionRateLimit: intEnv('FUNNEL_SUBMISSION_RATE_LIMIT', 20, { min: 10, max: 100000 }),
    schedulerSeconds: intEnv('FUNNEL_SCHEDULER_INTERVAL_SECONDS', 60, { min: 5, max: 3600 }),
    turnstileAction: (process.env.FUNNEL_TURNSTILE_ACTION || 'submit-story').trim(),
    categoryTitle: 'News',
  }
  const all = [cfg.publicPort, cfg.newsroomPort, cfg.cmsPort, cfg.pgPort]
  if (new Set(all).size !== all.length) fail('FUNNEL_PUBLIC_PORT, FUNNEL_NEWSROOM_PORT, FUNNEL_CMS_PORT and FUNNEL_PG_PORT must all differ.')
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(cfg.turnstileAction)) fail('FUNNEL_TURNSTILE_ACTION must be 1-32 chars of A-Z a-z 0-9 _ - (Cloudflare\'s rule).')
  // A custom client-IP header would let any visitor choose their own rate-limit bucket, so it is not offered.
  if ((process.env.FUNNEL_CLIENT_IP_HEADER || '').trim()) fail('FUNNEL_CLIENT_IP_HEADER is not supported: a custom client-IP header would be spoofable through Funnel. The CMS reads X-Forwarded-For, which Tailscale overwrites.')
  return cfg
}

export const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/
export function assertHost(host) {
  if (!HOST_RE.test(host)) fail(`"${host}" is not a MagicDNS name (expected <machine>.<tailnet>.ts.net, lower-case).`)
  return host
}

/** The three public origins. Funnel only allows 443, 8443 and 10000. */
export const FUNNEL_PORTS = { public: 443, newsroom: 8443, cms: 10000 }
export const originFor = (host, httpsPort) => (httpsPort === 443 ? `https://${host}` : `https://${host}:${httpsPort}`)
export const origins = (host) => ({
  public: originFor(host, FUNNEL_PORTS.public),
  newsroom: originFor(host, FUNNEL_PORTS.newsroom),
  cms: originFor(host, FUNNEL_PORTS.cms),
})
export const funnelEntries = (cfg) => [
  { name: 'public', httpsPort: FUNNEL_PORTS.public, localPort: cfg.publicPort },
  { name: 'newsroom', httpsPort: FUNNEL_PORTS.newsroom, localPort: cfg.newsroomPort },
  { name: 'cms', httpsPort: FUNNEL_PORTS.cms, localPort: cfg.cmsPort },
]

export const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true })
export const writePrivate = (file, text) => {
  fs.writeFileSync(file, text, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // Windows: the state dir lives in the user's profile, which is already private to the account
  }
}
export const writeJson = (file, value) => writePrivate(file, JSON.stringify(value, null, 2) + '\n')

const hex = (bytes) => randomBytes(bytes).toString('hex')

/** PAYLOAD_SECRET, PREVIEW_SECRET, IP_HASH_SALT and the database password: generated once, then reused (changing them signs everyone out). */
export function loadOrCreateSecrets(p, { create = true } = {}) {
  const existing = readJson(p.secrets)
  const valid = (s) => s && [s.PAYLOAD_SECRET, s.PREVIEW_SECRET, s.IP_HASH_SALT, s.PG_PASSWORD].every((v) => typeof v === 'string' && v.length >= 16)
  if (valid(existing)) return existing
  if (!create) return null
  const secrets = { PAYLOAD_SECRET: hex(32), PREVIEW_SECRET: hex(32), IP_HASH_SALT: hex(16), PG_PASSWORD: hex(16), createdAt: new Date().toISOString() }
  writeJson(p.secrets, secrets)
  return secrets
}

// --------------------------------------------------------------------------------------------------------------------
// Turnstile keys
// --------------------------------------------------------------------------------------------------------------------

/** Cloudflare's documented always-pass TEST site key. It is public and only ever used by `funnel-up --test-keys` (local test, never a funnel). */
export const TURNSTILE_TEST_SITE_KEY = '1x00000000000000000000AA'
export const isDummySiteKey = (k) => /^[123]x0{10,}/.test(k)
export const isDummySecret = (k) => /^[123]x0{20,}AA$/.test(k)

export function checkSiteKey(key) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return 'the site key has an unexpected shape (8-64 letters, digits, - or _).'
  if (isDummySiteKey(key)) return 'that is one of Cloudflare\'s dummy TEST site keys. This staging uses a REAL widget; create one in the Cloudflare dashboard.'
  return ''
}
export function checkSecretKey(key) {
  if (key.length < 16 || /\s/.test(key)) return 'the secret key has an unexpected shape (at least 16 characters, no spaces).'
  if (isDummySecret(key)) return 'that is one of Cloudflare\'s dummy TEST secrets. This staging uses a REAL widget.'
  return ''
}

const ask = (question, { hidden = false } = {}) =>
  new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('stdin is not a terminal, so the Turnstile keys cannot be typed. Run this in a terminal, or set FUNNEL_TURNSTILE_SITE_KEY and FUNNEL_TURNSTILE_SECRET_KEY.'))
      return
    }
    let muted = false
    const output = new Writable({
      write(chunk, encoding, cb) {
        if (!muted) process.stdout.write(chunk, encoding)
        cb()
      },
    })
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true })
    rl.on('SIGINT', () => {
      rl.close()
      reject(new Error('cancelled'))
    })
    process.stdout.write(question)
    muted = hidden // everything typed from here on is not echoed
    rl.question('', (answer) => {
      muted = false
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
export const askVisible = (q) => ask(q)
export const askHidden = (q) => ask(q, { hidden: true })

/**
 * The real Turnstile keys: from FUNNEL_TURNSTILE_* env (non-interactive), else turnstile.json, else typed once (site key visible,
 * secret hidden) and saved there. `rotate` forces a new prompt. Never logs a key.
 */
export async function loadOrPromptTurnstile(p, { rotate = false } = {}) {
  const envSite = process.env.FUNNEL_TURNSTILE_SITE_KEY?.trim()
  const envSecret = process.env.FUNNEL_TURNSTILE_SECRET_KEY?.trim()
  let siteKey = ''
  let secretKey = ''
  if (envSite && envSecret) {
    siteKey = envSite
    secretKey = envSecret
  } else if (!rotate) {
    const saved = readJson(p.turnstile)
    if (saved?.siteKey && saved?.secretKey) {
      siteKey = saved.siteKey
      secretKey = saved.secretKey
    }
  }
  if (!siteKey || !secretKey) {
    console.log('')
    console.log('Cloudflare Turnstile (real keys, asked once and stored in the state folder; the secret is never shown or logged).')
    console.log('Create the widget at https://dash.cloudflare.com/?to=/:account/turnstile with the hostname of this staging (see README).')
    for (let attempt = 0; attempt < 3 && !siteKey; attempt++) {
      const k = await askVisible('Turnstile SITE key (public): ')
      const problem = checkSiteKey(k)
      if (problem) console.log(`  not accepted: ${problem}`)
      else siteKey = k
    }
    for (let attempt = 0; attempt < 3 && !secretKey; attempt++) {
      const k = await askHidden('Turnstile SECRET key (typing is hidden): ')
      const problem = checkSecretKey(k)
      if (problem) console.log(`  not accepted: ${problem}`)
      else secretKey = k
    }
    if (!siteKey || !secretKey) throw new Error('No valid Turnstile keys were entered.')
    writeJson(p.turnstile, { siteKey, secretKey, savedAt: new Date().toISOString() })
    log(`Turnstile keys stored in ${p.turnstile}`)
  }
  const problem = checkSiteKey(siteKey) || checkSecretKey(secretKey)
  if (problem) throw new Error(`Stored/provided Turnstile key rejected: ${problem} (re-run with --rotate-turnstile).`)
  return { siteKey, secretKey }
}

// --------------------------------------------------------------------------------------------------------------------
// Tailscale CLI
// --------------------------------------------------------------------------------------------------------------------

const tsCandidates = () => [
  process.env.TAILSCALE_BIN,
  'tailscale',
  ...(process.platform === 'win32'
    ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale']
      : []),
]

/** Absolute/bare command that answers `tailscale version`, or null. */
// Test seam: a .js/.mjs "tailscale" is run with node (lets tests stub the CLI on Windows, where a script is not directly executable).
// A script stub is accepted only with FUNNEL_TEST=1, so a forgotten stub can never hide what the real Tailscale publishes.
const invocation = (bin, args) => (/[.]m?js$/i.test(bin) ? [process.execPath, [bin, ...args]] : [bin, args])

export function findTailscale() {
  const override = process.env.TAILSCALE_BIN
  if (override) {
    if (/[.]m?js$/i.test(override) && process.env.FUNNEL_TEST !== '1') {
      throw new Error(`TAILSCALE_BIN=${override} is a script stub; set FUNNEL_TEST=1 to use it (tests only), or unset TAILSCALE_BIN.`)
    }
    console.warn(`[funnel] using TAILSCALE_BIN=${override} instead of the installed Tailscale`)
  }
  for (const bin of tsCandidates().filter(Boolean)) {
    const [cmd, cmdArgs] = invocation(bin, ['version'])
    const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    if (!res.error && res.status === 0) return bin
  }
  return null
}

export function tsRun(bin, args, { timeoutMs = 60_000 } = {}) {
  const [cmd, cmdArgs] = invocation(bin, args)
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    status: res.status,
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? ''),
    timedOut: res.error?.code === 'ETIMEDOUT',
    error: res.error,
  }
}

export const tsVersion = (bin) => {
  const res = tsRun(bin, ['version'], { timeoutMs: 15_000 })
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(res.stdout.trim())
  return m ? { major: Number(m[1]), minor: Number(m[2]), text: m[0] } : { major: 0, minor: 0, text: 'unknown' }
}

/** Funnel/serve CLI syntax: the modern one (>= 1.52) or the legacy one (`serve https:8443 / target` + `funnel 8443 on`). */
export const tsSyntax = (v) => (v.major === 1 && v.minor < 52 ? 'legacy' : 'modern')

export const ADMIN_STEPS = {
  https:
    'Turn on HTTPS certificates: open https://login.tailscale.com/admin/dns , make sure MagicDNS is enabled, then under "HTTPS Certificates" click "Enable HTTPS...". ' +
    'Then re-run this command.',
  funnel:
    'Allow Funnel for this PC: open https://login.tailscale.com/admin/acls/file and make sure the policy has a "nodeAttrs" entry ' +
    '{"target": ["autogroup:member"], "attr": ["funnel"]} (the default policy for new tailnets already has it), save, then re-run. ' +
    'Funnel can also be enabled from the link `tailscale funnel` prints the first time. Only a tailnet admin/owner can do this.',
  magicdns: 'Turn on MagicDNS: open https://login.tailscale.com/admin/dns and enable "MagicDNS".',
  login: 'Sign in: open the Tailscale tray icon and choose "Log in" (or run `tailscale up`), then re-run.',
  install: 'Install Tailscale for Windows from https://tailscale.com/download/windows , sign in, then re-run. (Nothing is installed by this script.)',
}

/** Reads `tailscale status --json` and returns { host, problems[] }. */
export function tailscalePreflight(bin) {
  const res = tsRun(bin, ['status', '--json'], { timeoutMs: 30_000 })
  const problems = []
  let status = null
  try {
    status = JSON.parse(res.stdout)
  } catch {
    // handled below
  }
  if (!status) {
    problems.push(`\`tailscale status --json\` did not return JSON (${(res.stderr || res.stdout).trim().split('\n')[0] || 'no output'}). Is the Tailscale service running? ${ADMIN_STEPS.login}`)
    return { host: null, problems, status: null }
  }
  if (status.BackendState !== 'Running') {
    problems.push(`Tailscale is not connected (state: ${status.BackendState}). ${ADMIN_STEPS.login}`)
  }
  const host = String(status.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase()
  if (!host && status.BackendState === 'Running') problems.push(`This machine has no MagicDNS name. ${ADMIN_STEPS.magicdns}`)
  if (status.CurrentTailnet && status.CurrentTailnet.MagicDNSEnabled === false) problems.push(`MagicDNS is disabled on the tailnet. ${ADMIN_STEPS.magicdns}`)
  if (host && status.BackendState === 'Running' && !(status.CertDomains ?? []).map((d) => String(d).toLowerCase()).includes(host)) {
    problems.push(`HTTPS certificates are not enabled for ${host}. ${ADMIN_STEPS.https}`)
  }
  const caps = [...Object.keys(status.Self?.CapMap ?? {}), ...(status.Self?.Capabilities ?? [])].map(String)
  const funnelOk = caps.some((c) => /funnel/i.test(c))
  return { host: host || null, problems, status, funnelCapabilityListed: funnelOk }
}

/** Parsed `tailscale serve status --json`: { Web: { "host:port": { Handlers: { "/": { Proxy } } } }, AllowFunnel: { "host:port": true }, TCP } */
export function tsServeConfig(bin) {
  const res = tsRun(bin, ['serve', 'status', '--json'], { timeoutMs: 30_000 })
  if (res.status !== 0) return null
  try {
    const parsed = JSON.parse(res.stdout.trim() || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return null // cannot tell what is published: callers must not assume "nothing"
  }
}

const trimSlash = (t) => String(t ?? '').replace(/\/+$/, '')
/** Local port of a `http://127.0.0.1:N` / localhost / [::1] proxy target, else null. */
export const proxyPort = (target) => {
  const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(trimSlash(target))
  return m ? Number(m[1]) : null
}
const portOfKey = (key) => Number(String(key).split(':').pop())

/** True when `tailscale serve` lists anything for this https port (any host name): a web handler, or Funnel switched on. */
export function isPortListed(serve, httpsPort) {
  const web = Object.keys(serve?.Web ?? {}).some((k) => portOfKey(k) === httpsPort)
  const funnel = Object.entries(serve?.AllowFunnel ?? {}).some(([k, on]) => on && portOfKey(k) === httpsPort)
  const tcp = Object.keys(serve?.TCP ?? {}).some((k) => portOfKey(k) === httpsPort)
  return web || funnel || tcp
}

/**
 * What `tailscale serve` already holds on each of the three Funnel ports of `host`. Funnel publishes a WHOLE host:port, so
 * anything other than our own single "/" proxy on it (other path handlers, a raw TCP forward) would become public too.
 * `foreignReasons` lists those; `ours` is true when the port holds exactly our own "/" proxy.
 */
export function analyzeServe(serve, host, cfg) {
  return funnelEntries(cfg).map((e) => {
    const key = `${host}:${e.httpsPort}`
    const handlers = serve?.Web?.[key]?.Handlers ?? {}
    const paths = Object.keys(handlers)
    const tcp = serve?.TCP?.[String(e.httpsPort)]
    const foreignReasons = []
    if (tcp && !tcp.HTTPS && !tcp.HTTP) foreignReasons.push(tcp.TCPForward ? `a raw TCP forward to ${tcp.TCPForward}` : 'a non-web (TCP) entry')
    for (const pth of paths) {
      const h = handlers[pth]
      if (pth !== '/') foreignReasons.push(`a handler for the path ${pth}`)
      else if (proxyPort(h?.Proxy) !== e.localPort) foreignReasons.push(h?.Proxy ? `a proxy to ${h.Proxy}` : 'a non-proxy handler on /')
    }
    return { ...e, key, listed: isPortListed(serve, e.httpsPort), funnel: !!serve?.AllowFunnel?.[key], foreignReasons, ours: paths.length === 1 && foreignReasons.length === 0 }
  })
}

/** Serve entries (any host/port) whose proxy target is one of OUR local ports: { key, name, httpsPort, localPort, funnel }. */
export function entriesToOurPorts(serve, cfg) {
  const ours = new Map(funnelEntries(cfg).map((e) => [e.localPort, e.name]))
  const out = []
  for (const [key, web] of Object.entries(serve?.Web ?? {})) {
    for (const h of Object.values(web?.Handlers ?? {})) {
      const lp = proxyPort(h?.Proxy)
      if (lp !== null && ours.has(lp)) out.push({ key, name: ours.get(lp), httpsPort: portOfKey(key), localPort: lp, funnel: !!serve?.AllowFunnel?.[key] })
    }
  }
  return out
}

/** Funnel entries that forward to a loopback port where nothing is listening: { key, localPort }. They would expose whatever binds that port next. */
export async function funnelOrphans(serve) {
  const out = []
  for (const [key, web] of Object.entries(serve?.Web ?? {})) {
    if (!serve?.AllowFunnel?.[key]) continue
    for (const h of Object.values(web?.Handlers ?? {})) {
      const lp = proxyPort(h?.Proxy)
      if (lp !== null && !(await portInUse(lp))) out.push({ key, localPort: lp })
    }
  }
  return out
}

/** Commands that clear EVERYTHING served on one https port (Funnel off, then every handler). */
export function clearPortCommands(syntax, entry) {
  // A raw TCP forward on the port is not cleared here: isPortListed() still sees it afterwards, so up refuses (fails closed).
  return [...funnelOffCommands(syntax, entry), syntax === 'legacy' ? ['serve', `https:${entry.httpsPort}`, 'off'] : ['serve', `--https=${entry.httpsPort}`, 'off']]
}

/**
 * Turns the given funnels off and returns the ones that are STILL on: an entry only counts as off when every `off` command exited 0
 * AND `tailscale serve status --json` no longer lists its port. An unreadable status counts as "still on".
 */
export function turnOffFunnels(bin, syntax, funnels) {
  const remaining = []
  const before = tsServeConfig(bin)
  for (const f of funnels) {
    if (before && !isPortListed(before, f.httpsPort)) {
      log(`funnel on port ${f.httpsPort} (${f.name}) was already off`)
      continue
    }
    let allOk = true
    for (const c of funnelOffCommands(syntax, f)) {
      const res = tsRun(bin, c, { timeoutMs: 30_000 })
      if (res.status !== 0 || res.timedOut) {
        allOk = false
        warn(`\`tailscale ${c.join(' ')}\` failed: ${(res.stderr || res.stdout || 'no output').trim().split('\n')[0]}`)
      }
    }
    const after = tsServeConfig(bin)
    if (allOk && after && !isPortListed(after, f.httpsPort)) log(`funnel on port ${f.httpsPort} (${f.name}) turned off and confirmed`)
    else {
      remaining.push(f)
      warn(`funnel on port ${f.httpsPort} (${f.name}) could NOT be confirmed off. It is probably still public.`)
    }
  }
  return remaining
}

/** Commands that turn one entry on / off, as argument arrays (without the binary). */
export function funnelOnCommands(syntax, entry, { supportsYes }) {
  const target = `http://127.0.0.1:${entry.localPort}`
  if (syntax === 'legacy') {
    return [
      ['serve', `https:${entry.httpsPort}`, '/', target],
      ['funnel', String(entry.httpsPort), 'on'],
    ]
  }
  return [['funnel', '--bg', ...(supportsYes ? ['--yes'] : []), `--https=${entry.httpsPort}`, target]]
}
export function funnelOffCommands(syntax, entry) {
  if (syntax === 'legacy') return [['funnel', String(entry.httpsPort), 'off'], ['serve', `https:${entry.httpsPort}`, '/', 'off']]
  return [['funnel', `--https=${entry.httpsPort}`, 'off']]
}

/** Maps CLI output to the exact admin-console step the owner needs. */
export function explainTailscaleFailure(text) {
  if (/funnel.*(not enabled|isn't enabled|not allowed|not permitted|disabled)|enable funnel|login\.tailscale\.com\/f\/funnel/i.test(text)) return ADMIN_STEPS.funnel
  if (/https.*(not enabled|disabled)|enable https|certificates? (are )?(not|disabled)/i.test(text)) return ADMIN_STEPS.https
  if (/logged out|needs login|not logged in|NeedsLogin/i.test(text)) return ADMIN_STEPS.login
  if (/serve.*not enabled|login\.tailscale\.com\/f\/serve/i.test(text)) return 'Open the link printed above as the tailnet admin to enable Serve, then re-run.'
  return ''
}

export const fileSize = (file) => {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/** Truncate a log that grew past 10 MB (logs are appended across runs). */
export const rotateLog = (file) => {
  if (fileSize(file) > 10 * 1024 * 1024) fs.writeFileSync(file, '')
}

/** `fetch` that never throws: { status, headers, text, error }. */
export async function probe(url, { timeoutMs = 15_000, headers, method, body } = {}) {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers, method, body })
    const text = await res.text()
    return { status: res.status, headers: res.headers, text, error: null }
  } catch (e) {
    const code = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(e)
    return { status: 0, headers: new Headers(), text: '', error: String(code) }
  }
}
