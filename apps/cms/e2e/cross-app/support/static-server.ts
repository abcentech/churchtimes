/**
 * Minimal static file server for a Vite build output directory (no SPA fallback; the newsroom uses hash routes), plus
 * startPublicHost, which serves the public site through its real frontend host (tools/serve-public.mjs, issue #15) so
 * clean /reports/:slug/ URLs, cold reloads and real 404s are exercised.
 */
import fs from 'node:fs'
import http from 'node:http'
import type { Socket } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
}

export type StaticServer = { port: number; close: () => Promise<void> }

export function startStaticServer(root: string, port: number): Promise<StaticServer> {
  const base = path.resolve(root)
  const server = http.createServer((req, res) => {
    let rel = '/'
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      res.writeHead(400).end()
      return
    }
    let file = path.resolve(base, '.' + rel)
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403).end()
      return
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
  })
  return listenTracked(server, port)
}

/** The public site's own host: compiled assets + server-rendered published articles from the CMS (never forwards cookies). */
export async function startPublicHost(repoRoot: string, dist: string, port: number, cmsUrl: string): Promise<StaticServer> {
  const mod = (await import(pathToFileURL(path.join(repoRoot, 'tools', 'serve-public.mjs')).href)) as {
    createPublicServer: (opts: { dist: string; cmsUrl: string; basePath: string }) => http.Server
  }
  return listenTracked(mod.createPublicServer({ dist, cmsUrl, basePath: '/' }), port)
}

function listenTracked(server: http.Server, port: number): Promise<StaticServer> {
  const sockets = new Set<Socket>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy()
            server.close(() => r())
          }),
      }),
    )
  })
}
