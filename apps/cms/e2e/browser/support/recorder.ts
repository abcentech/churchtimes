/**
 * Transparent recording reverse proxy in front of the CMS. Chromium only exposes raw request headers
 * to Playwright for requests that were not blocked by CORS (and not reliably for opaque ones), so to
 * prove what the CMS really RECEIVED (Origin, whether the session cookie was attached) and what it
 * answered (Access-Control-Allow-*) the proxy logs exactly that, never cookie or token values.
 *
 * GET /__e2e/log on the proxy returns the log as JSON; it is not forwarded to the CMS.
 */
import http from 'node:http'
import type { Socket } from 'node:net'

export type Recorded = {
  n: number
  method: string
  path: string
  origin: string | null
  secFetchSite: string | null
  cookieNames: string[]
  status: number
  acao: string | null
  acac: string | null
}

export type Recorder = { close: () => Promise<void> }

const COOKIE_NAME = /^\s*([^=;\s]+)=/

export function startRecorder(listenPort: number, upstreamPort: number): Promise<Recorder> {
  const log: Recorded[] = []
  const sockets = new Set<Socket>()
  const server = http.createServer((req, res) => {
    if (req.url === '/__e2e/log') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(log))
      return
    }
    const header = (name: string) => {
      const v = req.headers[name]
      return typeof v === 'string' ? v : null
    }
    const entry: Recorded = {
      n: log.length,
      method: req.method ?? '',
      path: req.url ?? '',
      origin: header('origin'),
      secFetchSite: header('sec-fetch-site'),
      cookieNames: (header('cookie') ?? '')
        .split(';')
        .map((c) => COOKIE_NAME.exec(c)?.[1] ?? '')
        .filter(Boolean),
      status: 0,
      acao: null,
      acac: null,
    }
    log.push(entry)
    const up = http.request(
      { host: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers: req.headers },
      (ur) => {
        entry.status = ur.statusCode ?? 0
        const h = (name: string) => {
          const v = ur.headers[name]
          return Array.isArray(v) ? v.join(',') : (v ?? null)
        }
        entry.acao = h('access-control-allow-origin')
        entry.acac = h('access-control-allow-credentials')
        res.writeHead(ur.statusCode ?? 502, ur.headers)
        ur.pipe(res)
      },
    )
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(up)
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, '127.0.0.1', () =>
      resolve({
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      }),
    )
  })
}
