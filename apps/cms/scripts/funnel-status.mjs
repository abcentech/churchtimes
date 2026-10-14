// Show what the on-demand staging is doing: processes, ports, funnel state, URLs.   npm run staging:funnel:status
import { findTailscale, isOwnProcess, loadConfig, markers, origins, parseArgs, pathsFor, portInUse, probe, readJson, stateDir, tsRun, tsServeConfig } from './funnel-lib.mjs'

parseArgs(process.argv.slice(2), {})
const dir = stateDir()
const p = pathsFor(dir)
const state = readJson(p.state)
const cfg = state?.ports ?? loadConfig()

console.log(`State folder : ${dir}${state ? '' : '   (no state.json: nothing is running, or it was stopped)'}`)
if (state) console.log(`Started      : ${state.startedAt}   mode: ${state.mode}   host: ${state.host}`)

const rows = [
  ['public site', 'public', cfg.publicPort, markers.serve],
  ['newsroom', 'newsroom', cfg.newsroomPort, markers.serve],
  ['CMS', 'cms', cfg.cmsPort, markers.cms],
  ['PostgreSQL', 'postgres', cfg.pgPort, markers.postgres],
]
console.log('')
console.log('Local services (127.0.0.1 only):')
for (const [label, key, port, marker] of rows) {
  const pid = state?.pids?.[key]
  const own = pid ? isOwnProcess(pid, marker) : false
  const open = await portInUse(port)
  console.log(`  ${label.padEnd(12)} port ${String(port).padEnd(6)} process ${own ? `running (pid ${pid})` : pid ? `NOT running (stale pid ${pid})` : 'none'}   listening: ${open ? 'yes' : 'no'}`)
}
if (state) {
  const noindex = (r) => /noindex/i.test(r.headers.get('x-robots-tag') ?? '')
  const tag = (r) => `HTTP ${r.status || r.error}${r.status === 200 ? (noindex(r) ? ' (noindex)' : ' (NO noindex header!)') : ''}`
  const pub = await probe(`http://127.0.0.1:${cfg.publicPort}/`, { timeoutMs: 5000 })
  const news = await probe(`http://127.0.0.1:${cfg.newsroomPort}/`, { timeoutMs: 5000 })
  const cms = await probe(`http://127.0.0.1:${cfg.cmsPort}/api/users/me`, { timeoutMs: 5000 })
  console.log('')
  console.log('Local health:')
  console.log(`  public /               ${tag(pub)}`)
  console.log(`  newsroom /             ${tag(news)}`)
  console.log(`  CMS /api/users/me      HTTP ${cms.status || cms.error}`)
}

console.log('')
const bin = state?.mode === 'funnel' || !state ? findTailscale() : null
if (bin) {
  const serve = tsServeConfig(bin)
  const funnelOn = Object.keys(serve.AllowFunnel ?? {}).filter((k) => serve.AllowFunnel[k])
  console.log('Tailscale (`tailscale funnel status`):')
  const res = tsRun(bin, ['funnel', 'status'], { timeoutMs: 30_000 })
  console.log(
    (res.stdout || res.stderr)
      .trim()
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n') || '  (empty)',
  )
  if (state?.funnels?.length) {
    const live = state.funnels.filter((f) => funnelOn.some((k) => k.endsWith(`:${f.httpsPort}`)))
    console.log(`  funnels created by this tool: ${state.funnels.map((f) => f.httpsPort).join(', ')}; currently public: ${live.map((f) => f.httpsPort).join(', ') || 'none'}`)
  }
} else if (state?.mode === 'local') {
  console.log('Funnel: not used in this run (local mode).')
} else {
  console.log('Funnel: the tailscale command line tool was not found.')
}

if (state?.origins) {
  const o = state.mode === 'funnel' ? state.origins : origins(state.host)
  console.log('')
  console.log(state.mode === 'funnel' ? 'URLs:' : 'URLs (placeholders: local mode is not public; use the 127.0.0.1 ports above):')
  console.log(`  Public site : ${o.public}`)
  console.log(`  Newsroom    : ${o.newsroom}`)
  console.log(`  CMS / admin : ${o.cms}   (admin: /admin)`)
  console.log(`Logins                  : ${p.credentialsHuman}`)
  console.log(`XAPP_REMOTE_CREDENTIALS : ${p.credentialsRemote}`)
}
