// Internal: the two small HTTP servers behind the public site (funnel 443) and the newsroom (funnel 8443).
// Started detached by funnel-up.mjs. Binds 127.0.0.1 ONLY. Environment (never argv):
//   FUNNEL_SERVE_MODE=public|newsroom   FUNNEL_SERVE_PORT   FUNNEL_SERVE_DIST
//   public   : FUNNEL_PUBLIC_CMS_ORIGIN (the https CMS origin the site is built with), FUNNEL_CMS_LOOPBACK (http://127.0.0.1:<cms port>)
//   newsroom : FUNNEL_PUBLIC_CMS_ORIGIN (used in the Content-Security-Policy)
//
// public   = tools/serve-public.mjs (compiled site + server-rendered /reports/:slug/) wrapped so that EVERY response carries
//            X-Robots-Tag "noindex, nofollow" (the stock server only sets it on HTML) plus basic security headers. Its server-side
//            reads of the CMS go straight to the loopback CMS (no round trip through the internet); the media URL check still
//            uses the public https origin.
// newsroom = static files only (hash routes, no SPA fallback) with the headers of deploy/staging/Caddyfile.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { FUNNEL_SERVE_MODE: mode, FUNNEL_SERVE_PORT, FUNNEL_SERVE_DIST: dist, FUNNEL_PUBLIC_CMS_ORIGIN: cmsOrigin, FUNNEL_CMS_LOOPBACK: cmsLoopback } = process.env
const port = Number(FUNNEL_SERVE_PORT)
if (!['public', 'newsroom'].includes(mode ?? '') || !Number.isInteger(port) || port < 1 || port > 65535 || !dist || !cmsOrigin) {
  console.error('funnel-serve: missing/invalid environment (FUNNEL_SERVE_MODE, FUNNEL_SERVE_PORT, FUNNEL_SERVE_DIST, FUNNEL_PUBLIC_CMS_ORIGIN).')
  process.exit(2)
}
const distDir = path.resolve(dist)
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`funnel-serve: ${distDir} has no index.html (build first).`)
  process.exit(2)
}

const NOINDEX = 'noindex, nofollow'
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'

let server
if (mode === 'public') {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const mod = await import(pathToFileURL(path.join(root, 'tools', 'serve-public.mjs')).href)
  const loopback = cmsLoopback ? new URL(cmsLoopback).origin : ''
  const fetchImpl = (input, init) => {
    const url = String(input)
    return fetch(loopback && url.startsWith(cmsOrigin + '/') ? loopback + url.slice(cmsOrigin.length) : url, init)
  }
  server = mod.createPublicServer({ dist: distDir, cmsUrl: cmsOrigin, siteUrl: '', basePath: '/', indexable: false, fetchImpl })
  // Headers set here are merged into every response; the stock server's own writeHead values win where both exist.
  server.prependListener('request', (_req, res) => {
    res.setHeader('X-Robots-Tag', NOINDEX)
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Frame-Options', 'SAMEORIGIN')
    res.setHeader('Permissions-Policy', PERMISSIONS)
  })
} else {
  const MIME = {
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
    '.map': 'application/json; charset=utf-8',
  }
  const security = {
    'X-Robots-Tag': NOINDEX,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': PERMISSIONS,
    'Strict-Transport-Security': 'max-age=15552000',
    // Same-origin scripts only; the SPA talks to the CMS origin and shows its media. Style attributes need 'unsafe-inline' for styles.
    'Content-Security-Policy':
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: ${cmsOrigin}; ` +
      `connect-src 'self' ${cmsOrigin}; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
  }
  server = http.createServer((req, res) => {
    const send = (status, type, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...security, ...extra })
      res.end(req.method === 'HEAD' ? undefined : body)
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'Method not allowed', { Allow: 'GET, HEAD' })
    let rel
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    } catch {
      return send(400, 'text/plain', 'Bad request')
    }
    if (rel.includes('\0') || rel.includes('\\')) return send(400, 'text/plain', 'Bad request')
    let file = path.resolve(distDir, '.' + rel)
    if (file !== distDir && !file.startsWith(distDir + path.sep)) return send(403, 'text/plain', 'Forbidden')
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
      const body = fs.readFileSync(file)
      const hashed = /[\\/]assets[\\/]/.test(file)
      send(200, MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', body, {
        'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
    } catch {
      send(404, 'text/plain', 'Not found')
    }
  })
}

server.listen(port, '127.0.0.1', () => console.log(`[funnel-serve] ${mode} ready on 127.0.0.1:${port}`))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGBREAK']) process.on(signal, () => server.close(() => process.exit(0)))
