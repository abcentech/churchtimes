import { describe, expect, it } from 'vitest'

import {
  checkRequestLimits,
  MAX_JSON_BODY_BYTES,
  MAX_MEDIA_BODY_BYTES,
  mediaBodyLimitBytes,
} from '../../src/lib/requestLimits'

const check = (method: string, pathname: string, headers: Record<string, string> = {}) =>
  checkRequestLimits({ method, pathname, headers: new Headers(headers) })

describe('mediaBodyLimitBytes (opt-in MEDIA_UPLOAD_MAX_MB)', () => {
  it('keeps 11 MB unless a valid value of 11 or more is set, and caps at 500 MB + 1', () => {
    expect(mediaBodyLimitBytes({})).toBe(MAX_MEDIA_BODY_BYTES)
    for (const bad of ['', 'abc', '10', '0', '-5', '50.5']) expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: bad })).toBe(MAX_MEDIA_BODY_BYTES)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '100' })).toBe(101 * 1024 * 1024)
    expect(mediaBodyLimitBytes({ MEDIA_UPLOAD_MAX_MB: '9999' })).toBe(501 * 1024 * 1024)
  })

  it('only the media route follows it; JSON routes keep 1 MB', () => {
    const before = process.env.MEDIA_UPLOAD_MAX_MB
    process.env.MEDIA_UPLOAD_MAX_MB = '100'
    try {
      expect(check('POST', '/api/media', { 'content-length': String(50 * 1024 * 1024) })).toEqual({ ok: true })
      expect(check('POST', '/api/media', { 'content-length': String(102 * 1024 * 1024) })).toMatchObject({ ok: false, status: 413 })
      expect(check('POST', '/api/articles', { 'content-length': String(2 * 1024 * 1024) })).toMatchObject({ ok: false, status: 413 })
    } finally {
      if (before === undefined) delete process.env.MEDIA_UPLOAD_MAX_MB
      else process.env.MEDIA_UPLOAD_MAX_MB = before
    }
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
