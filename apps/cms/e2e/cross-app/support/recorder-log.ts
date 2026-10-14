import type { Recorded } from '../../browser/support/recorder'

import type { XappConfig } from './helpers'

/** What the CMS really received (Origin, cookie NAMES only, status), from the recording proxy. */
export async function serverLog(cfg: XappConfig): Promise<Recorded[]> {
  return (await (await fetch(cfg.recorderUrl)).json()) as Recorded[]
}
