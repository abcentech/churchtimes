import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { sniffKind } from '../../src/import/uploadSafety'
import { avPlaceholder, synthUploads, SynthError } from '../../src/import/synthUploads'
import { sniffAvMimes } from '../../src/lib/avMedia'
import { checkUploads } from '../../src/import/uploadsCheck'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synth-uploads-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const host = 'https://old.example.test/wp-content/uploads/'
const att = (id: number, rel: string): FixtureItem => ({ id, postType: 'attachment', status: 'inherit', attachmentUrl: `${host}${rel}`, meta: { _wp_attached_file: rel } })
const rels: string[] = []
for (let i = 0; i < 30; i++) rels.push(`2098/0${(i % 9) + 1}/Photo-${i}.jpg`)
for (let i = 0; i < 6; i++) rels.push(`2098/02/graphic-${i}.png`)
rels.push('2098/03/clip-a.mp4', '2098/03/clip-b.mp4', '2098/03/anim.gif', '2098/03/paper.pdf', '2098/03/notes.docx', '2098/03/café.webp')
const exportFile = path.join(dir, 'export.xml')
fs.writeFileSync(exportFile, wxr(rels.map((r, i) => att(100 + i, r))))

const hashTree = (root: string): string => {
  const h = crypto.createHash('sha256')
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else h.update(path.relative(root, p)).update(fs.readFileSync(p))
    }
  }
  walk(root)
  return h.digest('hex')
}

describe('synthUploads', () => {
  it('writes a tree whose uploads check matches the planted set, deterministically', async () => {
    const out = path.join(dir, 'a')
    const m = await synthUploads({ wxr: exportFile, out, seed: 7 })
    expect(m.distinctAttachmentPaths).toBe(rels.length)
    expect(m.planted['php-named-jpg']).toBe(3)
    expect(m.planted['oversize-30mb']).toBe(1)
    expect(m.planted['case-mismatch']).toBe(2)
    const report = await checkUploads(out, exportFile)
    expect(report.attachments.rejectedUnsafe).toBe(m.expected.rejectedUnsafe)
    expect(report.attachments.notImportable).toBe(m.expected.notImportable)
    expect(report.attachments.caseMismatch).toBe(m.expected.caseMismatch)
    expect(report.attachments.missing).toBe(0)
    expect(report.files.warnings).toBe(m.expected.polyglotImageWarnings)
    expect(report.attachments.sizeVariantOnly).toBe(0)
    expect(m.variants).toBeGreaterThan(0)
    // The manifest sits next to the tree, never inside it.
    expect(fs.existsSync(`${out}.synth-manifest.json`)).toBe(true)
    // Same input and seed: identical bytes.
    const again = path.join(dir, 'b')
    await synthUploads({ wxr: exportFile, out: again, seed: 7 })
    expect(hashTree(again)).toBe(hashTree(out))
  }, 120000)

  it('refuses an output folder inside a git work tree and a non-empty one', async () => {
    await expect(synthUploads({ wxr: exportFile, out: path.join(process.cwd(), 'synth-out-refused') })).rejects.toMatchObject({ code: 'SYNTH_OUT_INSIDE_REPO' })
    const full = path.join(dir, 'full')
    fs.mkdirSync(full)
    fs.writeFileSync(path.join(full, 'x'), 'x')
    await expect(synthUploads({ wxr: exportFile, out: full })).rejects.toBeInstanceOf(SynthError)
  })

  it('audio and video placeholders pass the magic checks', () => {
    expect(sniffAvMimes(avPlaceholder('mp4', 'k', 1))).toContain('video/mp4')
    expect(sniffAvMimes(avPlaceholder('m4a', 'k', 1))).toEqual(['audio/mp4'])
    expect(sniffAvMimes(avPlaceholder('webm', 'k', 1))).toEqual(['video/webm'])
    expect(sniffAvMimes(avPlaceholder('mp3', 'k', 1))).toEqual(['audio/mpeg'])
    expect(sniffAvMimes(avPlaceholder('ogg', 'k', 1))).toEqual(['audio/ogg'])
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff]))).toBe('jpg')
  })
})
