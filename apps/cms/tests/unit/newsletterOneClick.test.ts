import { beforeEach, describe, expect, it, vi } from 'vitest'

import { isOneClickBody, newsletterOneClickEndpoint, newsletterOneClickGetEndpoint, resetOneClickLimiter } from '../../src/endpoints/newsletterOneClick'
import { signUnsubscribeToken } from '../../src/lib/newsletter'

const SECRET = 'k'.repeat(40)

function fakePayload(rows: Array<{ id: number; status: string }>) {
  return {
    findByID: vi.fn(async ({ id }: { id: string }) => {
      const row = rows.find((r) => String(r.id) === id)
      if (!row) throw new Error('not found')
      return { ...row }
    }),
    update: vi.fn(async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const row = rows.find((r) => r.id === id)!
      Object.assign(row, data)
      return row
    }),
    create: vi.fn(async () => ({})),
    logger: { error: vi.fn() },
  }
}

function req(payload: ReturnType<typeof fakePayload>, query: string, body = '', contentType = 'application/x-www-form-urlencoded') {
  const url = new URL(`https://cms.example.org/api/public/newsletter/one-click${query}`)
  return {
    payload,
    searchParams: url.searchParams,
    headers: new Headers({ 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) }),
    body: new Response(body).body,
    text: async () => body,
    user: null,
    context: {},
  } as never
}

beforeEach(() => {
  process.env.NEWSLETTER_TOKEN_SECRET = SECRET
  process.env.PUBLIC_SITE_URL = 'https://churchtimesnigeria.net'
  delete process.env.NEWSLETTER_ONE_CLICK_RATE_LIMIT
  resetOneClickLimiter()
})

describe('isOneClickBody', () => {
  it('accepts the RFC 8058 body in urlencoded and multipart form', () => {
    expect(isOneClickBody('application/x-www-form-urlencoded', 'List-Unsubscribe=One-Click')).toBe(true)
    expect(isOneClickBody('application/x-www-form-urlencoded; charset=utf-8', 'a=1&List-Unsubscribe=One-Click')).toBe(true)
    const multipart = '--b\r\nContent-Disposition: form-data; name="List-Unsubscribe"\r\n\r\nOne-Click\r\n--b--\r\n'
    expect(isOneClickBody('multipart/form-data; boundary=b', multipart)).toBe(true)
  })
  it('rejects anything else', () => {
    expect(isOneClickBody('application/x-www-form-urlencoded', '')).toBe(false)
    expect(isOneClickBody('application/x-www-form-urlencoded', 'List-Unsubscribe=Two-Click')).toBe(false)
    expect(isOneClickBody('application/json', '{"List-Unsubscribe":"One-Click"}')).toBe(false)
    expect(isOneClickBody('text/plain', 'List-Unsubscribe=One-Click')).toBe(false)
  })
})

describe('POST one-click', () => {
  it('unsubscribes a confirmed reader at once, without Origin or cookies, and is idempotent', async () => {
    const rows = [{ id: 5, status: 'confirmed' }]
    const payload = fakePayload(rows)
    const token = encodeURIComponent(signUnsubscribeToken(5, SECRET))
    const res = await newsletterOneClickEndpoint.handler(req(payload, `?token=${token}`, 'List-Unsubscribe=One-Click'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(rows[0]!.status).toBe('unsubscribed')
    expect(payload.create).toHaveBeenCalledTimes(1) // the single existing audit row, nothing more
    const again = await newsletterOneClickEndpoint.handler(req(payload, `?token=${token}`, 'List-Unsubscribe=One-Click'))
    expect(again.status).toBe(200)
    expect(payload.update).toHaveBeenCalledTimes(1)
  })

  it('refuses forged, missing or duplicated tokens and wrong bodies without touching the row', async () => {
    const rows = [{ id: 5, status: 'confirmed' }]
    const payload = fakePayload(rows)
    const good = encodeURIComponent(signUnsubscribeToken(5, SECRET))
    const forged = encodeURIComponent(signUnsubscribeToken(5, 'x'.repeat(40)))
    expect((await newsletterOneClickEndpoint.handler(req(payload, `?token=${forged}`, 'List-Unsubscribe=One-Click'))).status).toBe(400)
    expect((await newsletterOneClickEndpoint.handler(req(payload, '', 'List-Unsubscribe=One-Click'))).status).toBe(400)
    expect((await newsletterOneClickEndpoint.handler(req(payload, `?token=${good}&token=${good}`, 'List-Unsubscribe=One-Click'))).status).toBe(400)
    expect((await newsletterOneClickEndpoint.handler(req(payload, `?token=${good}`, 'nothing'))).status).toBe(400)
    expect((await newsletterOneClickEndpoint.handler(req(payload, `?token=${good}`, 'x'.repeat(5000)))).status).toBe(413)
    expect(rows[0]!.status).toBe('confirmed')
    expect(payload.update).not.toHaveBeenCalled()
  })

  it('a token for an erased or unknown row changes nothing', async () => {
    const rows = [{ id: 6, status: 'erased' }]
    const payload = fakePayload(rows)
    const erased = encodeURIComponent(signUnsubscribeToken(6, SECRET))
    expect((await newsletterOneClickEndpoint.handler(req(payload, `?token=${erased}`, 'List-Unsubscribe=One-Click'))).status).toBe(200)
    expect(rows[0]!.status).toBe('erased')
    const unknown = encodeURIComponent(signUnsubscribeToken(99, SECRET))
    expect((await newsletterOneClickEndpoint.handler(req(payload, `?token=${unknown}`, 'List-Unsubscribe=One-Click'))).status).toBe(400)
  })

  it('is rate limited', async () => {
    process.env.NEWSLETTER_ONE_CLICK_RATE_LIMIT = '2'
    resetOneClickLimiter()
    const payload = fakePayload([])
    for (let i = 0; i < 2; i++) await newsletterOneClickEndpoint.handler(req(payload, '?token=bad', ''))
    const res = await newsletterOneClickEndpoint.handler(req(payload, '?token=bad', ''))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toMatch(/^\d+$/)
  })
})

describe('GET one-click', () => {
  it('never changes state: redirects to the public page where the reader presses the button', async () => {
    const rows = [{ id: 5, status: 'confirmed' }]
    const payload = fakePayload(rows)
    const token = signUnsubscribeToken(5, SECRET)
    const res = await newsletterOneClickGetEndpoint.handler(req(payload, `?token=${encodeURIComponent(token)}`))
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`https://churchtimesnigeria.net/newsletter/unsubscribe?token=${encodeURIComponent(token)}`)
    expect(rows[0]!.status).toBe('confirmed')
    expect(payload.findByID).not.toHaveBeenCalled()
  })
})
