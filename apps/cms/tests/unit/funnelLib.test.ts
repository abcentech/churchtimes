import { describe, expect, it } from 'vitest'

import { analyzeServe, entriesToOurPorts, isPortListed, proxyPort } from '../../scripts/funnel-lib.mjs'

const HOST = 'staging.example.ts.net'
const cfg = { publicPort: 48501, newsroomPort: 48502, cmsPort: 48503 }
const web = (port: number, handlers: Record<string, unknown>) => ({ [`${HOST}:${port}`]: { Handlers: handlers } })

describe('funnel serve analysis', () => {
  it('parses loopback proxy targets only', () => {
    expect(proxyPort('http://127.0.0.1:48501')).toBe(48501)
    expect(proxyPort('http://localhost:48501/')).toBe(48501)
    expect(proxyPort('https://example.org:443')).toBeNull()
    expect(proxyPort(undefined)).toBeNull()
  })

  it('recognises an empty serve config and our own entries', () => {
    expect(analyzeServe({}, HOST, cfg).every((e) => !e.listed && e.foreignReasons.length === 0)).toBe(true)
    const serve = { TCP: { '443': { HTTPS: true } }, Web: web(443, { '/': { Proxy: 'http://127.0.0.1:48501' } }), AllowFunnel: { [`${HOST}:443`]: true } }
    const [pub] = analyzeServe(serve, HOST, cfg)
    expect(pub).toMatchObject({ ours: true, funnel: true, listed: true, foreignReasons: [] })
  })

  it('flags other path handlers, other targets and raw TCP forwards (Funnel would publish them too)', () => {
    const serve = {
      TCP: { '8443': { HTTPS: true }, '10000': { TCPForward: '127.0.0.1:22' } },
      Web: { ...web(443, { '/': { Proxy: 'http://127.0.0.1:48501' }, '/private': { Path: 'C:\secret' } }), ...web(8443, { '/': { Proxy: 'http://127.0.0.1:3000' } }) },
    }
    const [pub, news, cms] = analyzeServe(serve, HOST, cfg)
    expect(pub!.foreignReasons).toEqual(['a handler for the path /private'])
    expect(news!.foreignReasons).toEqual(['a proxy to http://127.0.0.1:3000'])
    expect(cms!.foreignReasons[0]).toMatch(/raw TCP forward to 127\.0\.0\.1:22/)
  })

  it('finds stale entries that point at our ports, and listing by port', () => {
    const serve = { Web: web(10000, { '/': { Proxy: 'http://127.0.0.1:48503' } }), AllowFunnel: { [`${HOST}:10000`]: true } }
    expect(entriesToOurPorts(serve, cfg)).toEqual([{ key: `${HOST}:10000`, name: 'cms', httpsPort: 10000, localPort: 48503, funnel: true }])
    expect(entriesToOurPorts({ Web: web(443, { '/': { Proxy: 'http://127.0.0.1:9999' } }) }, cfg)).toEqual([])
    expect(isPortListed(serve, 10000)).toBe(true)
    expect(isPortListed(serve, 443)).toBe(false)
  })
})
