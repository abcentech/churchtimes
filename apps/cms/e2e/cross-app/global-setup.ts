import fs from 'node:fs'
import path from 'node:path'

import { evidenceLogName } from './support/helpers'
import { isRemote, prepareRemote } from './support/remote'
import { HOSTS, PORTS, startStack, stopStack } from './support/stack'

/** REMOTE mode (XAPP_REMOTE=1): boots nothing; checks the https URLs, logs in with the credentials file, builds the same XappConfig from env. */
async function remoteSetup(): Promise<void> {
  if (process.env.XAPP_ATTACH) throw new Error('XAPP_REMOTE=1 and XAPP_ATTACH cannot be combined.')
  const cfg = await prepareRemote()
  process.env.CT_XAPP_CONFIG = JSON.stringify(cfg) // in memory only; holds the staging passwords, never written to disk or printed
  if (process.env.XAPP_KEEP_EVIDENCE !== '0') {
    fs.mkdirSync(cfg.evidenceDir, { recursive: true })
    fs.writeFileSync(
      path.join(cfg.evidenceDir, evidenceLogName()),
      [
        'Church Times cross-app REAL UI E2E, REMOTE mode (Playwright + Chromium against a deployed https staging) - synthetic data only.',
        `Run started: ${new Date().toISOString()}  Node ${process.version}  ${process.platform}  run prefix ${cfg.runId}`,
        `Targets: public ${cfg.publicOrigin}; newsroom ${cfg.newsroomOrigin}; CMS ${cfg.cmsUrl}`,
        'Turnstile: REAL site key and secret (no bypass; a challenge that does not auto-pass fails the test with a clear message).',
        'No credentials, tokens or cookie values are written here. Records created by this run are removed by the teardown (prefix only).',
        '',
      ].join('\n'),
    )
  }
}

export default async function globalSetup(): Promise<void> {
  if (isRemote) return remoteSetup()
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
