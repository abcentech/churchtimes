/**
 * `npm run test:e2e:remote [-- <playwright args>]`: runs the cross-app lane in REMOTE mode against a deployed https staging
 * (no new dependency, works on Windows and POSIX). Sets XAPP_REMOTE=1 and forwards everything else to Playwright.
 *
 *   XAPP_PUBLIC_URL=... XAPP_NEWSROOM_URL=... XAPP_CMS_URL=... XAPP_REMOTE_CREDENTIALS=<file> npm run test:e2e:remote
 *   npm run test:e2e:remote -- --headed        # same as XAPP_HEADED=1 (a human can click a Turnstile challenge)
 *   npm run test:e2e:remote -- --plan          # no browser, no network: which tests run remotely and which skip (and why)
 *   npm run test:e2e:remote -- --grep "L1"     # any other Playwright option
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const cmsRoot = path.resolve(here, '../..')
const require = createRequire(import.meta.url)
const cli = require.resolve('@playwright/test/cli')

const args = process.argv.slice(2)
const env = { ...process.env, XAPP_REMOTE: '1' }
const take = (flag) => {
  const i = args.indexOf(flag)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}
if (take('--headed')) env.XAPP_HEADED = '1'
const plan = take('--plan')

const base = ['test', '-c', 'playwright.cross-app.config.ts']
if (!plan) {
  const res = spawnSync(process.execPath, [cli, ...base, ...args], { cwd: cmsRoot, env, stdio: 'inherit' })
  process.exit(res.status ?? 1)
}

// --plan: list the tests with the JSON reporter and print run / skip per test (statically skipped tests carry expectedStatus "skipped").
const res = spawnSync(process.execPath, [cli, ...base, '--list', '--reporter=json', ...args], { cwd: cmsRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
if (res.status !== 0) {
  process.stderr.write(res.stderr || res.stdout)
  process.exit(res.status ?? 1)
}
const report = JSON.parse(res.stdout)
const rows = []
const walk = (suite, trail) => {
  const here = suite.title && !suite.title.endsWith('.ts') ? [...trail, suite.title] : trail
  for (const s of suite.specs ?? []) {
    for (const t of s.tests ?? []) {
      const skipped = t.expectedStatus === 'skipped' || (t.annotations ?? []).some((a) => a.type === 'skip')
      const why = (t.annotations ?? []).find((a) => a.type === 'skip')?.description ?? ''
      rows.push({ file: suite.file ?? '', project: t.projectName, title: s.title, skipped, why })
    }
  }
  for (const c of suite.suites ?? []) walk(c, here)
}
for (const s of report.suites ?? []) walk(s, [])
let runN = 0
let skipN = 0
for (const r of rows) {
  r.skipped ? skipN++ : runN++
  console.log(`${r.skipped ? 'SKIP' : 'RUN '}  [${r.project}] ${r.file}  ${r.title}${r.skipped && r.why ? `\n        reason: ${r.why}` : ''}`)
}
console.log(`\nRemote plan: ${runN} run, ${skipN} skipped (${rows.length} total across projects).`)
