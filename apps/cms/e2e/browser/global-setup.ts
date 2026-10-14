import fs from 'node:fs'
import path from 'node:path'

import { cmsRoot, HOSTS, startHarnessesOnly, startStack, stopStack, type E2EConfig } from './support/stack'

/**
 * Own boot (default): disposable Postgres + Payload (next dev) + harness servers.
 * STAGING_URL set: skip the boot, use that CMS and the credentials file (default
 * `.staging/credentials.json` under apps/cms, override with STAGING_CREDENTIALS_FILE). The harness
 * servers are still started locally because the browser needs somewhere to run the "frontend" from.
 */
export default async function globalSetup(): Promise<void> {
  try {
    let cfg: E2EConfig
    const staging = process.env.STAGING_URL?.trim().replace(/\/+$/, '')
    if (staging) {
      const file = process.env.STAGING_CREDENTIALS_FILE ?? path.join(cmsRoot, '.staging/credentials.json')
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>
      // accept { "<role>": {email,password} } and the staging-up shape { users: { "<role>": {...} } }
      const credentials = (parsed.users && typeof parsed.users === 'object' ? parsed.users : parsed) as E2EConfig['credentials']
      await startHarnessesOnly()
      cfg = {
        mode: 'staging',
        nodeEnv: 'unknown (STAGING_URL)',
        cmsUrl: staging,
        newsroomOrigin: process.env.E2E_NEWSROOM_ORIGIN ?? HOSTS.newsroom,
        publicOrigin: process.env.E2E_PUBLIC_ORIGIN ?? HOSTS.public,
        evilOrigin: HOSTS.evil,
        siblingOrigin: HOSTS.sibling,
        credentials,
      }
    } else {
      cfg = await startStack()
    }
    process.env.CT_E2E_CONFIG = JSON.stringify(cfg) // inherited by the worker processes (in memory only)
  } catch (err) {
    await stopStack()
    throw err
  }
}
