import { expect, test, type Page } from '@playwright/test'

import { creds, getConfig, lexicalBody, uniq, type E2EConfig } from './support/env'

/**
 * Go-live contract C1.1 / C1.4 in a REAL browser: the Payload admin editor opens an article whose body holds a
 * table (`table` > `tablerow` > `tablecell`) AND a `youtubeEmbed` block, lets an editor change text, and saves it
 * with no data loss. Without the table and blocks features registered on `articles.content`, an unregistered node
 * can stop the editor from loading the article at all.
 *
 * Synthetic data only. The stack (Postgres + production CMS build) is booted by globalSetup.
 */
const cfg: E2EConfig = getConfig()

const evidence = (msg: string) => console.log(`[evidence] ${msg}`)

const para = (text: string) => ({
  type: 'paragraph',
  format: '',
  indent: 0,
  version: 1,
  direction: 'ltr',
  textFormat: 0,
  children: [{ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
})
const cell = (text: string, headerState: number) => ({
  type: 'tablecell',
  version: 1,
  headerState,
  colSpan: 1,
  rowSpan: 1,
  backgroundColor: null,
  children: [para(text)],
})
const tableNode = () => ({
  type: 'table',
  version: 1,
  format: '',
  indent: 0,
  direction: 'ltr',
  children: [
    { type: 'tablerow', version: 1, children: [cell('Parish', 1), cell('Members', 1)] },
    { type: 'tablerow', version: 1, children: [cell('St Example', 0), cell('120', 0)] },
  ],
})
const youtubeNode = (videoId: string, title: string) => ({
  type: 'block',
  version: 2,
  format: '',
  fields: { id: 'e2e-block-1', blockName: '', blockType: 'youtubeEmbed', videoId, title },
})

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

async function signIn(page: Page): Promise<void> {
  const c = creds(cfg, 'admin')
  await page.goto(`${cfg.cmsUrl}/admin/login`)
  await page.locator('#field-email').fill(c.email)
  await page.locator('#field-password').fill(c.password)
  await page.locator('form button[type="submit"]').click()
  await page.waitForURL((u) => /^\/admin\/?$/.test(u.pathname), { timeout: 180_000 })
}

const flat = (node: any): any[] => [node, ...((node?.children ?? []) as any[]).flatMap(flat)]

test.describe('Article editor: table + youtubeEmbed block', () => {
  test('the admin editor opens an article with a table and a YouTube block and saves it without data loss', async ({ page }) => {
    test.setTimeout(420_000)
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))

    const token = await adminToken()
    const cat = (await api(token, 'GET', '/api/categories?limit=1&depth=0')).json?.docs?.[0]?.id
    expect(cat, 'the stack has a category').toBeTruthy()

    const slug = uniq('e2e-editor')
    const content = lexicalBody('Synthetic opening paragraph.') as any
    content.root.children.push(tableNode(), youtubeNode('dQw4w9WgXcQ', 'Synthetic harvest service'), para('Closing paragraph.'))
    const created = await api(token, 'POST', '/api/articles', {
      title: `E2E editor ${slug}`,
      slug,
      content,
      category: cat,
      status: 'draft',
    })
    expect(created.status, JSON.stringify(created.json?.errors)).toBe(201)
    const id = created.json.doc.id as number

    await signIn(page)
    await page.goto(`${cfg.cmsUrl}/admin/collections/articles/${id}`)

    // The editor loaded (a node it cannot load would leave this empty or show an error banner).
    const editor = page.locator('.rich-text-lexical .ContentEditable__root, .rich-text-lexical [contenteditable="true"]').first()
    await expect(editor).toBeVisible({ timeout: 240_000 })
    await expect(editor.getByText('Synthetic opening paragraph.')).toBeVisible()

    // The table is rendered as a real table with both rows and its header cells.
    const table = editor.locator('table').first()
    await expect(table).toBeVisible()
    await expect(table.locator('tr')).toHaveCount(2)
    await expect(table.getByText('St Example')).toBeVisible()
    await expect(table.getByText('Members')).toBeVisible()

    // The YouTube block is rendered with its fields.
    const videoIdInput = page.locator('.rich-text-lexical input[value="dQw4w9WgXcQ"]')
    await expect(videoIdInput).toBeVisible()
    await expect(page.locator('.rich-text-lexical input[value="Synthetic harvest service"]')).toBeVisible()

    // Edit text in the first paragraph and in a table cell, then save.
    await editor.getByText('Synthetic opening paragraph.').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' Edited in the browser.')
    await table.getByText('120').click()
    await page.keyboard.press('End')
    await page.keyboard.type('0')

    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await expect(page.getByText('Updated successfully')).toBeVisible({ timeout: 60_000 })

    const stored = await api(token, 'GET', `/api/articles/${id}?depth=0`)
    expect(stored.status).toBe(200)
    const nodes = flat(stored.json.content.root)
    const types = nodes.map((n) => n.type)
    expect(types).toContain('table')
    expect(types.filter((t) => t === 'tablerow')).toHaveLength(2)
    expect(types.filter((t) => t === 'tablecell')).toHaveLength(4)
    const text = JSON.stringify(stored.json.content)
    expect(text).toContain('Parish')
    expect(text).toContain('St Example')
    expect(text).toContain('1200')
    expect(text).toContain('Edited in the browser.')
    expect(text).toContain('Closing paragraph.')
    const block = nodes.find((n) => n.type === 'block')
    expect(block?.fields).toMatchObject({ blockType: 'youtubeEmbed', videoId: 'dQw4w9WgXcQ', title: 'Synthetic harvest service' })
    const headerStates = nodes.filter((n) => n.type === 'tablecell').map((n) => n.headerState)
    expect(headerStates).toEqual([1, 1, 0, 0])

    expect(pageErrors, `uncaught page errors: ${pageErrors.join(' | ')}`).toEqual([])
    evidence(
      `admin editor opened article ${id} with table (2 rows x 2 cells) + youtubeEmbed block; edited a paragraph and a cell; saved; ` +
        `stored body keeps table>tablerow>tablecell (${types.filter((t) => t === 'tablecell').length} cells) and the block (${block?.fields?.videoId})`,
    )
  })

  test('the editor rejects a malformed video id before saving and the server refuses it too', async ({ page }) => {
    test.setTimeout(420_000)
    const token = await adminToken()
    const cat = (await api(token, 'GET', '/api/categories?limit=1&depth=0')).json?.docs?.[0]?.id
    const slug = uniq('e2e-editor-bad')
    const content = lexicalBody('Synthetic body.') as any
    content.root.children.push(youtubeNode('dQw4w9WgXcQ', 'Valid'))
    const created = await api(token, 'POST', '/api/articles', { title: `E2E editor ${slug}`, slug, content, category: cat, status: 'draft' })
    expect(created.status).toBe(201)
    const id = created.json.doc.id as number

    await signIn(page)
    await page.goto(`${cfg.cmsUrl}/admin/collections/articles/${id}`)
    const videoIdInput = page.locator('.rich-text-lexical input[value="dQw4w9WgXcQ"]')
    await expect(videoIdInput).toBeVisible({ timeout: 240_000 })
    await videoIdInput.fill('not-valid')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await expect(page.getByText(/video id|invalid|following field/i).first()).toBeVisible({ timeout: 60_000 })

    const stored = await api(token, 'GET', `/api/articles/${id}?depth=0`)
    expect(JSON.stringify(stored.json.content)).toContain('dQw4w9WgXcQ')
    expect(JSON.stringify(stored.json.content)).not.toContain('not-valid')
    evidence('admin editor: a malformed video id was refused on save and the stored body kept the valid id')
  })
})
