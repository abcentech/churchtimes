// Stop the on-demand staging published with Tailscale Funnel. Idempotent. Keeps the data unless --wipe.
//
//   npm run staging:funnel:down                 turn off the three funnels this tool created, stop the services and PostgreSQL
//   npm run staging:funnel:down -- --dry-run    print what would happen
//   npm run staging:funnel:down -- --reset-all  ALSO run `tailscale funnel reset` + `tailscale serve reset` (removes the other Tailscale serve/funnel config of this PC too)
//   npm run staging:funnel:down -- --wipe       additionally delete the state folder (database, secrets, logins) after you type DELETE
//   (non-interactive wipe: --wipe --confirm DELETE)
import fs from 'node:fs'

import {
  askVisible,
  fail,
  FUNNEL_PORTS,
  findTailscale,
  funnelOffCommands,
  isOwnProcess,
  killTree,
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
  warn,
} from './funnel-lib.mjs'

const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'reset-all', 'wipe'], options: ['confirm'] })
const dry = !!args['dry-run']
const dir = stateDir()
const p = pathsFor(dir)
const state = readJson(p.state)

if (args.wipe && !dry) {
  const word = args.confirm ?? (await askVisible(`This DELETES ${dir} (database, secrets, Turnstile keys, logins). Type DELETE to continue: `).catch(() => ''))
  if (word !== 'DELETE') fail('Not confirmed; nothing was stopped or deleted.')
}

// ---- 1. funnels (first, so nothing public points at a dead port)
const bin = state?.tailscaleBin ? (dry ? 'tailscale' : findTailscale()) : null
const funnels = state?.funnels ?? []
if (funnels.length || args['reset-all']) {
  if (!bin) {
    warn('The tailscale command line tool was not found, so the funnels could not be turned off from here. Run `tailscale funnel status` yourself and turn them off, or install/sign in again.')
  } else {
    const syntax = state?.funnelSyntax ?? tsSyntax(dry ? { major: 1, minor: 99 } : tsVersion(bin))
    for (const f of funnels) {
      for (const c of funnelOffCommands(syntax, f)) {
        if (dry) {
          console.log(`[dry-run] tailscale ${c.join(' ')}`)
          continue
        }
        const res = tsRun(bin, c, { timeoutMs: 30_000 })
        if (res.status !== 0) warn(`\`tailscale ${c.join(' ')}\` said: ${(res.stderr || res.stdout).trim().split('\n')[0] || `exit ${res.status}`}`)
      }
      if (!dry) log(`funnel on port ${f.httpsPort} (${f.name}) turned off`)
    }
    if (args['reset-all']) {
      for (const c of [['funnel', 'reset'], ['serve', 'reset']]) {
        if (dry) console.log(`[dry-run] tailscale ${c.join(' ')}`)
        else {
          const res = tsRun(bin, c, { timeoutMs: 30_000 })
          log(`tailscale ${c.join(' ')} -> ${res.status === 0 ? 'done' : 'failed'}`)
        }
      }
    } else if (!dry) {
      // Confirm none of our ports is still served; if the CLI left something behind, say how to remove it.
      const serve = tsServeConfig(bin)
      const ours = new Set(funnels.map((f) => f.httpsPort))
      const left = Object.keys(serve.Web ?? {}).filter((k) => Object.values(FUNNEL_PORTS).includes(Number(k.split(':').pop())) && ours.has(Number(k.split(':').pop())))
      if (left.length) warn(`Tailscale still lists ${left.join(', ')}. Run \`npm run staging:funnel:down -- --reset-all\` (it also clears your other serve/funnel config), or \`tailscale serve status\` to inspect.`)
    }
  }
} else {
  log('no funnels were recorded as created by this tool')
}

// ---- 2. processes (public site, newsroom, CMS, then PostgreSQL)
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

if (!dry && state) {
  fs.rmSync(p.state, { force: true })
  fs.rmSync(p.pgReady, { force: true })
}

// ---- 3. data
if (args.wipe) {
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
  log(`data kept in ${dir} (database, logins, Turnstile keys). \`--wipe\` deletes it.`)
}
