import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPublicRedirects, compileRedirectMap, isJunkPath, MAX_REDIRECT_RULES, MAX_REDIRECT_BYTES} from '../tools/public-redirects.mjs';
import {readRedirectChecks, checkRedirects, redirectCheckCLI} from '../tools/check-redirects.mjs';

// All redirect maps, endpoint responses, article lookups and HTTP targets below
// are SYNTHETIC STUBS, not the unimplemented C7 CMS endpoint or import evidence.
const map = (rules = [{from: '/old/', to: '/reports/new/', status: 301, source: 'legacy-url'}]) => ({version: 'sha256:synthetic', generatedAt: '2026-10-16T00:00:00Z', count: rules.length, rules});
const row = (from, to, status = 301) => ({from, to, status, source: 'manual'});
async function invoke(handler, path = '/old/', method = 'GET') {
  let response;
  const handled = await handler({method, url: new URL(path, 'https://public.example.test'), rawUrl: path}, (...args) => { response = args; });
  return {handled, response};
}
async function tempFile(t, data) {
  const directory = await mkdtemp(join(tmpdir(), 'public-redirects-stub-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const path = join(directory, 'synthetic.json');
  await writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));
  return path;
}

test('synthetic C7 map: exact O(1) entries, statuses and GET/HEAD only', async t => {
  const file = await tempFile(t, map([row('/old/', '/reports/new/'), row('/temporary/', '/about/', 302), row('/gone/', null, 410)]));
  const handler = createPublicRedirects({file});
  assert.equal(compileRedirectMap(map()).get('/old/').to, '/reports/new/');
  for (const method of ['GET', 'HEAD']) {
    for (const [path, status, location] of [['/old/', 301, '/reports/new/'], ['/temporary/', 302, '/about/'], ['/gone/', 410, undefined]]) {
      const result = await invoke(handler, path, method);
      assert.equal(result.handled, true); assert.equal(result.response[0], status); assert.equal(result.response[3].Location, location);
    }
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await invoke(handler, '/old/', method)).handled, false);
  assert.equal((await invoke(handler, '/other/')).handled, false);
  assert.equal((await invoke(handler, '/old/?next=https://evil.example.test')).response[3].Location, '/reports/new/');
});

test('no configuration and absent file mean no redirect and no network; invalid generations fail closed atomically', async t => {
  let calls = 0;
  const fetchImpl = () => { calls++; assert.fail('Unexpected network'); };
  assert.equal((await invoke(createPublicRedirects({file: '', endpoint: '', fetchImpl}))).handled, false);
  const file = await tempFile(t, map([row('/old/', '/valid/'), row('/unsafe/', '//evil.example.test/')]));
  assert.equal((await invoke(createPublicRedirects({file, fetchImpl}))).handled, false);
  assert.equal((await invoke(createPublicRedirects({file: file + '-absent', fetchImpl}))).handled, false);
  assert.equal(calls, 0);
});

test('synthetic maps reject duplicates, loops, chains, unsupported status, unsafe source and destinations', () => {
  const unsafe = ['//evil.example.test/path', 'javascript:alert(1)', 'http://example.test/', 'https://user:pass@example.test/', 'https://evil.example.test/', 'https://example.test?x=%0d/path', '/%2f%2fevil.example.test/', '/x%5cy', '/x%252fy', '/x\\y', '/x\ny', '/x%0dy', '/a/../target/', '/a/%2e%2e/target/', '/x#fragment'];
  for (const to of unsafe) assert.throws(() => compileRedirectMap(map([row('/from/', to)]), {allowedHosts: ['example.test']}));
  for (const rules of [[row('/same/', '/a/'), row('/same/', '/b/')], [row('/a/', '/a/')], [row('/a/', '/b/'), row('/b/', '/a/')], [row('/a/', '/b/?x=1'), row('/b/', '/c/')], [row('/a/', '/', 308)], [{...row('/a/', '/b/'), source: 'untrusted'}]]) assert.throws(() => compileRedirectMap(map(rules)));
  assert.throws(() => compileRedirectMap(map([row('/a/', 'https://public.example.test/b/'), row('/b/', '/c/')]), {allowedHosts: ['public.example.test'], siteUrl: 'https://public.example.test'}));
  assert.equal(compileRedirectMap(map([row('/old/', 'https://approved.example.test/new/')]), {allowedHosts: ['approved.example.test'],siteUrl:'https://public.example.test'}).get('/old/').to, 'https://approved.example.test/new/');
  assert.equal(compileRedirectMap(map([row('/old/', '/caf\u00e9/')])).get('/old/').to, '/caf%C3%A9/');
  assert.throws(() => compileRedirectMap(map([row('/old/', 'https://public.example.test/old/')]), {allowedHosts:['public.example.test']}), /PUBLIC_SITE_URL/);
  assert.throws(() => createPublicRedirects({allowedHosts:['public.example.test'],patterns:{feed:'https://public.example.test/feed/'}}), /PUBLIC_SITE_URL/);
  assert.throws(() => compileRedirectMap({...map(), count: 7}));
  assert.throws(() => compileRedirectMap(map(Array.from({length: MAX_REDIRECT_RULES + 1}, (_, index) => row('/x-' + index, '/new/')))));
  assert.throws(() => compileRedirectMap({...map(), extra: 'x'.repeat(MAX_REDIRECT_BYTES)}));
});

test('junk is detected before URL normalisation with zero CMS requests or map load', async () => {
  let calls = 0;
  const handler = createPublicRedirects({endpoint: 'https://cms.example.test/api/public/redirects', fetchImpl: () => { calls++; assert.fail(); }});
  for (const path of ['/tel:+2340000', '/archive/tel:123/', '/%74el:123/', '/a'.repeat(2049), '/bad%zz', '/%2fhost/', '/%252fhost/', '/a\\b', '/a/../b', '/a/%2e%2e/b', '//evil.test/path', '/x%00y', '/x?bad=%0d', '/x?bad=%zz']) {
    assert.equal(isJunkPath(path), true, path);
    // The parsed URL is deliberately unrelated: the raw request guard must win.
    let status;
    assert.equal(await handler({method: 'GET', url: new URL('https://public.example.test/'), rawUrl: path}, code => { status = code; }), true);
    assert.equal(status, 404);
  }
  for (const path of ['/', '/reports/new/', '/category/church/', '/?p=42', '/api/media/file/synthetic.webp', '/api/media/file/synthetic%20image.webp', '/?search=church%20news']) assert.equal(isJunkPath(path), false, path);
  assert.equal(calls, 0);
});

test('stub C7 endpoint uses bounded ETag cache, omits credentials, coalesces reads and drops a bad refresh', async () => {
  let time = 1000, calls = 0;
  const handler = createPublicRedirects({endpoint: 'https://cms.example.test/api/public/redirects', now: () => time, cacheMs: 1000,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://cms.example.test/api/public/redirects');
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      if (calls === 2) { assert.equal(options.headers['If-None-Match'], '"synthetic-etag"'); return new Response(null, {status: 304}); }
      if (calls === 3) return Response.json(map([row('/old/', '//evil.test/')]), {headers: {etag: '"invalid"'}});
      return Response.json(map(), {headers: {etag: '"synthetic-etag"'}});
    },
  });
  const first = await Promise.all([invoke(handler), invoke(handler), invoke(handler)]);
  assert.equal(calls, 1); assert.ok(first.every(result => result.response[0] === 301));
  time += 1001; assert.equal((await invoke(handler)).handled, true); assert.equal(calls, 2);
  time += 1001; assert.equal((await invoke(handler)).handled, false); assert.equal(calls, 3);
  assert.equal((await invoke(handler)).handled, false); assert.equal(calls, 3);
});

test('stub C7 endpoint fails closed on unavailable, wrong MIME, oversized or malformed responses', async () => {
  for (const make of [() => new Response('unavailable', {status: 503}), () => new Response(JSON.stringify(map())), () => Response.json(map(), {headers: {'content-length': String(MAX_REDIRECT_BYTES + 1)}}), () => new Response('x'.repeat(MAX_REDIRECT_BYTES + 1), {headers: {'content-type': 'application/json'}}), () => new Response('{', {headers: {'content-type': 'application/json'}})]) {
    const handler = createPublicRedirects({endpoint: 'https://cms.example.test/api/public/redirects', fetchImpl: async () => make()});
    assert.equal((await invoke(handler)).handled, false);
  }
  for (const endpoint of ['http://private.example.test/api/public/redirects', 'https://user:pass@example.test/api/public/redirects', 'https://cms.example.test/api/redirects', 'https://cms.example.test/api/public/redirects?secret=synthetic']) assert.throws(() => createPublicRedirects({endpoint}));
});

test('optional pattern destinations have no defaults; exact wins; slug/page input is rebuilt through explicit templates', async t => {
  const disabled = createPublicRedirects();
  for (const path of ['/category/church/', '/tag/news/', '/author/editor/', '/page/2/', '/feed/', '/some-story/amp/', '/?p=42']) assert.equal((await invoke(disabled, path)).handled, false);
  const file = await tempFile(t, map([row('/category/church/', '/about/')]));
  const patterns = {category: '/sections/{slug}/', tag: '/topics/{slug}/', author: '/people/{slug}/', page: '/latest/?page={page}', feed: '/feed.xml', amp: '/reports/{slug}/'};
  const enabled = createPublicRedirects({file, patterns});
  for (const [from, to] of [['/category/church/', '/about/'], ['/category/faith/', '/sections/faith/'], ['/tag/news/', '/topics/news/'], ['/author/editor/', '/people/editor/'], ['/page/12/', '/latest/?page=12'], ['/feed/', '/feed.xml'], ['/some-story/amp/', '/reports/some-story/'], ['/reports/some-story/amp/', '/reports/some-story/'], ['/amp/some-story/', '/reports/some-story/'], ['/some-story/?amp=1', '/reports/some-story/']]) assert.equal((await invoke(enabled, from)).response[3].Location, to);
  for (const path of ['/category/evil%3Ahost/', '/category/x/y/', '/page/0/', '/page/1000000/', '/some-story/?amp=evil', '/?p=42']) assert.equal((await invoke(enabled, path)).handled, false);
  for (const patterns of [{category: '//evil.test/{slug}/'}, {page: '/latest/{slug}/'}, {unknown: '/a/'}, {amp: '/{slug}/{other}/'}]) assert.throws(() => createPublicRedirects({patterns}));
  assert.equal((await invoke(createPublicRedirects({patterns: {tag: '/latest/'}}), '/tag/news/')).response[3].Location, '/latest/');
  assert.equal((await invoke(enabled, '/some-story?amp=1')).response[3].Location, '/reports/some-story/');
});

test('pattern/exact and pattern/pattern chains never produce a multi-hop Location', async t => {
  const file = await tempFile(t, map([row('/old/', '/category/church/')]));
  const handler = createPublicRedirects({file, patterns: {category: '/sections/{slug}/'}});
  assert.equal((await invoke(handler)).handled, false, 'exact generation is rejected atomically');
  const chainFile = await tempFile(t, map([row('/sections/church/', '/about/')]));
  assert.equal((await invoke(createPublicRedirects({file: chainFile, patterns: {category: '/sections/{slug}/'}}), '/category/church/')).handled, false);
  assert.equal((await invoke(createPublicRedirects({patterns: {category: '/tag/{slug}/', tag: '/topics/{slug}/'}}), '/category/church/')).handled, false);
  assert.equal((await invoke(createPublicRedirects({patterns: {amp: '/{slug}/?amp=1'}}), '/a/amp/')).handled, false);
});

test('canonical-path targets cannot introduce a second host redirect for either article template or base path', () => {
  for (const to of ['/reports/story', '/latest', '/about', '/contact', '/advertise', '/category/church']) assert.throws(() => compileRedirectMap(map([row('/old/', to)])), /canonical-path/);
  assert.throws(() => compileRedirectMap(map([row('/old/', '/story')]), {articlePathTemplate: '/{slug}/'}), /canonical-path/);
  assert.throws(() => compileRedirectMap(map([row('/old/', '/journal/reports/story')]), {basePath: '/journal/'}), /canonical-path/);
  assert.throws(() => createPublicRedirects({patterns: {amp: '/reports/{slug}'}}), /canonical-path/);
  assert.throws(() => createPublicRedirects({patterns: {amp: '/{slug}'}, articlePathTemplate: '/{slug}/'}), /canonical-path/);
  assert.equal(compileRedirectMap(map([row('/old/', '/reports/story/')])).size, 1);
  assert.equal(compileRedirectMap(map([row('/old/', '/story/')]), {articlePathTemplate: '/{slug}/'}).size, 1);
});

test('legacy ID uses only an explicitly injected published-only adapter (STUB), never invents a CMS request', async () => {
  const patterns = {legacyId: '/reports/{slug}/'};
  let calls = 0;
  assert.equal((await invoke(createPublicRedirects({patterns}), '/?p=42')).handled, false);
  for (const article of [{status: 'draft', legacyId: 42, slug: 'new'}, {status: 'published', legacyId: 43, slug: 'new'}, {status: 'published', legacyId: 42, slug: '//evil.test'}, null]) {
    assert.equal((await invoke(createPublicRedirects({patterns, resolveLegacyId: async () => article}), '/?p=42')).handled, false);
  }
  const handler = createPublicRedirects({patterns, resolveLegacyId: async id => { calls++; assert.equal(id, '42'); return {status: 'published', legacyId: 42, slug: 'new'}; }});
  assert.equal((await invoke(handler, '/?p=42')).response[3].Location, '/reports/new/');
  for (const path of ['/?p=42&p=43', '/?p=evil', '/?p=-1', '/tel:123?p=42']) await invoke(handler, path);
  assert.equal(calls, 1);
});

test('cutover checker input and explicit-target guard reject unsafe configuration before a request', async () => {
  assert.deepEqual(readRedirectChecks('/old/\n/second/'), [{path: '/old/', expectedStatus: undefined, expectedTitle: undefined}, {path: '/second/', expectedStatus: undefined, expectedTitle: undefined}]);
  for (const input of ['["//evil.test/"]', '["https://production.test/"]', '[]', '[{"path":"/a/","expectedStatus":308}]']) assert.throws(() => readRedirectChecks(input));
  let calls = 0;
  for (const target of [undefined, 'https://user:pass@example.test/', 'http://production.test/', 'https://example.test/subpath/']) await assert.rejects(checkRedirects({target, checks: [], fetchImpl: () => { calls++; }}));
  const output = [], errors = [];
  assert.equal(await redirectCheckCLI(['--urls', '/not-read-without-target'], {output: message => output.push(message), errors: message => errors.push(message)}), 1);
  assert.equal(calls, 0); assert.equal(output.length, 0); assert.equal(errors.length, 1); assert.doesNotMatch(errors[0], /not-read/);
});

test('cutover smoke dry run against synthetic HTTP STUB checks one hop, title, missing paths and safe aggregate logs', async t => {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/old/') { res.writeHead(301, {Location: '/reports/new/'}); res.end(); }
    else if (req.url === '/chain/') { res.writeHead(302, {Location: '/old/'}); res.end(); }
    else if (req.url === '/open/') { res.writeHead(301, {Location: 'https://unapproved.example.test/'}); res.end(); }
    else if (req.url === '/gone/') { res.writeHead(410); res.end(); }
    else if (req.url === '/reports/new/') { res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<title>Synthetic &amp; safe report</title>'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const target = 'http://127.0.0.1:' + server.address().port;
  const checks = readRedirectChecks(JSON.stringify([{path: '/old/', expectedStatus: 301, expectedTitle: 'Synthetic & safe report'}, {path: '/chain/'}, {path: '/open/'}, {path: '/gone/', expectedStatus: 410}, {path: '/missing/'}]));
  let clock = 0; const waits = [];
  const summary = await checkRedirects({target, checks, now: () => clock, wait: async milliseconds => { waits.push(milliseconds); clock += milliseconds; }});
  assert.equal(summary.total, 5); assert.equal(summary.passed, 2); assert.equal(summary.failed, 3);
  assert.equal(summary.results[0].hops, 1); assert.equal(summary.results[0].titleMatches, true);
  assert.ok(waits.slice(1).every(value => value >= 500), 'each request, including redirect followups, is rate limited');
  assert.equal(paths.filter(path => path === '/reports/new/').length, 1, 'chain is never followed beyond one hop');
  assert.doesNotMatch(JSON.stringify(summary), /old|unapproved|Synthetic|127\.0\.0\.1/);

  const file = await tempFile(t, JSON.stringify([checks[0], checks[3]]));
  const child = spawn(process.execPath, ['tools/check-redirects.mjs', '--target', target, '--urls', file, '--quiet', '--rate', '10'], {cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0);
  assert.deepEqual(JSON.parse(stdout), {total: 2, passed: 2, failed: 0}); assert.equal(stderr, '');
});
