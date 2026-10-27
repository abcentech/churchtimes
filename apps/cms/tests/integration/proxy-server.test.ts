import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The request-size policy against a REAL Next.js server (`next dev`, so src/proxy.ts runs exactly as in production),
 * not a unit-level call: chunked bodies are visible to the proxy and refused (411) on every write route, an anonymous
 * or forged-credential body above 11 MB is refused (413), a genuine session JWT gets the configured larger limit, and
 * JSON routes stay at 1 MB. The server gets MEDIA_AV_MAX_MB=40, so a verified session may send up to 41 MB to /api/media.
 */
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SECRET = 'proxy-server-test-secret-0123456789abcdef0123456789abcdef'
const MB = 1024 * 1024

let child: ChildProcess | undefined
let port = 0
let log = ''

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port: p } = srv.address() as net.AddressInfo
      srv.close(() => resolve(p))
    })
  })

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
function sessionJwt(expOffsetSeconds = 600): string {
  const key = createHash('sha256').update(SECRET).digest('hex').slice(0, 32)
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ id: 1, collection: 'users', exp: Math.floor(Date.now() / 1000) + expOffsetSeconds })
  return `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`
}

/** One raw HTTP/1.1 request (head plus an optional, complete body: Next reads the whole body before it runs the proxy); resolves with the status code, or null when nothing came back in `waitMs`. */
function rawStatus(headLines: string[], waitMs = 8000, bodyText = ''): Promise<number | null> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = ''
    const done = (v: number | null) => {
      sock.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(null), waitMs)
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf)
      if (m) {
        clearTimeout(timer)
        done(Number(m[1]))
      }
    })
    sock.on('error', () => {
      clearTimeout(timer)
      done(null)
    })
    sock.on('connect', () => sock.write(`${headLines.join('\r\n')}\r\n\r\n${bodyText}`))
  })
}

const CHUNKED = '3\r\nabc\r\n0\r\n\r\n'
const head = (method: string, url: string, extra: string[] = []) => [`${method} ${url} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close', ...extra]
const post = (url: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${url}`, { method: 'POST', body: body as BodyInit, headers, signal: AbortSignal.timeout(200_000) })

beforeAll(async () => {
  port = await freePort()
  const nextBin = path.join(appDir, 'node_modules', 'next', 'dist', 'bin', 'next')
  child = spawn(process.execPath, [nextBin, 'dev', '--webpack', '-p', String(port)], {
    cwd: appDir,
    env: {
      ...process.env,
      PAYLOAD_SECRET: SECRET,
      MEDIA_AV_MAX_MB: '40',
      NEXT_TELEMETRY_DISABLED: '1',
      NODE_ENV: 'development',
      VITEST: '',
      VITEST_WORKER_ID: '',
      TRUST_PROXY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => (log += d.toString()))
  child.stderr?.on('data', (d) => (log += d.toString()))
  // Ready when the proxy answers a chunked write with 411 (it must have compiled and run).
  const deadline = Date.now() + 300_000
  for (;;) {
    const s = await rawStatus(head('POST', '/api/public/submissions', ['Transfer-Encoding: chunked']), 60_000, CHUNKED)
    if (s === 411) break
    if (Date.now() > deadline) throw new Error(`next dev did not become ready: ${log.slice(-3000)}`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}, 320_000)

afterAll(async () => {
  child?.kill()
  await new Promise((r) => setTimeout(r, 500))
})

describe('request-size policy on a running Next server', () => {
  it('refuses a chunked body (Transfer-Encoding visible to the proxy) on every kind of write route with 411', async () => {
    for (const url of ['/api/public/submissions', '/api/public/newsletter/subscribe', '/api/staff/related-articles', '/api/media', '/api/users/login', '/api/articles']) {
      for (const method of ['POST', 'PATCH']) {
        expect(await rawStatus(head(method, url, ['Transfer-Encoding: chunked', 'Content-Type: application/json']), 60_000, CHUNKED), `${method} ${url}`).toBe(411)
      }
    }
  })

  it('a chunked GET and a bodyless POST (no Content-Length, no Transfer-Encoding) are not refused with 411', async () => {
    expect(await rawStatus(head('GET', '/api/users/me', ['Transfer-Encoding: chunked']), 60_000, '0\r\n\r\n')).not.toBe(411)
    expect(await rawStatus(head('POST', '/api/users/logout'), 60_000)).not.toBe(411)
  }, 130_000)

  it('refuses an anonymous or forged-credential body above 11 MB on /api/media with 413', async () => {
    const body = new Uint8Array(20 * MB)
    expect((await post('/api/media', body)).status).toBe(413)
    expect((await post('/api/media', body, { authorization: 'JWT forged' })).status).toBe(413)
    expect((await post('/api/media', body, { authorization: 'x', cookie: 'a-token=1; payload-token=a.b.c' })).status).toBe(413)
    expect((await post('/api/media', body, { cookie: `payload-token=${sessionJwt(-60)}` })).status).toBe(413) // expired
  }, 120_000)

  it('lets a genuine session through the proxy up to the configured limit, and refuses above it', async () => {
    const ok = await post('/api/media', new Uint8Array(20 * MB), { cookie: `payload-token=${sessionJwt()}` })
    expect(ok.status).not.toBe(413)
    expect(ok.status).not.toBe(411)
    const tooBig = await post('/api/media', new Uint8Array(45 * MB), { cookie: `payload-token=${sessionJwt()}` })
    expect(tooBig.status).toBe(413)
  }, 240_000)

  it('keeps JSON routes at 1 MB even with a valid session', async () => {
    const res = await post('/api/articles', new Uint8Array(2 * MB), { cookie: `payload-token=${sessionJwt()}`, 'content-type': 'application/json' })
    expect(res.status).toBe(413)
  }, 120_000)
})
