import fs from 'node:fs'
import path from 'node:path'

import { expect, test, type Browser, type BrowserContext, type TestInfo } from '@playwright/test'

import {
  call,
  creds,
  firstCategoryId,
  getConfig,
  lexicalBody,
  login,
  openHarness,
  serverLog,
  signJwt,
  trackCms,
  uniq,
  type E2EConfig,
  type Role,
} from './support/env'

const cfg: E2EConfig = getConfig()
const evidenceDir = path.resolve(import.meta.dirname, '../../docs/evidence')
const COOKIE = 'payload-token'

const evidence = (msg: string) => console.log(`[evidence] ${msg}`)

// ---- helpers -------------------------------------------------------------------------------------

/** A second, independent browser session (own cookie jar) with the project's device settings. */
async function newSession(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const { viewport, userAgent, isMobile, hasTouch, deviceScaleFactor } = testInfo.project.use
  return browser.newContext({ viewport, userAgent, isMobile, hasTouch, deviceScaleFactor })
}

/** Node-side (no browser, Authorization header) API access for arranging and verifying state only. */
async function nodeToken(role: Role): Promise<string> {
  const c = creds(cfg, role)
  const res = await fetch(`${cfg.cmsUrl}/api/users/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(c),
  })
  const json: any = await res.json()
  if (res.status !== 200 || !json.token) throw new Error(`Node-side login as ${role} failed with HTTP ${res.status}`)
  return json.token as string
}

async function nodeApi(token: string, method: string, url: string, body?: unknown) {
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

async function categoryId(token: string): Promise<number | string> {
  const r = await nodeApi(token, 'GET', '/api/categories?limit=1&depth=0')
  const id = r.json?.docs?.[0]?.id
  if (id === undefined) throw new Error('The CMS has no category to attach test articles to.')
  return id
}

async function payloadCookie(context: BrowserContext) {
  return (await context.cookies(cfg.cmsUrl)).find((c) => c.name === COOKIE)
}

// ---- 1. same-site subdomain cookie lifecycle -----------------------------------------------------

test.describe('1. same-site subdomains: newsroom -> cms with credentials:include', () => {
  test('login sets an HttpOnly / SameSite=Lax / host-only cookie; /me works; JS cannot read it; logout clears it', async ({
    page,
    context,
  }) => {
    const track = trackCms(context, cfg.cmsUrl)
    await openHarness(page, cfg.newsroomOrigin)
    const anon = await call(page, `${cfg.cmsUrl}/api/users/me?probe=anon`)
    expect(anon.status).toBe(200)
    expect(anon.json.user).toBeNull()
    // CORS grant for the allowlisted origin: exact echo (never *), credentials allowed
    const anonRes = (await track.all('probe=anon'))[0]
    expect(anonRes.requestHeaders.origin).toBe(cfg.newsroomOrigin)
    expect(anonRes.responseHeaders?.['access-control-allow-origin']).toBe(cfg.newsroomOrigin)
    expect(anonRes.responseHeaders?.['access-control-allow-credentials']).toBe('true')

    const res = await login(page, cfg, 'editor')
    expect(res.status).toBe(200)
    expect(res.json.user.email).toBe(creds(cfg, 'editor').email)

    const cookie = await payloadCookie(context)
    expect(cookie, 'payload-token cookie is stored for the CMS host').toBeTruthy()
    expect(cookie!.httpOnly).toBe(true)
    expect(cookie!.sameSite).toBe('Lax')
    expect(cookie!.path).toBe('/')
    expect(cookie!.domain.replace(/^\./, '')).toBe(new URL(cfg.cmsUrl).hostname)
    expect(cookie!.domain.startsWith('.'), 'host-only: no Domain attribute, so no leading dot').toBe(false)
    expect(cookie!.expires).toBeGreaterThan(Date.now() / 1000)
    if (cfg.mode === 'local-dev') expect(cookie!.secure, 'production build sets Secure').toBe(true)
    evidence(
      `cookie ${COOKIE}: domain=${cookie!.domain} path=${cookie!.path} httpOnly=${cookie!.httpOnly} secure=${cookie!.secure} ` +
        `sameSite=${cookie!.sameSite} lifetime=${Math.round(cookie!.expires - Date.now() / 1000)}s (CMS NODE_ENV=${cfg.nodeEnv})`,
    )

    // Not visible to the newsroom page, and not stored for the newsroom host at all.
    expect(await page.evaluate(() => document.cookie)).not.toContain(COOKIE)
    expect((await context.cookies(cfg.newsroomOrigin)).find((c) => c.name === COOKIE)).toBeUndefined()

    // credentials:'include' carries the session; credentials:'omit' does not
    const me = await call(page, `${cfg.cmsUrl}/api/users/me`)
    expect(me.status).toBe(200)
    expect(me.json.user.email).toBe(creds(cfg, 'editor').email)
    const omitted = await call(page, `${cfg.cmsUrl}/api/users/me`, { credentials: 'omit' })
    expect(omitted.json.user).toBeNull()

    // HttpOnly also holds on the CMS origin itself (the admin UI's origin)
    await page.goto(`${cfg.cmsUrl}/api/users/me`)
    expect(await page.evaluate(() => document.cookie)).not.toContain(COOKIE)

    // logout (from the newsroom origin) clears the cookie and the session
    await openHarness(page, cfg.newsroomOrigin)
    const out = await call(page, `${cfg.cmsUrl}/api/users/logout`, { method: 'POST' })
    expect(out.status).toBe(200)
    expect(await payloadCookie(context)).toBeUndefined()
    const after = await call(page, `${cfg.cmsUrl}/api/users/me`)
    expect(after.json.user).toBeNull()
  })

  test('reporter cannot publish (403 surfaced to the browser); editor approves (200)', async ({ page, context, browser }, testInfo) => {
    const track = trackCms(context, cfg.cmsUrl)
    await openHarness(page, cfg.newsroomOrigin)
    expect((await login(page, cfg, 'reporter')).status).toBe(200)
    const cat = await firstCategoryId(page, cfg)

    const slug = uniq('e2e-wf')
    const created = await call(page, `${cfg.cmsUrl}/api/articles`, {
      method: 'POST',
      body: { title: `E2E workflow ${slug}`, slug, content: lexicalBody(), category: cat, status: 'draft' },
    })
    expect(created.status).toBe(201)
    const id = created.json.doc.id

    const publish = await call(page, `${cfg.cmsUrl}/api/articles/${id}`, { method: 'PATCH', body: { status: 'published' } })
    expect(publish.status, 'a reporter must not publish').toBe(403)
    expect(publish.json.errors?.length).toBeGreaterThan(0)
    const patchReqs = (await track.all(`/api/articles/${id}`)).filter((s) => s.method === 'PATCH')
    expect(patchReqs[0].responseHeaders?.['access-control-allow-origin'], 'the 403 body is readable by the allowlisted origin').toBe(
      cfg.newsroomOrigin,
    )
    evidence(`reporter PATCH status=published -> HTTP ${publish.status}: ${JSON.stringify(publish.json.errors?.[0]?.message)}`)

    const submit = await call(page, `${cfg.cmsUrl}/api/articles/${id}`, { method: 'PATCH', body: { status: 'in_review' } })
    expect(submit.status).toBe(200)
    expect(submit.json.doc.status).toBe('in_review')

    const editorCtx = await newSession(browser, testInfo)
    try {
      const ep = await editorCtx.newPage()
      await openHarness(ep, cfg.newsroomOrigin)
      expect((await login(ep, cfg, 'editor')).status).toBe(200)
      const approve = await call(ep, `${cfg.cmsUrl}/api/articles/${id}`, { method: 'PATCH', body: { status: 'approved' } })
      expect(approve.status).toBe(200)
      expect(approve.json.doc.status).toBe('approved')
      evidence(`editor PATCH status=approved -> HTTP ${approve.status}`)
    } finally {
      await editorCtx.close()
    }
  })
})

// ---- 2. expired / invalid / revoked sessions -----------------------------------------------------

test.describe('2. invalid, expired and revoked sessions', () => {
  test('tampered, forged, alg=none, expired and unknown-session tokens are anonymous', async ({ page, context }) => {
    await openHarness(page, cfg.newsroomOrigin)
    const l = await login(page, cfg, 'reporter')
    expect(l.status).toBe(200)
    const good = (await payloadCookie(context))!
    const userId = l.json.user.id
    const email = l.json.user.email

    const setToken = async (value: string) => {
      await context.clearCookies()
      await context.addCookies([{ name: COOKIE, value, url: cfg.cmsUrl, httpOnly: true, sameSite: 'Lax' }])
    }
    const expectAnonymous = async (label: string) => {
      const me = await call(page, `${cfg.cmsUrl}/api/users/me`)
      expect(me.status, label).toBe(200)
      expect(me.json.user, `${label}: /me must report no user`).toBeNull()
      const write = await call(page, `${cfg.cmsUrl}/api/articles`, {
        method: 'POST',
        body: { title: 'x', slug: uniq('anon'), content: lexicalBody(), category: 1 },
      })
      expect([401, 403], `${label}: protected write refused (got ${write.status})`).toContain(write.status)
    }

    // control: the real cookie re-added works, so the harness itself is sound
    await setToken(good.value)
    expect((await call(page, `${cfg.cmsUrl}/api/users/me`)).json.user.email).toBe(email)

    const flipped = good.value.slice(0, -4) + (good.value.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA')
    await setToken(flipped)
    await expectAnonymous('tampered signature')

    await setToken('not-a-jwt')
    await expectAnonymous('garbage value')

    const now = Math.floor(Date.now() / 1000)
    const claims = { id: userId, collection: 'users', email, sid: 'forged-session', iat: now, exp: now + 3600 }
    await setToken(signJwt(claims, 'a-completely-different-signing-key-0123'))
    await expectAnonymous('forged token (wrong key)')

    const head = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    await setToken(`${head}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`)
    await expectAnonymous('alg=none token')

    if (cfg.jwtKey) {
      await setToken(signJwt({ ...claims, iat: now - 7200, exp: now - 60 }, cfg.jwtKey))
      await expectAnonymous('correctly signed but expired token')
      await setToken(signJwt(claims, cfg.jwtKey))
      await expectAnonymous('correctly signed, unexpired, but session id not on the server')
      evidence('expired + unknown-session tokens signed with the CMS key were rejected')
    } else {
      evidence('SKIPPED expired / unknown-session crafted tokens: signing key unavailable in STAGING_URL mode')
    }
  })

  test('admin revoke-sessions signs the user out immediately; reporter cannot revoke', async ({ page, browser }, testInfo) => {
    await openHarness(page, cfg.newsroomOrigin)
    const rl = await login(page, cfg, 'reporter')
    expect(rl.status).toBe(200)
    const reporterId = rl.json.user.id
    expect((await call(page, `${cfg.cmsUrl}/api/users/me`)).json.user.id).toBe(reporterId)

    // a reporter attempting to revoke a session is refused
    const self = await call(page, `${cfg.cmsUrl}/api/users/${reporterId}/revoke-sessions`, { method: 'POST' })
    expect(self.status).toBe(403)

    const adminCtx = await newSession(browser, testInfo)
    try {
      const ap = await adminCtx.newPage()
      await openHarness(ap, cfg.newsroomOrigin)
      const al = await login(ap, cfg, 'admin')
      expect(al.status).toBe(200)
      const revoke = await call(ap, `${cfg.cmsUrl}/api/users/${reporterId}/revoke-sessions`, { method: 'POST' })
      expect(revoke.status).toBe(200)
      expect(revoke.json.ok).toBe(true)
      // admin's own session is untouched
      expect((await call(ap, `${cfg.cmsUrl}/api/users/me`)).json.user.role).toBe('admin')
    } finally {
      await adminCtx.close()
    }

    // The reporter's browser still HOLDS the cookie but the server no longer honours it.
    const stillThere = await page.context().cookies(cfg.cmsUrl)
    expect(stillThere.some((c) => c.name === COOKIE)).toBe(true)
    const me = await call(page, `${cfg.cmsUrl}/api/users/me`)
    expect(me.json.user).toBeNull()
    evidence('after revoke-sessions the reporter cookie is still stored but /me -> user null')
  })
})

// ---- 3. cross-site and CSRF ----------------------------------------------------------------------

test.describe('3. cross-site: CORS, SameSite=Lax and CSRF', () => {
  test('evil.othersite.localhost: fetch(credentials:include) is blocked by CORS and sends no cookie; control origin works', async ({
    page,
    context,
  }) => {
    await openHarness(page, cfg.newsroomOrigin)
    expect((await login(page, cfg, 'reporter')).status).toBe(200)
    expect(await payloadCookie(context)).toBeTruthy()

    const track = trackCms(context, cfg.cmsUrl)
    const tag = uniq('p') // unique per project run: the CMS (and its log) is shared by both projects

    // control first: the allowlisted newsroom origin gets the cookie and a readable answer
    const ok = await call(page, `${cfg.cmsUrl}/api/users/me?probe=control-${tag}`)
    expect(ok.json.user.email).toBe(creds(cfg, 'reporter').email)
    const controlReq = (await track.all(`probe=control-${tag}`))[0]
    expect(controlReq.requestHeaders.cookie ?? '').toContain(COOKIE)
    expect(controlReq.responseHeaders?.['access-control-allow-origin']).toBe(cfg.newsroomOrigin)

    // now from a different site
    await openHarness(page, cfg.evilOrigin)
    const evil = await call(page, `${cfg.cmsUrl}/api/users/me?probe=evil-${tag}`)
    expect(evil.blocked, 'fetch rejects (TypeError) because CORS did not grant the origin').toBe(true)
    expect(evil.status).toBeUndefined()

    const markN = ((await serverLog(cfg)) ?? []).length
    // JSON POST => preflight; the CMS must not grant it, so the real request is never sent
    const post = await call(page, `${cfg.cmsUrl}/api/articles`, {
      method: 'POST',
      body: { title: 'evil', slug: uniq('evil-cors'), content: lexicalBody(), category: 1 },
    })
    expect(post.blocked).toBe(true)

    // Server-side truth (recording proxy): what the CMS received and answered. Chromium hides raw
    // headers of CORS-blocked requests from Playwright, so this is the authoritative evidence.
    const log = await serverLog(cfg)
    if (log) {
      const at = (p: string) => log.filter((r) => r.path.includes(p))
      const control = at(`probe=control-${tag}`)[0]
      expect(control.origin).toBe(cfg.newsroomOrigin)
      expect(control.cookieNames).toContain(COOKIE)
      expect(control.acao).toBe(cfg.newsroomOrigin)
      expect(control.acac).toBe('true')

      const evilGet = at(`probe=evil-${tag}`)
      expect(evilGet, 'the browser did send the simple GET').toHaveLength(1)
      expect(evilGet[0].origin).toBe(cfg.evilOrigin)
      expect(evilGet[0].cookieNames, 'SameSite=Lax: no cookie on a cross-site subresource request').not.toContain(COOKIE)
      expect(evilGet[0].acao, 'no ACAO grant for a non-allowlisted origin').toBeNull()
      expect(evilGet[0].acac).toBeNull()

      const toArticles = log.filter((r) => r.path === '/api/articles' && r.origin === cfg.evilOrigin && r.n >= markN)
      expect(toArticles.map((r) => r.method), 'only the preflight reached the CMS').toEqual(['OPTIONS'])
      expect(toArticles[0].cookieNames).toHaveLength(0)
      expect(toArticles[0].acao).toBeNull()
      evidence(
        `server saw: newsroom GET cookie=${control.cookieNames.includes(COOKIE)} ACAO=${control.acao}; ` +
          `evil GET cookie=${evilGet[0].cookieNames.includes(COOKIE)} ACAO=${evilGet[0].acao}; evil POST preflight -> HTTP ${toArticles[0].status}, ACAO=${toArticles[0].acao}, real POST never sent`,
      )
    } else {
      evidence('server-side header log unavailable in STAGING_URL mode: only browser-visible outcomes asserted (fetch rejected, no POST issued)')
    }
  })

  test('cross-site / unlisted-origin form POSTs do not act with the session (CSRF); allowlisted origin control does', async ({
    page,
    context,
  }) => {
    await openHarness(page, cfg.newsroomOrigin)
    expect((await login(page, cfg, 'reporter')).status).toBe(200)
    const adminToken = await nodeToken('admin')
    const cat = await categoryId(adminToken)

    const attempt = async (origin: string, label: string) => {
      const slug = uniq(`csrf-${label}`)
      const action = `${cfg.cmsUrl}/api/articles`
      const payload = JSON.stringify({ title: `CSRF ${slug}`, slug, content: lexicalBody(), category: cat, status: 'draft' })
      await page.goto(
        `${origin}/form?action=${encodeURIComponent(action)}&field=_payload&value=${encodeURIComponent(payload)}`,
      )
      await page.waitForFunction(() => typeof (window as any).submitForm === 'function')
      const [resp] = await Promise.all([
        page.waitForResponse((r) => r.url() === action && r.request().method() === 'POST'),
        page.evaluate(() => void setTimeout((window as any).submitForm, 0)),
      ])
      const headers = await resp.request().allHeaders()
      const found = await nodeApi(adminToken, 'GET', `/api/articles?where[slug][equals]=${slug}&limit=1&depth=0`)
      return {
        status: resp.status(),
        cookieSent: (headers.cookie ?? '').includes(COOKIE),
        origin: headers.origin,
        created: (found.json?.docs?.length ?? 0) > 0,
      }
    }

    // control: form posted from the allowlisted newsroom origin DOES carry the session and succeed
    const control = await attempt(cfg.newsroomOrigin, 'control')
    expect(control.cookieSent).toBe(true)
    expect(control.status, 'control form POST from an allowlisted origin is accepted').toBe(201)
    expect(control.created).toBe(true)

    // different site: Lax cookie is not sent at all, request is anonymous
    const evil = await attempt(cfg.evilOrigin, 'evil')
    expect(evil.origin).toBe(cfg.evilOrigin)
    expect(evil.cookieSent, 'SameSite=Lax withholds the cookie on cross-site POST navigations').toBe(false)
    expect([401, 403]).toContain(evil.status)
    expect(evil.created).toBe(false)

    // same site but NOT in the CSRF allowlist: the browser DOES send the cookie (Lax permits
    // same-site), so only Payload's Origin allowlist stands between this and a forged write.
    const sibling = await attempt(cfg.siblingOrigin, 'sibling')
    expect(sibling.origin).toBe(cfg.siblingOrigin)
    expect(sibling.cookieSent, 'same-site request carries the cookie').toBe(true)
    expect([401, 403], 'Payload csrf ignores the cookie for an unlisted Origin').toContain(sibling.status)
    expect(sibling.created).toBe(false)

    evidence(
      `form POST /api/articles: newsroom(listed) cookie=${control.cookieSent} -> ${control.status} created=${control.created}; ` +
        `evil.othersite cookie=${evil.cookieSent} -> ${evil.status} created=${evil.created}; ` +
        `sibling.churchtimes(unlisted, same-site) cookie=${sibling.cookieSent} -> ${sibling.status} created=${sibling.created}`,
    )
    expect(await payloadCookie(context)).toBeTruthy()
  })
})

// ---- 4. admin UI in the real browser -------------------------------------------------------------

test.describe('4. Payload admin UI', () => {
  test('editor signs in at /admin and sees the Articles list', async ({ page, context }, testInfo) => {
    test.setTimeout(300_000)
    const c = creds(cfg, 'editor')
    await page.goto(`${cfg.cmsUrl}/admin/login`)
    await page.locator('#field-email').fill(c.email)
    await page.locator('#field-password').fill(c.password)
    await page.locator('form button[type="submit"]').click()
    await page.waitForURL((u) => /^\/admin\/?$/.test(u.pathname), { timeout: 180_000 })

    const cookie = await payloadCookie(context)
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('Lax')
    expect(await page.evaluate(() => document.cookie)).not.toContain(COOKIE)

    await page.goto(`${cfg.cmsUrl}/admin/collections/articles`)
    await expect(page.getByRole('heading', { name: 'Articles', level: 1 })).toBeVisible({ timeout: 180_000 })
    await expect(page.locator('main, .collection-list, .template-default').first()).toBeVisible()
    if (cfg.mode === 'local-dev') {
      await expect(page.getByText('E2E Published One').first()).toBeVisible({ timeout: 60_000 })
    }

    fs.mkdirSync(evidenceDir, { recursive: true })
    const shot = path.join(evidenceDir, `browser-admin-articles-${testInfo.project.name}.png`)
    await page.screenshot({ path: shot, fullPage: false })
    const vp = page.viewportSize()
    evidence(`admin Articles list rendered at ${vp?.width}x${vp?.height}; screenshot ${path.basename(shot)}`)
  })
})

// ---- 5. public-site harness ----------------------------------------------------------------------

test.describe('5. public site (www.churchtimes.localhost): anonymous reads', () => {
  test('published articles are readable with credentials:omit; drafts never appear', async ({ page, context }) => {
    const track = trackCms(context, cfg.cmsUrl)
    const adminToken = await nodeToken('admin')
    const cat = await categoryId(adminToken)
    const mk = async (slug: string, status: string) => {
      const r = await nodeApi(adminToken, 'POST', '/api/articles', {
        title: `E2E public ${slug}`,
        slug,
        content: lexicalBody(),
        category: cat,
        status,
      })
      expect(r.status, `create ${status} article`).toBe(201)
      return r.json.doc.id as number
    }
    const pubSlug = uniq('e2e-pub')
    const draftSlug = uniq('e2e-draft')
    const reviewSlug = uniq('e2e-review')
    await mk(pubSlug, 'published')
    const draftId = await mk(draftSlug, 'draft')
    await mk(reviewSlug, 'in_review')

    await openHarness(page, cfg.publicOrigin)
    const bySlug = await call(page, `${cfg.cmsUrl}/api/articles?where[slug][equals]=${pubSlug}&limit=1`, {
      credentials: 'omit',
    })
    expect(bySlug.status).toBe(200)
    const pubReq = (await track.all(`slug%5D%5Bequals%5D=${pubSlug}`)).concat(await track.all(`[equals]=${pubSlug}`))[0]
    expect(pubReq.responseHeaders?.['access-control-allow-origin']).toBe(cfg.publicOrigin)
    expect(pubReq.requestHeaders.cookie, 'credentials:omit sends no cookie').toBeUndefined()
    expect(bySlug.json.docs).toHaveLength(1)
    expect(bySlug.json.docs[0].status).toBe('published')
    expect(bySlug.json.docs[0]).not.toHaveProperty('reviewNotes')

    const list = await call(page, `${cfg.cmsUrl}/api/articles?limit=200&depth=0`, { credentials: 'omit' })
    expect(list.status).toBe(200)
    const slugs: string[] = list.json.docs.map((d: { slug: string }) => d.slug)
    expect(slugs).toContain(pubSlug)
    expect(slugs).not.toContain(draftSlug)
    expect(slugs).not.toContain(reviewSlug)
    expect(list.json.docs.every((d: { status: string }) => d.status === 'published')).toBe(true)

    const asked = await call(page, `${cfg.cmsUrl}/api/articles?where[status][equals]=draft&limit=50`, { credentials: 'omit' })
    expect(asked.json.docs).toHaveLength(0)
    const direct = await call(page, `${cfg.cmsUrl}/api/articles/${draftId}`, { credentials: 'omit' })
    expect([403, 404]).toContain(direct.status)
    expect(JSON.stringify(direct.json ?? {})).not.toContain(draftSlug)
    evidence(`public harness: published visible (${list.json.docs.length} listed), draft/in_review absent, direct draft fetch -> HTTP ${direct.status}`)
  })
})
