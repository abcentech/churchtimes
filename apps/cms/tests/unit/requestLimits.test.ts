import { describe, expect, it } from 'vitest'

import {
  checkRequestLimits,
  MAX_JSON_BODY_BYTES,
  MAX_MEDIA_BODY_BYTES,
  mediaBodyLimitBytes,
  wantsLargeMediaBody,
} from '../../src/lib/requestLimits'

const check = (method: string, pathname: string, headers: Record<string, string> = {}) =>
  checkRequestLimits({ method, pathname, headers: new Headers(headers) })

const MB = 1024 * 1024

describe('mediaBodyLimitBytes (anonymous vs verified session, configured sizes only)', () => {
  it('unverified callers never exceed 11 MB, whatever the env says', () => {
    expect(mediaBodyLimitBytes({})).toBe(MAX_MEDIA_BODY_BYTES)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '400', MEDIA_AV_MAX_MB: '400' })).toBe(MAX_MEDIA_BODY_BYTES)
  })

  it('a verified session stays at 11 MB unless a larger size is configured', () => {
    expect(mediaBodyLimitBytes({}, true)).toBe(MAX_MEDIA_BODY_BYTES)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '' }, true)).toBe(MAX_MEDIA_BODY_BYTES)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: 'abc' }, true)).toBe(MAX_MEDIA_BODY_BYTES)
  })

  it('a verified session: MEDIA_AV_MAX_MB (explicit) sets max(10, it) + 1 MB; MEDIA_UPLOAD_MAX_MB (11-500) overrides it', () => {
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '40' }, true)).toBe(41 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '5' }, true)).toBe(11 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '9999' }, true)).toBe(501 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '200', MEDIA_AV_MAX_MB: '40' }, true)).toBe(201 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '9999' }, true)).toBe(501 * MB)
    for (const bad of ['', 'abc', '10', '0', '-5', '50.5']) expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: bad, MEDIA_AV_MAX_MB: '30' }, true), bad).toBe(31 * MB)
  })

  it('/api/media: more than 11 MB only when the proxy verified the session and a size is configured; JSON routes keep 1 MB', () => {
    const before = { up: process.env.MEDIA_UPLOAD_MAX_MB, av: process.env.MEDIA_AV_MAX_MB }
    process.env.MEDIA_AV_MAX_MB = '100'
    delete process.env.MEDIA_UPLOAD_MAX_MB
    try {
      const big = { 'content-length': String(50 * MB) }
      const run = (headers: Record<string, string>, authenticated?: boolean) =>
        checkRequestLimits({ method: 'POST', pathname: '/api/media', headers: new Headers(headers), authenticated })
      expect(run(big)).toMatchObject({ ok: false, status: 413 })
      // forged credential headers do not help: only the proxy's verified flag does
      expect(run({ ...big, authorization: 'JWT forged', cookie: 'payload-token=forged' })).toMatchObject({ ok: false, status: 413 })
      expect(run(big, true)).toEqual({ ok: true })
      expect(run({ 'content-length': String(102 * MB) }, true)).toMatchObject({ ok: false, status: 413 })
      expect(check('POST', '/api/articles', { 'content-length': String(2 * MB) })).toMatchObject({ ok: false, status: 413 })
      expect(wantsLargeMediaBody('/api/media', new Headers(big))).toBe(true)
      expect(wantsLargeMediaBody('/api/media', new Headers({ 'content-length': '1000' }))).toBe(false)
      expect(wantsLargeMediaBody('/api/articles', new Headers(big))).toBe(false)
    } finally {
      if (before.up === undefined) delete process.env.MEDIA_UPLOAD_MAX_MB
      else process.env.MEDIA_UPLOAD_MAX_MB = before.up
      if (before.av === undefined) delete process.env.MEDIA_AV_MAX_MB
      else process.env.MEDIA_AV_MAX_MB = before.av
    }
  })

  it('a chunked body (Transfer-Encoding) on ANY /api write is refused with 411', () => {
    for (const path of ['/api/media', '/api/media/5', '/api/users/login', '/api/articles', '/api/public/submissions', '/api/public/newsletter/subscribe', '/api/staff/related-articles', '/api/live-updates']) {
      for (const method of ['POST', 'PATCH', 'PUT']) {
        expect(check(method, path, { 'transfer-encoding': 'chunked' }), `${method} ${path}`).toMatchObject({ ok: false, status: 411 })
      }
    }
    // also when a Content-Length is sent alongside (request smuggling shape)
    expect(check('POST', '/api/articles', { 'transfer-encoding': 'chunked', 'content-length': '5' })).toMatchObject({ ok: false, status: 411 })
    expect(check('GET', '/api/media/file/a.jpg')).toEqual({ ok: true })
  })
})

describe('checkRequestLimits (request-size policy for /api/*)', () => {
  it('lets ordinary requests through', () => {
    expect(check('GET', '/api/articles')).toEqual({ ok: true })
    expect(check('POST', '/api/articles', { 'content-length': '2048' })).toEqual({ ok: true })
    expect(check('POST', '/api/users/logout')).toEqual({ ok: true }) // no body, no content-length
    expect(check('POST', '/api/users/login', { 'content-length': '60' })).toEqual({ ok: true })
  })

  it('rejects JSON bodies over 1 MB with 413', () => {
    expect(check('POST', '/api/articles', { 'content-length': String(MAX_JSON_BODY_BYTES) })).toEqual({ ok: true })
    const res = check('POST', '/api/articles', { 'content-length': String(MAX_JSON_BODY_BYTES + 1) })
    expect(res).toMatchObject({ ok: false, status: 413 })
    expect(check('PATCH', '/api/users/3', { 'content-length': '99999999' })).toMatchObject({ ok: false, status: 413 })
    expect(check('POST', '/api/public/submissions', { 'content-length': '5000000' })).toMatchObject({ status: 413 })
  })

  it('allows up to 11 MB only on /api/media', () => {
    expect(check('POST', '/api/media', { 'content-length': String(MAX_MEDIA_BODY_BYTES) })).toEqual({ ok: true })
    expect(check('PATCH', '/api/media/12', { 'content-length': '10000000' })).toEqual({ ok: true })
    expect(check('POST', '/api/media', { 'content-length': String(MAX_MEDIA_BODY_BYTES + 1) })).toMatchObject({
      ok: false,
      status: 413,
    })
    // Look-alike paths do not get the upload allowance.
    expect(check('POST', '/api/media-evil', { 'content-length': '5000000' })).toMatchObject({ status: 413 })
    expect(check('POST', '/api/articles/media', { 'content-length': '5000000' })).toMatchObject({ status: 413 })
  })

  it('rejects a chunked (length-less) body on /api/users writes with 411', () => {
    for (const method of ['POST', 'PATCH', 'PUT']) {
      expect(check(method, '/api/users/login', { 'transfer-encoding': 'chunked' })).toMatchObject({ ok: false, status: 411 })
      expect(check(method, '/api/users/7', { 'transfer-encoding': 'chunked' })).toMatchObject({ ok: false, status: 411 })
    }
    expect(check('POST', '/api/users', { 'transfer-encoding': 'chunked' })).toMatchObject({ ok: false, status: 411 })
    // GET is not subject to the 411 rule.
    expect(check('GET', '/api/users/me')).toEqual({ ok: true })
    // A declared length (even 0) satisfies the rule.
    expect(check('POST', '/api/users/logout', { 'content-length': '0' })).toEqual({ ok: true })
  })

  it('rejects a malformed Content-Length with 400', () => {
    for (const bad of ['abc', '-5', '1.5', '1e3', '12 34']) {
      expect(check('POST', '/api/articles', { 'content-length': bad }), bad).toMatchObject({ ok: false, status: 400 })
    }
  })

  it('ignores non-API paths', () => {
    expect(check('POST', '/admin/login', { 'content-length': '99999999' })).toEqual({ ok: true })
    expect(check('POST', '/apix/foo', { 'content-length': '99999999' })).toEqual({ ok: true })
  })
})
