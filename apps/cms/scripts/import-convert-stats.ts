/**
 * `npm run import:convert-wxr -- --file <export.xml> [--detail-file <path outside every repo>] [--old-host a.test] [--assume-images]`
 * Converts every published post of a real export in memory (no database, no network) and prints COUNTS ONLY.
 * Legacy ids of posts needing attention go to `--detail-file` (outside every repository, owner-only).
 */
import fs from 'node:fs'
import path from 'node:path'

import { convertWxrStats, formatConvertStats } from '../src/import/convertStats'
import { PrivateOutError, privateOutProblem, writePrivateOut } from '../src/import/privateOut'
import { isInsideRepo } from '../src/import/safePaths'
import { readWxrFile } from '../src/import/wxr'

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const val = (n: string) => {
    const i = argv.indexOf(n)
    const v = i >= 0 ? argv[i + 1] : undefined
    return v && !v.startsWith('--') ? v : undefined
  }
  const file = val('--file')
  const detail = val('--detail-file')
  if (!file) {
    console.error('CONVERT_USAGE')
    return 2
  }
  if (isInsideRepo(file) || (detail && isInsideRepo(detail))) {
    console.error('CONVERT_PATH_INSIDE_REPO')
    return 2
  }
  // Checked before the (slow) conversion: the detail file is created exclusively and can never be the export itself.
  const problem = detail ? privateOutProblem(path.resolve(detail), { inputs: [path.resolve(file)] }) : null
  if (problem) {
    console.error(`CONVERT_DETAIL_${problem}`)
    return 2
  }
  const { stats, detail: d } = await convertWxrStats(() => readWxrFile(path.resolve(file)), {
    oldHosts: (val('--old-host') ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    assumeImages: argv.includes('--assume-images'),
  })
  console.log(formatConvertStats(stats))
  if (detail) {
    try {
      writePrivateOut(path.resolve(detail), `${JSON.stringify(d, null, 1)}\n`, { inputs: [path.resolve(file)] })
    } catch (err) {
      console.error(`CONVERT_DETAIL_${err instanceof PrivateOutError ? err.code : 'OUT_FAILED'}`)
      return 2
    }
    console.log('Legacy ids written to the detail file.')
  }
  return Object.keys(stats.failedByCode).length > 0 ? 1 : 0
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`CONVERT_FAILED ${e instanceof Error ? e.name : 'Error'}`)
    process.exit(1)
  },
)
