import { expect, test, type Page } from '@playwright/test'

import { htmlToLexical } from '../../src/import/htmlToLexical'
import { creds, getConfig, uniq, type E2EConfig } from './support/env'

/**
 * Go-live contract C1.4 for the HTML to Lexical converter, in a REAL browser: an article whose body is the converter's
 * output (heading, formatted paragraph with a link, an `upload` node with its caption, a table with a merged header
 * cell and row/column headers, a `youtubeEmbed` block, a list) opens in the Payload admin editor, accepts two edits and
 * saves, and the stored body keeps every node the converter wrote.
 *
 * Synthetic data only. The stack (Postgres + CMS) is booted by globalSetup.
 */
const cfg: E2EConfig = getConfig()

const evidence = (msg: string) => console.log(`[evidence] ${msg}`)

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcxAAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function adminToken(): Promise<string> {
  const c = creds(cfg, 'admin')
  const res = await fetch(`${cfg.cmsUrl}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c),
  })
  const json: any = await res.json()
  if (res.status !== 200 || !json.token) throw new Error(`Node-side admin login failed with HTTP ${res.status}`)
  return json.token as string
}

async function api(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(`${cfg.cmsUrl}${url}`, {
    method,
    headers: { Authorization: `JWT ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    // not JSON
  }
  return { status: res.status, json }
}

async function uploadMedia(token: string, alt: string): Promise<number> {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt }))
  form.set('file', new Blob([new Uint8Array(PNG_1X1)], { type: 'image/png' }), `${uniq('import-img')}.png`)
  const res = await fetch(`${cfg.cmsUrl}/api/media`, { method: 'POST', headers: { Authorization: `JWT ${token}` }, body: form })
  const json: any = await res.json()
  if (res.status !== 201) throw new Error(`media upload failed: ${res.status} ${JSON.stringify(json?.errors)}`)
  return json.doc.id as number
}

async function signIn(page: Page): Promise<void> {
  const c = creds(cfg, 'admin')
  await page.goto(`${cfg.cmsUrl}/admin/login`)
  await page.locator('#field-email').fill(c.email)
  await page.locator('#field-password').fill(c.password)
  await page.locator('form button[type="submit"]').click()
  await page.waitForURL((u) => /^\/admin\/?$/.test(u.pathname), { timeout: 180_000 })
}

const HTML = `
<h2>Synthetic heading</h2>
<p>Synthetic opening <strong>bold</strong> text with a <a href="https://example.test/a">link</a>.</p>
<figure><img src="photo-1.jpg" alt="Synthetic photo"><figcaption>A synthetic caption</figcaption></figure>
<table>
  <thead><tr><th colspan="2">Parish report</th></tr></thead>
  <tbody>
    <tr><td>St Example</td><td>120</td></tr>
    <tr><th>Total</th><td><b>120</b></td></tr>
  </tbody>
</table>
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Synthetic harvest service"></iframe>
<ul><li>first item</li><li>second item</li></ul>
<p>Closing paragraph.</p>`

/** What must survive a round trip through the editor, as a comparable projection. */
const project = (root: any) =>
  (root.children as any[]).map((n) => {
    const text = (node: any): string => (node.type === 'text' ? node.text : (node.children ?? []).map(text).join(''))
    switch (n.type) {
      case 'heading':
        return { type: 'heading', tag: n.tag, text: text(n) }
      case 'paragraph':
        return {
          type: 'paragraph',
          runs: n.children.filter((c: any) => c.type === 'text').map((c: any) => [c.text, c.format]),
          links: n.children.filter((c: any) => c.type === 'link').map((c: any) => c.fields.url),
        }
      case 'upload':
        return { type: 'upload', relationTo: n.relationTo, value: n.value }
      case 'table':
        return {
          type: 'table',
          rows: n.children.map((r: any) =>
            r.children.map((c: any) => ({ hs: c.headerState, cs: c.colSpan, rs: c.rowSpan, text: text(c) })),
          ),
        }
      case 'block':
        return { type: 'block', videoId: n.fields.videoId, title: n.fields.title, blockType: n.fields.blockType }
      case 'list':
        return { type: 'list', listType: n.listType, items: n.children.map(text) }
      default:
        return { type: n.type }
    }
  })

test.describe('Converter output in the admin editor (C1.4)', () => {
  test('a converted article with a table and an upload node opens, takes edits and saves without data loss', async ({ page }) => {
    test.setTimeout(480_000)
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    const token = await adminToken()
    const cat = (await api(token, 'GET', '/api/categories?limit=1&depth=0')).json?.docs?.[0]?.id
    expect(cat, 'the stack has a category').toBeTruthy()
    const mediaId = await uploadMedia(token, 'Synthetic photo')

    const { content, report } = htmlToLexical(HTML, {
      oldHosts: [],
      slugMap: {},
      resolveImage: () => ({ mediaId }),
    })
    expect(report.images.resolved).toBe(1)
    expect(report.youtube).toBe(1)
    expect(report.tables.kept).toBe(1)

    const slug = uniq('e2e-import')
    const created = await api(token, 'POST', '/api/articles', { title: `E2E import ${slug}`, slug, content, category: cat, status: 'draft' })
    expect(created.status, JSON.stringify(created.json?.errors)).toBe(201)
    const id = created.json.doc.id as number

    await signIn(page)
    await page.goto(`${cfg.cmsUrl}/admin/collections/articles/${id}`)

    const editor = page.locator('.rich-text-lexical .ContentEditable__root, .rich-text-lexical [contenteditable="true"]').first()
    await expect(editor).toBeVisible({ timeout: 240_000 })
    await expect(editor.getByText('Synthetic opening')).toBeVisible()
    await expect(editor.locator('h2')).toHaveText('Synthetic heading')

    // the upload node is shown by the editor
    await expect(page.locator('.rich-text-lexical .lexical-upload').first()).toBeVisible({ timeout: 60_000 })
    await expect(editor.getByText('A synthetic caption')).toBeVisible()

    // the table: three rows, merged header cell, row header
    const table = editor.locator('table').first()
    await expect(table).toBeVisible()
    await expect(table.locator('tr')).toHaveCount(3)
    await expect(table.getByText('Parish report')).toBeVisible()
    await expect(table.getByText('St Example')).toBeVisible()
    await expect(table.locator('th[colspan="2"]')).toHaveCount(1)

    // youtube block and list
    await expect(page.locator('.rich-text-lexical input[value="dQw4w9WgXcQ"]')).toBeVisible()
    await expect(editor.getByText('second item')).toBeVisible()

    await editor.getByText('Closing paragraph.').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Edited in the browser.')
    await table.getByText('St Example').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Church')

    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await expect(page.getByText('Updated successfully')).toBeVisible({ timeout: 60_000 })

    const expected = project(structuredClone(content.root))
    const last = expected[expected.length - 1] as any
    last.runs[0][0] += ' Edited in the browser.'
    const tbl = expected.find((n: any) => n.type === 'table') as any
    tbl.rows[1][0].text = 'St Example Church'

    const stored = await api(token, 'GET', `/api/articles/${id}?depth=0`)
    expect(stored.status).toBe(200)
    expect(project(stored.json.content.root)).toEqual(expected)
    expect(stored.json.bodyMedia).toEqual([mediaId])
    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
    evidence(
      `admin editor opened converted article ${id} (heading, formatted paragraph + link, upload node with caption, table with merged header, youtubeEmbed block, list); ` +
        'edited a paragraph and a table cell; saved; the stored body equals the converted body plus those two edits',
    )
  })
})
