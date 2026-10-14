import fs from 'node:fs'
import path from 'node:path'

import { evidenceLogName } from './support/helpers'
import { HOSTS, PORTS, startStack, stopStack } from './support/stack'

export default async function globalSetup(): Promise<void> {
  try {
    // XAPP_ATTACH=<file> reuses a stack started by `tsx e2e/cross-app/dev-stack.ts` (developer loop); nothing is started or stopped here.
    const attach = process.env.XAPP_ATTACH
    const cfg = attach ? JSON.parse(fs.readFileSync(attach, 'utf8')) : await startStack()
    process.env.CT_XAPP_CONFIG = JSON.stringify(cfg) // inherited by the worker processes (in memory only)
    if (process.env.XAPP_KEEP_EVIDENCE !== '0') {
      fs.mkdirSync(cfg.evidenceDir, { recursive: true })
      fs.writeFileSync(
        path.join(cfg.evidenceDir, evidenceLogName()),
        [
          'Church Times cross-app REAL UI E2E (Playwright + Chromium) - synthetic data only, no credentials.',
          `Run started: ${new Date().toISOString()}  Node ${process.version}  ${process.platform}`,
          `Stack: embedded PostgreSQL :${PORTS.pg}; Payload CMS (next start, production build) ${HOSTS.cms} (proxy) -> :${PORTS.cmsInternal};`,
          `       REAL public site (vite build) ${HOSTS.public}; REAL newsroom SPA (vite build apps/newsroom) ${HOSTS.newsroom}.`,
          'Turnstile: real Cloudflare widget from challenges.cloudflare.com with the always-pass TEST site key; the CMS verifies against the always-pass TEST secret.',
          'Nothing in this lane is mocked unless a test title says HARNESS.',
          '',
        ].join('\n'),
      )
    }
  } catch (err) {
    if (!process.env.XAPP_ATTACH) await stopStack()
    throw err
  }
}
