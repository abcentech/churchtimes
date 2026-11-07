import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { ROLES } from '../../src/access/roles'
import {
  DEMO_CATEGORIES,
  DEMO_TARGETS,
  DEMO_USERS,
  assertOutsideRepo,
  formatLoginsFile,
  generatePassword,
  generatePasswords,
  isDeletableDemoDataDir,
  parseDemoArgs,
  resolveDemoPaths,
  stubMp4,
  tinyMp3,
  withRealCategories,
  writeLoginsFile,
} from '../../scripts/demo-lib'
import { largeWxr } from '../fixtures/wxr/large'

const cmsRoot = path.resolve(__dirname, '../..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-demo-unit-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('demo passwords', () => {
  it('are random, long, typeable and different for every role and every run', () => {
    const a = generatePasswords()
    const b = generatePasswords()
    const all = [...Object.values(a), ...Object.values(b)]
    expect(new Set(all).size).toBe(all.length)
    for (const p of all) expect(p).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{5}(-[a-km-zA-HJ-NP-Z2-9]{5}){3}$/)
    expect(Object.keys(a).sort()).toEqual(DEMO_USERS.map((u) => u.key).sort())
  })
  it('come from the injected source (so no constant can hide in the generator)', () => {
    let i = 0
    expect(generatePassword(1, 3, () => i++)).toBe('abc')
  })
})

describe('demo file locations', () => {
  it('refuse a login file or data folder inside a git work tree', () => {
    expect(() => assertOutsideRepo(path.join(cmsRoot, 'demo-logins.txt'), 'login file')).toThrow(/inside a git work tree/)
    expect(() => writeLoginsFile(path.join(cmsRoot, 'docs', 'x-demo-logins.txt'), 'x', cmsRoot)).toThrow(/inside a git work tree/)
    expect(fs.existsSync(path.join(cmsRoot, 'docs', 'x-demo-logins.txt'))).toBe(false)
    expect(isDeletableDemoDataDir(path.join(cmsRoot, 'demo-data'))).toBe(false)
  })
  it('write the login file outside the repository (mode 600 where supported) with all five roles', () => {
    const file = path.join(tmp, 'sub', 'demo-logins.txt')
    const pw = generatePasswords()
    writeLoginsFile(file, formatLoginsFile({ cms: 'http://localhost:3000' }, pw), cmsRoot)
    const text = fs.readFileSync(file, 'utf8')
    for (const u of DEMO_USERS) {
      expect(text).toContain(u.email)
      expect(text).toContain(pw[u.key])
    }
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
  it('default to the private folders next to the repositories, overridable by env', () => {
    const d = resolveDemoPaths({}, path.join(tmp, 'home'))
    expect(d.dataDir).toBe(path.join(tmp, 'home', 'Documents', 'churchtimes', 'private', 'demo-data'))
    expect(d.loginsFile).toBe(path.join(tmp, 'home', 'Documents', 'churchtimes', 'private-reports', 'demo-logins.txt'))
    expect(resolveDemoPaths({ DEMO_DATA_DIR: path.join(tmp, 'd'), DEMO_LOGINS_FILE: path.join(tmp, 'l.txt') }).dataDir).toBe(path.join(tmp, 'd'))
    expect(isDeletableDemoDataDir(path.join(tmp, 'demo-data'))).toBe(true)
    expect(isDeletableDemoDataDir(path.join(tmp, 'photos'))).toBe(false)
  })
  it('parse options and refuse unknown ones', () => {
    expect(parseDemoArgs(['--reset']).reset).toBe(true)
    expect(() => parseDemoArgs(['--wipe-everything'])).toThrow(/Unknown option/)
  })
})

describe('demo dataset plan', () => {
  it('has one account per role and the 15 categories', () => {
    expect(DEMO_USERS.map((u) => u.role).sort()).toEqual([...ROLES].sort())
    expect(DEMO_CATEGORIES).toHaveLength(15)
    expect(new Set(DEMO_CATEGORIES.map((c) => c.slug)).size).toBe(15)
    for (const u of DEMO_USERS) for (const s of u.sections) expect(DEMO_CATEGORIES.map((c) => c.slug)).toContain(s)
  })
  it('generates enough importable posts for the published target, in the real category names', () => {
    const gen = largeWxr({ posts: DEMO_TARGETS.posts, images: DEMO_TARGETS.images, idBase: 9_000_000, prefix: 'demo', seed: 20261021, maxComments: 6 })
    expect(gen.expected.importablePosts).toBeGreaterThanOrEqual(DEMO_TARGETS.minPublished)
    const xml = withRealCategories(gen.xml, 'demo')
    expect(xml).not.toContain('demo-cat-')
    expect(xml).toContain('<wp:category_nicename><![CDATA[features]]></wp:category_nicename>')
  })
  it('makes media files that carry the signatures the upload check looks for', () => {
    expect(tinyMp3().subarray(0, 3).toString('latin1')).toBe('ID3')
    expect(stubMp4().subarray(4, 12).toString('latin1')).toBe('ftypisom')
  })
})
