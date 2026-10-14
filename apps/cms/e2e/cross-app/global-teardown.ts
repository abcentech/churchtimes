import fs from 'node:fs'
import path from 'node:path'

import { evidenceLogName, getConfig } from './support/helpers'
import { isRemote, teardownRemote } from './support/remote'
import { stopStack } from './support/stack'

/** Stops the static servers, the recording proxy, Next (whole tree) and PostgreSQL; removes the temp dirs and uploaded media. */
export default async function globalTeardown(): Promise<void> {
  if (isRemote) {
    // REMOTE: nothing was booted; delete/archive only the records carrying this run's prefix, then drop the temp fixtures.
    let cfg
    try {
      cfg = getConfig()
    } catch {
      return // setup failed before the config existed: nothing was created
    }
    await teardownRemote(cfg, (line) => {
      if (process.env.XAPP_KEEP_EVIDENCE === '0') return
      fs.mkdirSync(cfg.evidenceDir, { recursive: true })
      fs.appendFileSync(path.join(cfg.evidenceDir, evidenceLogName()), `${new Date().toISOString()}  ${line}\n`)
    })
    return
  }
  if (process.env.XAPP_ATTACH) return // the dev stack owns its own lifecycle
  await stopStack()
}
