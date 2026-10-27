/**
 * `npm run uploads:synth -- --wxr <export.xml> --out <dir outside every git work tree> [--seed N] [--variant-percent 15] [--manifest <file>]`
 * Writes a synthetic wp-content/uploads tree for a real export (see src/import/synthUploads.ts). Counts only.
 */
import { SynthError, synthUploads } from '../src/import/synthUploads'

const argv = process.argv.slice(2).flatMap((a) => (/^--[a-z-]+=/.test(a) ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a]))
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n)
  return i >= 0 ? argv[i + 1] : undefined
}
try {
  const wxr = arg('--wxr')
  const out = arg('--out')
  if (!wxr || !out) throw new SynthError('SYNTH_USAGE')
  const num = (n: string) => (arg(n) === undefined ? undefined : Number(arg(n)))
  const t0 = Date.now()
  const m = await synthUploads({ wxr, out, manifest: arg('--manifest'), seed: num('--seed'), variantPercent: num('--variant-percent') }, (s) => console.log(s))
  const { private: _private, ...counts } = m
  console.log(JSON.stringify({ ...counts, seconds: Math.round((Date.now() - t0) / 100) / 10, megabytes: Math.round(m.written.bytes / 1048576) }, null, 1))
} catch (e) {
  console.error(e instanceof SynthError ? e.code : 'SYNTH_FAILED')
  if (process.env.SYNTH_DEBUG && !(e instanceof SynthError)) console.error(e) // may hold a path: local debugging only
  process.exit(1)
}
