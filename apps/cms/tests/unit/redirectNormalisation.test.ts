import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  RedirectConfigError,
  normalizePath,
  normalizeRequestPath,
  parseLegacyHosts,
  targetPathOf,
} from '../../src/lib/redirectPaths'
import { isJunkPath } from '../fixtures/publicHostValidator.mjs'

type Vectors = {
  normalize: { input: string; path: string }[]
  reject: { input: string; why: string }[]
  request: { input: string; path: string | null }[]
}
const vectors: Vectors = JSON.parse(
  readFileSync(new URL('../fixtures/redirect-normalisation.json', import.meta.url), 'utf8'),
)

const path = (input: string): string => {
  const r = normalizePath(input)
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`)
  return r.path
}

describe('shared test vectors (tests/fixtures/redirect-normalisation.json, reusable by the public host)', () => {
  it.each(vectors.normalize.map((v) => [v.input, v.path]))('normalises %j to %j', (input, expected) => {
    expect(path(input)).toBe(expected)
    expect(path(expected)).toBe(expected) // idempotent
  })

  it.each(vectors.reject.map((v) => [v.input, v.why]))('rejects %j (%s)', (input) => {
    expect(normalizePath(input).ok).toBe(false)
  })

  it.each(vectors.request.map((v) => [v.input, v.path]))('request target %j resolves to %j', (input, expected) => {
    expect(normalizeRequestPath(input as string)).toBe(expected)
  })

  it('rejects raw line and paragraph separators and raw C1 characters', () => {
    for (const code of [0x2028, 0x2029, 0x85, 0x9f]) {
      expect(normalizePath(`/a${String.fromCharCode(code)}b/`).ok, code.toString(16)).toBe(false)
    }
  })

  it('makes /café/ and /cafe%CC%81/ one key (NFC), also for a raw combining mark', () => {
    expect(path('/café/')).toBe(path('/cafe%CC%81/'))
    expect(path('/café/')).toBe(path('/caf%c3%a9'))
  })
})

describe('everything the public host treats as junk is rejected here (its own isJunkPath is the oracle)', () => {
  // Seeded generator: a deterministic mix of ordinary, awkward and hostile fragments.
  const fragments = [
    'a', 'b-c', 'Old', 'caf%C3%A9', 'caf%c3%a9', 'cafe%CC%81', 'é', '%2F', '%2f', '%5C', '%5c', '%25', '%23', '%00', '%0D%0A',
    '%C2%85', '%E2%80%A8', '%E2%80%A9', '%C3', '%FF', '%C0%AF', '%2e', '%2E%2E', '.', '..', 'tel:1', 'data:x', 'javascript:1', 'mailto:a',
    'https:', 'x:y', "it's", 'a+b', '(c)', '%20', '%41', '%zz', '%4', '*', '\\', '%3A', ':', '@', ',', ';', '=', '!', '$', '&',
  ]
  const rand = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }

  it('no normalised path is junk to the host, and normalising again changes nothing (5,000 generated paths)', () => {
    const next = rand(20261016)
    let accepted = 0
    for (let i = 0; i < 5000; i++) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
        const n = 1 + Math.floor(next() * 3)
        return Array.from({ length: n }, () => fragments[Math.floor(next() * fragments.length)]).join(next() < 0.2 ? '-' : '')
      })
      const input = `/${parts.join('/')}${next() < 0.5 ? '/' : ''}`
      const result = normalizePath(input)
      if (!result.ok) continue
      accepted++
      expect(isJunkPath(result.path), `${JSON.stringify(input)} -> ${result.path}`).toBe(false)
      expect(path(result.path)).toBe(result.path)
    }
    expect(accepted).toBeGreaterThan(300) // the generator is not vacuous
  })

  it('every vector the host calls junk is rejected by normalizePath too', () => {
    for (const { input } of vectors.reject) {
      if (isJunkPath(input)) expect(normalizePath(input).ok, input).toBe(false)
    }
  })
})

describe('LEGACY_SITE_HOSTS and targetPathOf', () => {
  it('defaults to the publication host and its www form, and validates a configured list', () => {
    expect(parseLegacyHosts({})).toEqual(['churchtimesnigeria.net', 'www.churchtimesnigeria.net'])
    expect(parseLegacyHosts({ LEGACY_SITE_HOSTS: ' Old.Example.test ,old.example.test' })).toEqual(['old.example.test'])
    for (const bad of ['https://old.example.test', 'old.example.test/x', 'old.example.test:80', '*.example.test']) {
      expect(() => parseLegacyHosts({ LEGACY_SITE_HOSTS: bad }), bad).toThrow(RedirectConfigError)
    }
  })
  it('reads the path of an internal or absolute target', () => {
    expect(targetPathOf('/a/')).toBe('/a/')
    expect(targetPathOf('https://www.example.test/a/b/')).toBe('/a/b/')
    expect(targetPathOf('https://www.example.test/')).toBe('/')
  })
})
