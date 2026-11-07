/**
 * Synthetic uploads tree for the uploads checker and the loader. Invented names only; everything is generated into a
 * temp folder by the caller. `png` is the image bytes used for every picture (a real PNG for the loader, or a bare
 * signature plus filler for the checker, which only looks at magic bytes).
 */
import fs from 'node:fs'
import path from 'node:path'

export type SyntheticTree = {
  /** Relative names actually created that the checker must reject, with the expected reason code. */
  expectedRejected: Record<string, string>
  symlinkCreated: boolean
  /** Safe files with a script marker after the image data (advisory warning only: the Media re-save removes it). */
  expectedWarnings: string[]
  /** References that only match the file on disk after Unicode normalisation / lowercasing / adding a size suffix. */
  nfcRef: string
  caseRef: string
  sizeVariantOnlyRef: string
}

export function buildSyntheticUploads(root: string, png: Buffer, DIR = '2099/01'): SyntheticTree {
  const put = (rel: string, data: Buffer | string) => {
    const abs = path.join(root, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, data)
  }
  const expectedRejected: Record<string, string> = {}
  const reject = (rel: string, reason: string, data: Buffer | string) => {
    put(rel, data)
    expectedRejected[rel] = reason
  }
  const more = (s: string) => Buffer.concat([png, Buffer.from(s)]) // trailing bytes after the image: distinct content

  put(`${DIR}/a.png`, png)
  put(`${DIR}/b.png`, more('b'))
  put(`${DIR}/a-150x150.png`, more('s')) // size variant of a
  put(`${DIR}/c-300x200.png`, more('c')) // the original c.png is missing: size variant only
  put(`${DIR}/a-copy.png`, png) // same content as a.png
  put(`${DIR}/stray.png`, more('z')) // nothing refers to it
  put(`${DIR}/Case.png`, more('k'))
  put(`${DIR}/café.png`, more('u')) // decomposed (NFD) on disk

  reject(`${DIR}/shell.jpg`, 'magic-mismatch', '<?php system($_GET["x"]); ?>')
  // A script marker after valid image data is only a warning: the Media collection decodes and re-saves the picture.
  put(`${DIR}/poly.png`, more('\n<?PHP echo 1; ?>'))
  put(`${DIR}/poly2.png`, more('<ScRiPt>alert(1)</script>'))
  const expectedWarnings = [`${DIR}/poly.png`, `${DIR}/poly2.png`]
  reject(`${DIR}/evil.php`, 'dangerous-extension', '<?php echo 1;')
  reject(`${DIR}/inner.php.png`, 'dangerous-extension', png)
  reject(`${DIR}/.htaccess`, 'hidden-file', 'AddHandler application/x-httpd-php .png')
  reject(`${DIR}/run.sh`, 'dangerous-extension', '#!/bin/sh')
  reject(`${DIR}/tool.exe`, 'dangerous-extension', 'MZ')
  reject(`${DIR}/x.js`, 'dangerous-extension', 'alert(1)')
  reject(`${DIR}/x.html`, 'dangerous-extension', '<p>x</p>')
  reject(`${DIR}/x.svg`, 'dangerous-extension', '<svg/>')
  reject(`${DIR}/backup.zip`, 'dangerous-extension', 'PK')
  reject(`${DIR}/x.html.jpg`, 'dangerous-extension', png)
  reject(`${DIR}/x.svg.png`, 'dangerous-extension', png)
  reject(`${DIR}/x.js.jpg`, 'dangerous-extension', png)
  reject(`${DIR}/anim.gif`, 'unsupported-type', 'GIF89a')
  reject(`${DIR}/manual.pdf`, 'unsupported-type', '%PDF-1.4')
  reject(`${DIR}/notes.txt`, 'not-media', 'hello')
  reject(`${DIR}/noext`, 'not-media', png)
  reject(`${DIR}/empty.png`, 'zero-byte', '')
  reject(`${DIR}/fake.png`, 'magic-mismatch', 'just text')
  reject(`${DIR}/wrongtype.jpg`, 'magic-mismatch', png) // a PNG named .jpg

  // Two names for one file: refused (it may be the same data as something outside the folder).
  try {
    put(`${DIR}/hl-src.png`, more('h'))
    fs.linkSync(path.join(root, ...`${DIR}/hl-src.png`.split('/')), path.join(root, ...`${DIR}/hl.png`.split('/')))
    expectedRejected[`${DIR}/hl-src.png`] = 'hard-link'
    expectedRejected[`${DIR}/hl.png`] = 'hard-link'
  } catch {
    // Hard links not supported here: skip that case and remove the leftover plain file.
    fs.rmSync(path.join(root, ...`${DIR}/hl-src.png`.split('/')), { force: true })
  }

  let symlinkCreated = false
  try {
    fs.symlinkSync(path.join(root, ...`${DIR}/a.png`.split('/')), path.join(root, ...`${DIR}/link.png`.split('/')))
    expectedRejected[`${DIR}/link.png`] = 'symlink'
    symlinkCreated = true
  } catch {
    // Windows without the privilege to create links: that case is skipped.
  }
  // A backslash is a path separator on Windows, so that name only exists on other platforms.
  for (const name of process.platform === 'win32' ? ['ctl\u0001name.png'] : ['bad\\name.png', 'ctl\u0001name.png']) {
    try {
      put(`${DIR}/${name}`, png)
      expectedRejected[`${DIR}/${name}`] = 'bad-name'
    } catch {
      // not creatable on this platform
    }
  }
  return { expectedRejected, expectedWarnings, symlinkCreated, nfcRef: `${DIR}/café.png`, caseRef: `${DIR}/case.png`, sizeVariantOnlyRef: `${DIR}/c.png` }
}

/** A PNG signature plus filler: enough for magic-byte checks (not decodable). */
export const fakePng = (): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
