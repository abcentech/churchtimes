// Stop the on-demand staging published with Tailscale Funnel. Idempotent. Keeps the data unless --wipe.
//
//   npm run staging:funnel:down                 turn off the Funnel entries this tool created, stop the services and PostgreSQL
//   npm run staging:funnel:down -- --dry-run    print what would happen
//   npm run staging:funnel:down -- --reset-all  ALSO run `tailscale funnel reset` + `tailscale serve reset` (removes the other Tailscale serve/funnel config of this PC too)
//   npm run staging:funnel:down -- --wipe       additionally delete the state folder (database, secrets, logins, uploads) after you type DELETE
//   (non-interactive wipe: --wipe --confirm DELETE)
//
// A funnel only counts as off when `tailscale ... off` exited 0 AND `tailscale serve status --json` no longer lists its port. Anything
// that cannot be confirmed stays recorded in state.json, the exit code is 1, and the next run retries it. Entries that forward to this
// tool's local ports are found in the Tailscale config even when state.json is missing.
import fs from 'node:fs'

import {
  askVisible,
  entriesToOurPorts,
  fail,
  findTailscale,
  funnelOffCommands,
  isOwnProcess,
  isPortListed,
  killTree,
  loadConfig,
  log,
  markers,
  parseArgs,
  pathsFor,
  pidAlive,
  readJson,
  sleep,
  stateDir,
  tsRun,
  tsServeConfig,
  tsSyntax,
  tsVersion,
  turnOffFunnels,
  warn,
} from './funnel-lib.mjs'

const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'reset-all', 'wipe'], options: ['confirm'] })
const dry = !!args['dry-run']
const dir = stateDir()
const p = pathsFor(dir)
const state = readJson(p.state)
const cfg = state?.ports ?? loadConfig()

if (args.wipe && !dry) {
  const word = args.confirm ?? (await askVisible(`This DELETES ${dir} (database, secrets, Turnstile keys, logins, uploads). Type DELETE to continue: `).catch(() => ''))
  if (word !== 'DELETE') fail('Not confirmed; nothing was stopped or deleted.')
}

// ---- 1. funnels first, so nothing public points at a dead port
const bin = findTailscale()
const funnels = [...(state?.funnels ?? [])]
let unverified = false
if (bin) {
  // Also catch entries that point at our ports but are missing from state.json (state lost, or an earlier run died).
  const serve = tsServeConfig(bin)
  if (!serve) {
    unverified = true
    warn('`tailscale serve status --json` could not be read, so it is unknown whether any Funnel entry is still on. Fix the Tailscale service and re-run.')
  }
  for (const e of entriesToOurPorts(serve, cfg).filter((x) => x.funnel)) {
    if (!funnels.some((f) => f.httpsPort === e.httpsPort)) funnels.push({ name: e.name, httpsPort: e.httpsPort, localPort: e.localPort })
  }
}
let remaining = []
if (!funnels.length && !args['reset-all']) {
  log('no Funnel entries of this tool are recorded or found')
} else if (!bin) {
  warn(
    `The tailscale command line tool was not found, so the funnels could NOT be turned off from here (port(s) ${funnels.map((f) => f.httpsPort).join(', ')}). ` +
      'They may still be public. Install/sign in to Tailscale again and re-run, or run `tailscale funnel status` yourself.',
  )
  remaining = funnels
} else if (dry) {
  const syntax = state?.funnelSyntax ?? 'modern'
  for (const f of funnels) for (const c of funnelOffCommands(syntax, f)) console.log(`[dry-run] tailscale ${c.join(' ')}   (then confirmed with \`tailscale serve status --json\`)`)
  if (args['reset-all']) for (const c of [['funnel', 'reset'], ['serve', 'reset']]) console.log(`[dry-run] tailscale ${c.join(' ')}`)
} else {
  const syntax = state?.funnelSyntax ?? tsSyntax(tsVersion(bin))
  remaining = turnOffFunnels(bin, syntax, funnels)
  if (args['reset-all']) {
    for (const c of [['funnel', 'reset'], ['serve', 'reset']]) {
      const res = tsRun(bin, c, { timeoutMs: 30_000 })
      log(`tailscale ${c.join(' ')} -> ${res.status === 0 ? 'done' : 'failed'}`)
    }
    const after = tsServeConfig(bin)
    remaining = after ? funnels.filter((f) => isPortListed(after, f.httpsPort)) : funnels
  }
  if (remaining.length && !args['reset-all']) {
    warn(`Run \`npm run staging:funnel:down -- --reset-all\` (it also clears your other serve/funnel config), or inspect \`tailscale serve status\` and remove port(s) ${remaining.map((f) => f.httpsPort).join(', ')} by hand.`)
  }
}

// ---- 2. processes (public site, newsroom, CMS, then PostgreSQL). Stopped even when a funnel could not be confirmed off.
const stopped = []
const killed = []
for (const [name, marker] of [
  ['public', markers.serve],
  ['newsroom', markers.serve],
  ['cms', markers.cms],
  ['postgres', markers.postgres],
]) {
  const pid = state?.pids?.[name]
  if (!pid) continue
  if (isOwnProcess(pid, marker)) {
    if (dry) console.log(`[dry-run] stop ${name} (pid ${pid}) with taskkill /T /F`)
    else {
      killTree(pid)
      killed.push(pid)
    }
    stopped.push(`${name} (pid ${pid})`)
  } else if (pidAlive(pid)) {
    warn(`pid ${pid} (${name} in a stale state.json) now belongs to another program; not killing it.`)
  }
}
if (!dry) {
  for (let i = 0; i < 80 && killed.some(pidAlive); i++) await sleep(250)
  for (const pid of killed) if (pidAlive(pid)) warn(`pid ${pid} is still running.`)
}
log(stopped.length ? `${dry ? 'would stop' : 'stopped'}: ${stopped.join(', ')}` : 'no staging process was running')

// ---- 3. state: the record of what is still public is kept until every funnel is confirmed off
if (!dry) {
  fs.rmSync(p.pgReady, { force: true })
  if (remaining.length && fs.existsSync(dir)) {
    // (state may be null when the entries were only found in the Tailscale config)
    fs.writeFileSync(p.state, JSON.stringify({ ...(state ?? { startedAt: new Date().toISOString(), mode: 'funnel' }), pids: {}, ready: false, funnels: remaining }, null, 2) + '\n', { mode: 0o600 })
  } else if (state) {
    fs.rmSync(p.state, { force: true })
  }
}

if (unverified) process.exitCode = 1
if (remaining.length) {
  console.error(
    `[funnel] FAILED: Funnel port(s) ${remaining.map((f) => f.httpsPort).join(', ')} could not be confirmed off and are probably STILL PUBLIC (they now forward to nothing). ` +
      'The record is kept in state.json; re-run this command, or use --reset-all.',
  )
  if (args.wipe) console.error('[funnel] --wipe was skipped so the record is not lost.')
  process.exitCode = 1
} else if (args.wipe) {
  if (dry) console.log(`[dry-run] delete ${dir}`)
  else {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      log(`deleted ${dir}`)
    } catch (err) {
      console.error(`[funnel] could not fully delete ${dir}: ${err instanceof Error ? err.message : err}`)
      process.exitCode = 1
    }
  }
} else {
  log(`data kept in ${dir} (database, logins, Turnstile keys, uploads). \`--wipe\` deletes it.`)
}
