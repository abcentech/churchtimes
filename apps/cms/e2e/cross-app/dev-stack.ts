/**
 * Developer helper: boots the same stack as the Playwright globalSetup and keeps it running so specs can be
 * iterated on in seconds instead of minutes.
 *
 *   npx tsx e2e/cross-app/dev-stack.ts <config-out.json>          # terminal 1 (stop with Ctrl+C or by deleting the file)
 *   XAPP_ATTACH=<config-out.json> npx playwright test -c playwright.cross-app.config.ts   # terminal 2
 *
 * The config file holds random synthetic credentials: keep it outside the repository and delete it afterwards.
 */
import fs from 'node:fs'

import { startStack, stopStack } from './support/stack'

const out = process.argv[2]
if (!out) throw new Error('usage: tsx e2e/cross-app/dev-stack.ts <config-out.json>')

const cfg = await startStack()
fs.writeFileSync(out, JSON.stringify(cfg), { mode: 0o600 })
console.log('[xapp-dev] stack ready; config written. Delete the config file or press Ctrl+C to stop.')
const stop = async () => {
  await stopStack()
  fs.rmSync(out, { force: true })
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
setInterval(() => {
  if (!fs.existsSync(out)) void stop()
}, 2000)
