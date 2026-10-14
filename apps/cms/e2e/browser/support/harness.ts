/**
 * Tiny static "frontend" harnesses. Each is a plain Node http server that serves the same page: a
 * page whose script performs fetch() calls with a chosen `credentials` mode against the CMS and
 * reports the outcome into the DOM (`#log`) and `window.__results`, so Playwright can read it.
 *
 * Which "app" a harness stands for is decided only by the hostname/port the browser used to reach
 * it (Chromium resolves *.localhost to loopback), so the browser sends the matching Origin.
 */
import http from 'node:http'

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>E2E harness</title></head>
<body>
<h1 id="who"></h1>
<pre id="log"></pre>
<script>
document.getElementById('who').textContent = location.origin
window.__results = []
// call(url, { method, body, credentials, headers }) -> never throws; resolves with a plain object
window.call = async function call(url, opts) {
  opts = opts || {}
  const init = { method: opts.method || 'GET', credentials: opts.credentials || 'include', headers: opts.headers || {} }
  if (opts.mode) init.mode = opts.mode
  if (opts.body !== undefined) {
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
    if (typeof opts.body !== 'string') init.headers['content-type'] = 'application/json'
  }
  const entry = { url, method: init.method, credentials: init.credentials }
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch (e) {}
    Object.assign(entry, {
      ok: res.ok, status: res.status, json,
    })
  } catch (e) {
    entry.error = String(e && e.message || e)
    entry.blocked = true
  }
  window.__results.push(entry)
  document.getElementById('log').textContent += JSON.stringify(entry) + '\\n'
  return entry
}
window.readableCookie = function () { return document.cookie }
// Auto-submitting cross-site form: /form?action=<url>&field=<name>&value=<json>&enctype=<type>
if (location.pathname === '/form') {
  const q = new URL(location.href).searchParams
  window.submitForm = function () {
    const f = document.createElement('form')
    f.method = 'POST'
    f.action = q.get('action')
    f.enctype = q.get('enctype') || 'multipart/form-data'
    const i = document.createElement('input')
    i.type = 'hidden'; i.name = q.get('field') || '_payload'; i.value = q.get('value') || '{}'
    f.appendChild(i)
    document.body.appendChild(f)
    f.submit()
  }
}
</script></body></html>`

export type Harness = { port: number; close: () => Promise<void> }

export function startHarness(port: number): Promise<Harness> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
  })
  const sockets = new Set<import('node:net').Socket>()
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
