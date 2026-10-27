/**
 * Pure helpers for `npm run demo` (scripts/demo.ts) and its seeder (scripts/demo-seed.ts). No Payload, no database,
 * no network: these are what the unit test (tests/unit/demo.test.ts) pins down.
 *
 * The rules this file enforces:
 *   - the demo passwords are random per run (crypto), never constants, never printed;
 *   - the login file and the data directory live OUTSIDE every git work tree (a login file inside the repository could be
 *     committed by accident), refused otherwise.
 */
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isInsideRepo } from '../src/import/safePaths'

/** The five staff roles, one demo account each. `sections` are category slugs. */
export const DEMO_USERS = [
  { key: 'admin', email: 'demo-admin@churchtimes.local', name: 'Demo Admin', role: 'admin', sections: [] as string[] },
  { key: 'editor-in-chief', email: 'demo-editor-in-chief@churchtimes.local', name: 'Demo Editor-in-Chief', role: 'editor-in-chief', sections: [] },
  { key: 'section-editor', email: 'demo-section-editor@churchtimes.local', name: 'Demo Section Editor (News, Features)', role: 'section-editor', sections: ['news', 'features'] },
  { key: 'reporter', email: 'demo-reporter@churchtimes.local', name: 'Demo Reporter', role: 'reporter', sections: [] },
  { key: 'trusted-publisher', email: 'demo-trusted-publisher@churchtimes.local', name: 'Demo Trusted Publisher (Opinion)', role: 'trusted-publisher', sections: ['opinion', 'columnists'] },
] as const

export type DemoUserKey = (typeof DEMO_USERS)[number]['key']

/** The 15 categories of the Church Times Nigeria export (the first 12 are the ones the archive rules know by name). */
export const DEMO_CATEGORIES: ReadonlyArray<{ slug: string; title: string }> = [
  { slug: 'news', title: 'News' },
  { slug: 'features', title: 'Features' },
  { slug: 'opinion', title: 'Opinion' },
  { slug: 'columnists', title: 'Columnists' },
  { slug: 'interviews', title: 'Interviews' },
  { slug: 'business', title: 'Business' },
  { slug: 'education', title: 'Education' },
  { slug: 'health', title: 'Health' },
  { slug: 'publishers-note', title: "Publisher's Note" },
  { slug: 'advertorial', title: 'Advertorial' },
  { slug: 'book-review', title: 'Book Review' },
  { slug: 'special-report', title: 'Special Report' },
  { slug: 'missions', title: 'Missions' },
  { slug: 'youth', title: 'Youth' },
  { slug: 'worship-music', title: 'Worship and Music' },
]

/** What the seeder aims for. The test and the seeder's own final check both read these. */
export const DEMO_TARGETS = {
  /** Synthetic posts handed to the importer (about 5% are password-protected or drafts and are not published). */
  posts: 330,
  minPublished: 280,
  images: 40,
  minComments: 40,
  avArticles: 3,
  archiveDrafts: 5,
  inReview: 2,
  scheduled: 1,
  campaigns: 4,
  redirects: 30,
} as const

/** Easy to read out and to type: no 0/O, 1/l/I look-alikes. Groups of five, 20 random characters (about 114 bits). */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generatePassword(groups = 4, groupLen = 5, pick: (max: number) => number = (n) => randomInt(n)): string {
  const parts: string[] = []
  for (let g = 0; g < groups; g++) {
    let part = ''
    for (let i = 0; i < groupLen; i++) part += ALPHABET[pick(ALPHABET.length)]
    parts.push(part)
  }
  return parts.join('-')
}

export type DemoPasswords = Record<DemoUserKey, string>

/** One new random password per role; the five are always distinct. */
export function generatePasswords(): DemoPasswords {
  const out = {} as DemoPasswords
  const seen = new Set<string>()
  for (const u of DEMO_USERS) {
    let p = generatePassword()
    while (seen.has(p)) p = generatePassword()
    seen.add(p)
    out[u.key] = p
  }
  return out
}

/** `<home>/Documents/churchtimes/private/...`: next to the repositories, never inside one. */
export function defaultPrivateRoot(home: string = os.homedir()): string {
  return path.join(home, 'Documents', 'churchtimes', 'private')
}

export type DemoPaths = { dataDir: string; loginsFile: string }

/** Defaults follow the owner's layout; DEMO_DATA_DIR and DEMO_LOGINS_FILE override them (still checked by assertOutsideRepo). */
export function resolveDemoPaths(env: Record<string, string | undefined> = process.env, home: string = os.homedir()): DemoPaths {
  const root = defaultPrivateRoot(home)
  const dataDir = path.resolve(env.DEMO_DATA_DIR || path.join(root, 'demo-data'))
  // The default login file sits in the sibling folder the owner already uses for private reports.
  const loginsFile = path.resolve(env.DEMO_LOGINS_FILE || path.join(path.dirname(root), 'private-reports', 'demo-logins.txt'))
  return { dataDir, loginsFile }
}

/** Throws unless `target` is outside every git work tree (and is not a network or device path). */
export function assertOutsideRepo(target: string, label: string, cwd: string = process.cwd()): void {
  if (isInsideRepo(target, cwd)) {
    throw new Error(
      `${label} (${target}) is inside a git work tree or on a network/device path. Choose a folder outside every repository, ` +
        'for example C:\\Users\\<you>\\Documents\\churchtimes\\private.',
    )
  }
}

/** The text of the login file. Passwords appear here and nowhere else. */
export function formatLoginsFile(urls: { cms: string; newsroom?: string; public?: string }, passwords: DemoPasswords, now: Date = new Date()): string {
  const lines = [
    'CHURCH TIMES DEMO LOGINS (local test data only, generated ' + now.toISOString() + ')',
    'New random passwords are made every time you run `npm run demo`. Do not commit or share this file.',
    '',
    `CMS admin screen : ${urls.cms}/admin`,
    ...(urls.newsroom ? [`Newsroom app     : ${urls.newsroom}`] : []),
    '',
  ]
  for (const u of DEMO_USERS) {
    lines.push(`${u.role.padEnd(18)} email: ${u.email}`)
    lines.push(`${' '.repeat(18)} password: ${passwords[u.key]}`)
    lines.push('')
  }
  return lines.join('\n')
}

/** Writes the login file (mode 600 where the OS supports it) after the location guard. Returns the path. */
export function writeLoginsFile(file: string, content: string, cwd: string = process.cwd()): string {
  assertOutsideRepo(file, 'The demo login file', cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600) // an existing file keeps its old mode otherwise (no-op on Windows)
  } catch {
    // not supported on this file system
  }
  return file
}

/** True when `dir` is a demo data folder this script may delete: outside every repo and named like the demo's own. */
export function isDeletableDemoDataDir(dir: string): boolean {
  return path.basename(path.resolve(dir)).toLowerCase().startsWith('demo') && !isInsideRepo(dir)
}

export type DemoArgs = { reset: boolean; noPublic: boolean; noNewsroom: boolean; build: boolean; help: boolean }

export function parseDemoArgs(argv: readonly string[]): DemoArgs {
  const known = new Set(['--reset', '--no-public', '--no-newsroom', '--build', '--help', '-h'])
  for (const a of argv) if (!known.has(a)) throw new Error(`Unknown option "${a}". Options: --reset, --no-public, --no-newsroom, --build, --help.`)
  return { reset: argv.includes('--reset'), noPublic: argv.includes('--no-public'), noNewsroom: argv.includes('--no-newsroom'), build: argv.includes('--build'), help: argv.includes('--help') || argv.includes('-h') }
}

/** WXR text with the generator's 12 invented categories renamed to the first 12 real ones (the importer then creates those). */
export function withRealCategories(xml: string, prefix: string): string {
  let out = xml
  for (let i = 0; i < 12; i++) {
    const real = DEMO_CATEGORIES[i]!
    out = out.split(`${prefix}-cat-${i}`).join(real.slug)
    out = out.split(`${prefix} Section ${i} &amp; more`).join(real.title.replace(/&/g, '&amp;'))
  }
  return out
}

/** Smallest silent MPEG-1 Layer III stream that players accept: ID3v2 header then valid 128 kbit/s 44.1 kHz frames (about 1 s). */
export function tinyMp3(): Buffer {
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0])
  const frame = Buffer.alloc(417)
  frame.set([0xff, 0xfb, 0x90, 0x00])
  return Buffer.concat([header, ...Array.from({ length: 40 }, () => frame)])
}

/** A file the upload check accepts as video/mp4 (right `ftyp` signature). It is a stub: it will not play. */
export function stubMp4(): Buffer {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
  return Buffer.from([0, 0, 0, 24, ...ascii('ftypisom'), 0, 0, 2, 0, ...ascii('isomiso2'), ...new Array(64).fill(0)])
}
