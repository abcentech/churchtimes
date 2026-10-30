#!/usr/bin/env node
/**
 * A local, offline stand-in for the parts of the Paystack API that giving uses (docs/w12/giving.md "Testing offline").
 * Loopback only, test data only, no dependencies. Shapes follow Paystack's published examples
 * (PaystackOSS/doc-code-snippets: transactions/initialize, transactions/verify, webhooks/verifying-transaction).
 *
 *   POST /transaction/initialize    Bearer <secret>; { email, amount, currency, reference, callback_url, metadata }
 *   GET  /transaction/verify/:ref   Bearer <secret>
 *   GET  /transaction               Bearer <secret>; ?perPage&page&from&to
 *   GET  /checkout/:code            a tiny hosted "checkout" page (no card fields: it only offers outcomes)
 *   POST /checkout/:code            outcome=success|failed|abandoned; then a SIGNED charge.success webhook (when
 *                                   webhookUrl is set) and a 302 to callback_url?trxref=&reference=
 *
 * Programmatic use (tests): `const fake = await startFakePaystack({ secret, webhookUrl })`, then `fake.complete(ref)`,
 * `fake.setTransaction(ref, patch)`, `fake.signedWebhook(body)`, `fake.deliverWebhook(ref)`, `fake.calls`, `fake.close()`.
 * CLI: `node scripts/fake-paystack.mjs --port 3291 --webhook http://127.0.0.1:3290/api/public/giving/webhook/paystack`
 * (secret from PAYSTACK_SECRET_KEY, which must be an sk_test_ key).
 */
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const json = (res, status, body) => {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > 64 * 1024) {
        reject(new Error('too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function signPaystack(raw, secret) {
  return createHmac('sha512', secret).update(raw).digest('hex')
}

/**
 * @param {{ secret: string, port?: number, host?: string, webhookUrl?: string | null, currencies?: string[] }} options
 */
export async function startFakePaystack({ secret, port = 0, host = '127.0.0.1', webhookUrl = null, currencies = ['NGN', 'USD'] } = {}) {
  if (!/^sk_test_/.test(secret ?? '')) throw new Error('fake-paystack only accepts an sk_test_ secret')
  /** @type {Map<string, any>} */
  const txs = new Map()
  const byCode = new Map()
  const calls = []
  let nextId = 4_000_000_000
  let origin = ''
  /** @type {{ failInitialize: null | { status: number, body: any }, failVerify: null | { status: number, body: any }, verifyDelayMs: number }} */
  const state = { failInitialize: null, failVerify: null, verifyDelayMs: 0 }

  const publicTx = (t) => ({
    id: t.id,
    domain: 'test',
    status: t.status,
    reference: t.reference,
    amount: t.amount,
    requested_amount: t.requested_amount,
    gateway_response: t.status === 'success' ? 'Successful' : t.status === 'failed' ? 'Declined' : 'The transaction was not completed',
    paid_at: t.paid_at,
    created_at: t.created_at,
    channel: t.channel,
    currency: t.currency,
    metadata: t.metadata,
    fees: t.status === 'success' ? Math.min(Math.round(t.amount * 0.015) + (t.amount >= 250000 ? 10000 : 0), 200000) : null,
    authorization: t.status === 'success' ? { channel: t.channel, card_type: 'visa', bank: 'TEST BANK', country_code: 'NG', brand: 'visa', reusable: false, last4: '4081' } : {},
    customer: { id: 1, email: t.email, customer_code: 'CUS_test' },
  })

  function complete(reference, outcome = 'success', patch = {}) {
    const t = txs.get(reference)
    if (!t) throw new Error(`unknown reference ${reference}`)
    t.status = outcome
    if (outcome === 'success') {
      t.paid_at = new Date().toISOString()
      t.channel = patch.channel ?? 'card'
    }
    Object.assign(t, patch)
    return t
  }

  function signedWebhook(body, key = secret) {
    const raw = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    return { raw, signature: signPaystack(raw, key) }
  }

  function webhookBodyFor(reference, event = 'charge.success') {
    const t = txs.get(reference)
    return { event, data: t ? publicTx(t) : { reference } }
  }

  async function deliverWebhook(reference, { url = webhookUrl, event = 'charge.success', body, key } = {}) {
    if (!url) throw new Error('no webhook URL configured')
    const { raw, signature } = signedWebhook(body ?? webhookBodyFor(reference, event), key)
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': signature }, body: raw })
    return res.status
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake.invalid')
    const auth = req.headers.authorization === `Bearer ${secret}`
    try {
      // Hosted checkout (no auth: the reader's browser).
      const checkout = /^\/checkout\/([A-Za-z0-9]+)$/.exec(url.pathname)
      if (checkout) {
        const t = byCode.get(checkout[1])
        if (!t) return json(res, 404, { status: false, message: 'Not found' })
        if (req.method === 'GET') {
          const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake Paystack checkout</title></head><body><main><h1>Fake Paystack checkout (TEST)</h1><p>${esc(t.currency)} ${esc((t.amount / 100).toFixed(2))} for ${esc(t.email)}</p><form method="post"><button name="outcome" value="success">Pay (test success)</button> <button name="outcome" value="failed">Decline (test failure)</button> <button name="outcome" value="abandoned">Cancel</button></form></main></body></html>`
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          return res.end(html)
        }
        if (req.method === 'POST') {
          const form = new URLSearchParams((await readBody(req)).toString('utf8'))
          const outcome = ['success', 'failed', 'abandoned'].includes(form.get('outcome')) ? form.get('outcome') : 'success'
          complete(t.reference, outcome)
          if (outcome === 'success' && webhookUrl) await deliverWebhook(t.reference).catch(() => undefined)
          const back = new URL(t.callback_url)
          back.searchParams.set('trxref', t.reference)
          back.searchParams.set('reference', t.reference)
          res.writeHead(302, { Location: back.href })
          return res.end()
        }
      }
      if (!auth) return json(res, 401, { status: false, message: 'Invalid key' })

      if (req.method === 'POST' && url.pathname === '/transaction/initialize') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        calls.push({ op: 'initialize', body })
        if (state.failInitialize) return json(res, state.failInitialize.status, state.failInitialize.body)
        if (typeof body.email !== 'string' || !body.email.includes('@')) return json(res, 400, { status: false, message: 'Invalid Email Address Passed' })
        if (!Number.isSafeInteger(body.amount) || body.amount <= 0) return json(res, 400, { status: false, message: 'Invalid Amount Sent' })
        const currency = body.currency ?? 'NGN'
        if (!currencies.includes(currency)) return json(res, 400, { status: false, message: 'Currency not supported by merchant' })
        const reference = body.reference ?? randomBytes(5).toString('hex')
        if (!/^[A-Za-z0-9.=-]+$/.test(reference)) return json(res, 400, { status: false, message: 'Invalid reference' })
        if (txs.has(reference)) return json(res, 400, { status: false, message: 'Duplicate Transaction Reference' })
        const code = randomBytes(8).toString('hex')
        const t = {
          id: nextId++,
          reference,
          amount: body.amount,
          requested_amount: body.amount,
          currency,
          email: body.email,
          callback_url: body.callback_url,
          metadata: body.metadata ?? '',
          status: 'abandoned', // Paystack reports an initialised, unpaid transaction as abandoned.
          paid_at: null,
          channel: null,
          created_at: new Date().toISOString(),
          code,
        }
        txs.set(reference, t)
        byCode.set(code, t)
        return json(res, 200, { status: true, message: 'Authorization URL created', data: { authorization_url: `${origin}/checkout/${code}`, access_code: code, reference } })
      }

      const verify = /^\/transaction\/verify\/(.+)$/.exec(url.pathname)
      if (req.method === 'GET' && verify) {
        const reference = decodeURIComponent(verify[1])
        calls.push({ op: 'verify', reference })
        if (state.verifyDelayMs) await new Promise((r) => setTimeout(r, state.verifyDelayMs))
        if (state.failVerify) return json(res, state.failVerify.status, state.failVerify.body)
        const t = txs.get(reference)
        if (!t) return json(res, 400, { status: false, message: 'Transaction reference not found' })
        return json(res, 200, { status: true, message: 'Verification successful', data: publicTx(t) })
      }

      if (req.method === 'GET' && url.pathname === '/transaction') {
        calls.push({ op: 'list' })
        const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('perPage') ?? 50)))
        const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
        const from = url.searchParams.get('from') ? Date.parse(url.searchParams.get('from')) : -Infinity
        const to = url.searchParams.get('to') ? Date.parse(url.searchParams.get('to')) : Infinity
        const all = [...txs.values()].filter((t) => Date.parse(t.created_at) >= from && Date.parse(t.created_at) <= to).reverse()
        const pageCount = Math.max(1, Math.ceil(all.length / perPage))
        return json(res, 200, { status: true, message: 'Transactions retrieved', data: all.slice((page - 1) * perPage, page * perPage).map(publicTx), meta: { total: all.length, perPage, page, pageCount } })
      }
      return json(res, 404, { status: false, message: 'Not found' })
    } catch {
      return json(res, 500, { status: false, message: 'fake error' })
    }
  })

  await new Promise((resolve) => server.listen(port, host, resolve))
  const addr = server.address()
  origin = `http://${host}:${addr.port}`
  return {
    origin,
    port: addr.port,
    calls,
    state,
    transactions: txs,
    complete,
    signedWebhook,
    webhookBodyFor,
    deliverWebhook,
    setTransaction: (reference, patch) => Object.assign(txs.get(reference), patch),
    setWebhookUrl: (u) => {
      webhookUrl = u
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const fake = await startFakePaystack({ secret: process.env.PAYSTACK_SECRET_KEY, port: Number(arg('port') ?? 3291), webhookUrl: arg('webhook') ?? null })
  console.log(`fake Paystack on ${fake.origin} (set PAYSTACK_API_BASE=${fake.origin})`)
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => fake.close().then(() => process.exit(0)))
}
