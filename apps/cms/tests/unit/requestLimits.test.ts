import { describe, expect, it } from 'vitest'

import {
  checkRequestLimits,
  MAX_JSON_BODY_BYTES,
  MAX_MEDIA_BODY_BYTES,
  hasAuthCredentials,
  mediaBodyLimitBytes,
} from '../../src/lib/requestLimits'

const check = (method: string, pathname: string, headers: Record<string, string> = {}) =>
  checkRequestLimits({ method, pathname, headers: new Headers(headers) })

const MB = 1024 * 1024
const COOKIE = { cookie: 'payload-token=abc.def.ghi' }

describe('mediaBodyLimitBytes (anonymous vs authenticated, one variable)', () => {
  it('anonymous requests never exceed 11 MB, whatever the env says', () => {
    expect(mediaBodyLimitBytes({})).toBe(MAX_MEDIA_BODY_BYTES)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '400', MEDIA_AV_MAX_MB: '400' })).toBe(MAX_MEDIA_BODY_BYTES)
  })

  it('authenticated: derived from MEDIA_AV_MAX_MB (default 100), never below the image cap', () => {
    expect(mediaBodyLimitBytes({}, true)).toBe(101 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '40' }, true)).toBe(41 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '5' }, true)).toBe(11 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_AV_MAX_MB: '9999' }, true)).toBe(501 * MB)
  })

  it('authenticated: MEDIA_UPLOAD_MAX_MB, when valid (11-500), overrides the derived value', () => {
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '200', MEDIA_AV_MAX_MB: '40' }, true)).toBe(201 * MB)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '9999' }, true)).toBe(501 * MB)
    for (const bad of ['', 'abc', '10', '0', '-5', '50.5']) expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: bad, MEDIA_AV_MAX_MB: '30' }, true), bad).toBe(31 * MB)
  })

  it('hasAuthCredentials: Authorization header or a *-token cookie', () => {
    expect(hasAuthCredentials(new Headers())).toBe(false)
    expect(hasAuthCredentials(new Headers({ authorization: 'JWT x' }))).toBe(true)
    expect(hasAuthCredentials(new Headers(COOKIE))).toBe(true)
    expect(hasAuthCredentials(new Headers({ cookie: 'theme=dark; payload-token=zzz' }))).toBe(true)
    expect(hasAuthCredentials(new Headers({ cookie: 'theme=dark' }))).toBe(false)
    expect(hasAuthCredentials(new Headers({ cookie: 'payload-token=' }))).toBe(false)
  })

  it('/api/media: more than 11 MB only with credentials; JSON routes keep 1 MB', () => {
    const big = { 'content-length': String(50 * MB) }
    expect(check('POST', '/api/media', big)).toMatchObject({ ok: false, status: 413 })
    expect(check('POST', '/api/media', { ...big, ...COOKIE })).toEqual({ ok: true })
    expect(check('POST', '/api/media', { ...big, authorization: 'JWT x' })).toEqual({ ok: true })
    expect(check('POST', '/api/media', { 'content-length': String(102 * MB), ...COOKIE })).toMatchObject({ ok: false, status: 413 })
    expect(check('POST', '/api/articles', { 'content-length': String(2 * MB), ...COOKIE })).toMatchObject({ ok: false, status: 413 })
  })

  it('/api/media: a chunked body (no Content-Length) is refused with 411, with or without credentials', () => {
    for (const method of ['POST', 'PATCH', 'PUT']) {
      expect(check(method, '/api/media', { 'transfer-encoding': 'chunked' })).toMatchObject({ ok: false, status: 411 })
      expect(check(method, '/api/media/5', { 'transfer-encoding': 'chunked', ...COOKIE })).toMatchObject({ ok: false, status: 411 })
    }
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
    // Other routes and methods are not subject to the 411 rule.
    expect(check('POST', '/api/articles', { 'transfer-encoding': 'chunked' })).toEqual({ ok: true })
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
