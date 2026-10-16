import { describe, expect, it } from 'vitest'

import {
  RedirectConfigError,
  articlePath,
  normalizePath,
  normalizeRequestPath,
  normalizeTarget,
  parseAllowedHosts,
  resolveArticlePathTemplate,
  slugFromArticlePath,
} from '../../src/lib/redirectPaths'

const path = (input: unknown): string => {
  const r = normalizePath(input)
  if (!r.ok) throw new Error(`expected ok, got: ${r.reason}`)
  return r.path
}
const reason = (input: unknown): string => {
  const r = normalizePath(input)
  if (r.ok) throw new Error(`expected a failure, got ${r.path}`)
  return r.reason
}

describe('normalizePath (C7.1 canonical form)', () => {
  it('adds the trailing slash to directory-style paths and keeps file extensions as they are', () => {
    expect(path('/old-slug')).toBe('/old-slug/')
    expect(path('/old-slug/')).toBe('/old-slug/')
    expect(path('/2019/05/some-story')).toBe('/2019/05/some-story/')
    expect(path('/feed.xml')).toBe('/feed.xml')
    expect(path('/wp-content/uploads/a.jpg')).toBe('/wp-content/uploads/a.jpg')
    expect(path('/')).toBe('/')
    expect(path('  /padded  ')).toBe('/padded/')
  })

  it('upper-cases percent-encoding and encodes non-ASCII, so every spelling of a slug is one key', () => {
    const key = '/caf%C3%A9/'
    expect(path('/caf%c3%a9/')).toBe(key)
    expect(path('/caf%C3%A9')).toBe(key)
    expect(path('/café/')).toBe(key)
    expect(path('/café'.normalize('NFD') + '/')).not.toBe('/cafe/') // not folded to ASCII
  })

  it('decodes unreserved characters, keeps an encoded slash encoded, and encodes everything else', () => {
    expect(path('/%41bc/')).toBe('/Abc/')
    expect(path('/a%2fb/')).toBe('/a%2Fb/')
    expect(path('/a b/'.replace(' ', '%20'))).toBe('/a%20b/')
    expect(path("/it's+a(b)/")).toBe('/it%27s%2Ba%28b%29/')
  })

  it('preserves case (paths are case-sensitive keys)', () => {
    expect(path('/Old-Slug/')).toBe('/Old-Slug/')
  })

  it('rejects scheme, host, protocol-relative and relative values', () => {
    expect(reason('https://example.test/a/')).toMatch(/not a URL/)
    expect(reason('//example.test/a/')).toMatch(/must not start with/)
    expect(reason('javascript:alert(1)')).toMatch(/not a URL/)
    expect(reason('old-slug/')).toMatch(/must start with "\/"/)
    expect(reason('')).toMatch(/empty/)
    expect(reason(42)).toMatch(/text/)
  })

  it('rejects backslashes, control characters (raw and encoded), CRLF and inner whitespace', () => {
    expect(reason('/a\\b/')).toMatch(/backslash/)
    expect(reason('/a\r\nSet-Cookie: x=1')).toMatch(/control/)
    expect(reason('/a\tb/')).toMatch(/control/)
    expect(reason('/a%0D%0Ab/')).toMatch(/encoded control/)
    expect(reason('/a%00b/')).toMatch(/encoded control/)
    expect(reason('/a b/')).toMatch(/whitespace/)
  })

  it('rejects query strings, fragments, wildcards, dot segments and empty segments', () => {
    expect(reason('/a/?p=1')).toMatch(/query string or fragment/)
    expect(reason('/a/#top')).toMatch(/query string or fragment/)
    expect(reason('/category/*')).toMatch(/wildcards/)
    expect(reason('/a/../b/')).toMatch(/dot segment/)
    expect(reason('/a/./b/')).toMatch(/dot segment/)
    expect(reason('/a/%2e%2e/b/')).toMatch(/dot segment/)
    expect(reason('/a//b/')).toMatch(/empty segment/)
  })

  it('rejects a broken percent escape and over-long paths', () => {
    expect(reason('/a%zz/')).toMatch(/two hex digits/)
    expect(reason('/a%4/')).toMatch(/two hex digits/)
    expect(reason(`/${'a'.repeat(300)}/`)).toMatch(/longer than 300/)
    expect(path(`/${'a'.repeat(297)}/`)).toHaveLength(299)
  })

  it('is idempotent', () => {
    for (const input of ['/Caf%c3%a9', '/a%2fb', '/x/y.html', '/a+b', '/ünï/cödé']) {
      const once = path(input)
      expect(path(once)).toBe(once)
    }
  })
})

describe('normalizeRequestPath (what the public host runs before the lookup)', () => {
  it('drops the query string and fragment first', () => {
    expect(normalizeRequestPath('/old-slug?utm_source=x#top')).toBe('/old-slug/')
    expect(normalizeRequestPath('/caf%c3%a9?x=%')).toBe('/caf%C3%A9/') // a stray % in the query is not a reason to 404
  })
  it('returns null (404) when the path itself cannot be normalised', () => {
    expect(normalizeRequestPath('/a/../b')).toBeNull()
    expect(normalizeRequestPath('//example.test/')).toBeNull()
  })
})

describe('normalizeTarget', () => {
  const hosts = ['www.example.test']
  it('accepts a canonical internal path', () => {
    expect(normalizeTarget('/new-slug', hosts)).toEqual({ ok: true, to: '/new-slug/', external: false })
  })
  it('accepts an https URL on an allowed host, lower-casing the host and normalising the path', () => {
    expect(normalizeTarget('https://WWW.Example.test/Caf%c3%a9', hosts)).toEqual({
      ok: true,
      to: 'https://www.example.test/Caf%C3%A9/',
      external: true,
    })
    expect(normalizeTarget('https://www.example.test', hosts)).toMatchObject({ to: 'https://www.example.test/' })
  })
  it('rejects hosts that are not allowed, http, credentials, ports, query strings and look-alikes', () => {
    const bad = (v: string) => {
      const r = normalizeTarget(v, hosts)
      expect(r.ok, v).toBe(false)
    }
    bad('https://evil.example.test/a/')
    bad('http://www.example.test/a/')
    bad('https://user@www.example.test/a/')
    bad('https://www.example.test:8443/a/')
    bad('https://www.example.test/a/?x=1')
    bad('https://www.example.test.evil.test/a/')
    bad('https://www.example.test\\@evil.test/')
    bad('ftp://www.example.test/')
    bad('//www.example.test/a/')
    bad('www.example.test/a/')
  })
  it('accepts no absolute URL at all when REDIRECT_ALLOWED_HOSTS is empty', () => {
    expect(normalizeTarget('https://www.example.test/a/', []).ok).toBe(false)
  })
})

describe('environment values fail loudly', () => {
  it('PUBLIC_ARTICLE_PATH_TEMPLATE: default, the two accepted values, and nothing else', () => {
    expect(resolveArticlePathTemplate({})).toBe('/reports/{slug}/')
    expect(resolveArticlePathTemplate({ PUBLIC_ARTICLE_PATH_TEMPLATE: '  ' })).toBe('/reports/{slug}/')
    expect(resolveArticlePathTemplate({ PUBLIC_ARTICLE_PATH_TEMPLATE: '/{slug}/' })).toBe('/{slug}/')
    expect(resolveArticlePathTemplate({ PUBLIC_ARTICLE_PATH_TEMPLATE: '/reports/{slug}/' })).toBe('/reports/{slug}/')
    for (const bad of ['/{slug}', '/news/{slug}/', '/reports/{slug}', 'reports/{slug}/', '/{id}/', 'https://example.test/{slug}/']) {
      expect(() => resolveArticlePathTemplate({ PUBLIC_ARTICLE_PATH_TEMPLATE: bad }), bad).toThrow(RedirectConfigError)
    }
  })
  it('REDIRECT_ALLOWED_HOSTS: bare host names only', () => {
    expect(parseAllowedHosts({})).toEqual([])
    expect(parseAllowedHosts({ REDIRECT_ALLOWED_HOSTS: ' WWW.Example.test, example.test ,www.example.test' })).toEqual([
      'www.example.test',
      'example.test',
    ])
    for (const bad of ['https://www.example.test', 'www.example.test/path', 'www.example.test:8443', '*.example.test', 'a b']) {
      expect(() => parseAllowedHosts({ REDIRECT_ALLOWED_HOSTS: bad }), bad).toThrow(RedirectConfigError)
    }
  })
})

describe('article path helpers', () => {
  it('builds and reverses the current public path for both templates', () => {
    expect(articlePath('/reports/{slug}/', 'new-slug')).toBe('/reports/new-slug/')
    expect(articlePath('/{slug}/', 'new-slug')).toBe('/new-slug/')
    expect(slugFromArticlePath('/reports/{slug}/', '/reports/new-slug/')).toBe('new-slug')
    expect(slugFromArticlePath('/{slug}/', '/new-slug/')).toBe('new-slug')
    expect(slugFromArticlePath('/{slug}/', '/reports/new-slug/')).toBeNull()
    expect(slugFromArticlePath('/reports/{slug}/', '/new-slug/')).toBeNull()
  })
})
