import { stopStack } from './support/stack'

/** Stops the static servers, the recording proxy, Next (whole tree) and PostgreSQL; removes the temp dirs and uploaded media. */
export default async function globalTeardown(): Promise<void> {
  if (process.env.XAPP_ATTACH) return // the dev stack owns its own lifecycle
  await stopStack()
}
