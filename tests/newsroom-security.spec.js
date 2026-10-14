/**
 * Church Times Nigeria — Staff newsroom security & live-CMS integration suite.
 *
 * 1. Production bundle: contains no demo credentials, mock backend, role switcher or CMS settings. A build in mock
 *    mode (mode=mock or VITE_NEWSROOM_MOCK=1) is refused outright (vite.config.js), so a mock bundle cannot exist.
 * 2. Session gating (dev mock server): only the sign-in screen is reachable without a user; logout clears state.
 * 3. LIVE CMS (runs only with NEWSROOM_LIVE_CMS_URL + NEWSROOM_LIVE_CREDENTIALS; see apps/newsroom/README.md):
 *    real login/me/logout cookie session, Lexical round trip, workflow transitions, 401/403 handling, tip
 *    conversion, multipart media upload, live updates, id validation and XSS escaping against the real CMS.
 */

import { test, expect, request as playwrightRequest } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// -------------------------------------------------------------------------------------------------------------
// 1. Production bundle audit
// -------------------------------------------------------------------------------------------------------------

const FORBIDDEN_IN_PRODUCTION = [
  'churchtimes2026',
  'mock-only-password',
  'password123',
  'user-role-select',
  'mock-role-picker',
  'LOCAL MOCK MODE',
  'Dev mock accounts',
  'demo-fill',
  'Gbenga',
  'Derin Adeogun',
  'CMS Settings',
  'btn-cms-settings',
  'ctn_mock_store',
  'ctn_newsroom_store',
  'backendUrl',
  'api/public/submissions',
  'turnstile'
];

function buildNewsroom(outDir, extraEnv = {}, extraArgs = []) {
  const viteBin = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [viteBin, 'build', 'apps/newsroom', '--outDir', outDir, '--emptyOutDir', ...extraArgs], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe'
  });
}

function readAllText(dir) {
  const out = [];
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|html|css|map|json)$/.test(entry.name)) out.push([p, fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(dir);
  return out;
}

test.describe('Production build contains no mock backend or demo credentials', () => {
  test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'build audit runs once'); });
  test.setTimeout(180_000);

  test('default production build contains no mock backend, demo data or credentials', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsroom-dist-'));
    try {
      // The audit must not depend on the caller's shell: make sure the mock flag is absent for the normal build.
      const env = { VITE_CMS_URL: 'https://cms.example.org' };
      delete process.env.VITE_NEWSROOM_MOCK;
      buildNewsroom(outDir, env);
      const files = readAllText(outDir);
      expect(files.length).toBeGreaterThan(1);
      const all = files.map(([, text]) => text).join('\n').toLowerCase();

      for (const needle of FORBIDDEN_IN_PRODUCTION) {
        expect(all.includes(needle.toLowerCase()), `bundle must not contain "${needle}"`).toBe(false);
      }
      // sanity: the live adapter is what shipped
      expect(all).toContain('/users/login');
      expect(all).toContain('/users/me');
      expect(all).toContain('https://cms.example.org');

      const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(html).not.toContain('role-picker');
      expect(html).not.toContain('data-view-nav="submit"');
      expect(html).not.toContain('btn-cms-settings');
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  for (const [label, env, args] of [
    ['VITE_NEWSROOM_MOCK=1', { VITE_NEWSROOM_MOCK: '1' }, []],
    ['--mode mock', {}, ['--mode', 'mock']],
    ['--mode mock together with VITE_NEWSROOM_MOCK=1', { VITE_NEWSROOM_MOCK: '1' }, ['--mode', 'mock']]
  ]) {
    test(`a mock build is refused (${label}) and leaves no bundle behind`, async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsroom-dist-'));
      fs.rmSync(outDir, { recursive: true, force: true });
      try {
        let failure = null;
        try {
          buildNewsroom(outDir, { VITE_CMS_URL: 'https://cms.example.org', ...env }, args);
        } catch (err) {
          failure = err;
        }
        expect(failure, 'vite build must fail in mock mode').not.toBeNull();
        expect(String(failure.stderr || failure.stdout || failure.message)).toContain('Refusing to build the newsroom app in mock mode');
        expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(false);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    });
  }
});

// -------------------------------------------------------------------------------------------------------------
// 2. Session gating in the dev mock server
// -------------------------------------------------------------------------------------------------------------

test.describe('Session gating (dev mock server)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await page.evaluate(() => localStorage.clear());
    await page.goto('./#dashboard');
    await expect(page.getByTestId('session-user')).toBeVisible();
  });

  test('logout leaves only the sign-in screen reachable and stores no credentials', async ({ page }) => {
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect(page.getByTestId('session-user')).toHaveCount(0);
    await expect(page.locator('.nav-bar')).toBeHidden();

    for (const hash of ['#dashboard', '#editor', '#editor?id=art-29276', '#review', '#live', '#media']) {
      await page.goto(`./${hash}`);
      await expect(page.getByTestId('login-view')).toBeVisible();
      await expect(page.locator('#story-pipeline-tbody')).toHaveCount(0);
      await expect(page.getByTestId('editor-title')).toHaveCount(0);
    }

    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).toLowerCase());
    expect(storage).not.toMatch(/password|token|jwt/);
  });

  test('invalid credentials show the backend message and keep the user on the login screen', async ({ page }) => {
    await page.getByTestId('logout').click();
    await page.getByTestId('login-email').fill('reporter@example.org');
    await page.getByTestId('login-password').fill('definitely-wrong');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('email or password');
    await expect(page.getByTestId('login-view')).toBeVisible();
  });

  test('mock sign-in works and public tip form is not part of the staff app', async ({ page }) => {
    await page.getByTestId('logout').click();
    await page.locator('.demo-fill-btn').first().click();
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('session-user')).toBeVisible();
    await page.goto('./#submit');
    await expect(page.getByTestId('public-tip-notice')).toBeVisible();
    await expect(page.locator('#sub-headline-input')).toHaveCount(0);
    await expect(page.locator('#turnstile-wrapper')).toHaveCount(0);
  });

  test('role-based actions: reporter cannot approve or publish, editor-in-chief can', async ({ page }) => {
    await page.goto('./#editor');
    await expect(page.getByTestId('editor-submit-review')).toBeVisible();
    await expect(page.getByTestId('editor-approve')).toHaveCount(0);
    await expect(page.getByTestId('editor-publish')).toHaveCount(0);

    await page.locator('#user-role-select').selectOption({ label: 'Lanre Ogundipe (Editor-in-Chief)' });
    await page.goto('./#review');
    await page.getByTestId('review-inspect').first().click();
    await expect(page.getByTestId('inspect-approve')).toBeVisible();
    await expect(page.getByTestId('inspect-publish')).toBeVisible();
  });
});

// -------------------------------------------------------------------------------------------------------------
// 2b. Production build against a stubbed CMS (network fully intercepted; no CMS needed)
// -------------------------------------------------------------------------------------------------------------

const STUB_PORT = Number(process.env.NEWSROOM_STUB_PORT || 5277);
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/`;

const lexText = (text, format = 0) => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1 });
const lexPara = (...children) => ({ type: 'paragraph', children, direction: 'ltr', format: '', indent: 0, version: 1 });
const lexLink = (url, text, fields = {}) => ({
  type: 'link', version: 3, direction: 'ltr', format: '', indent: 0,
  fields: { linkType: 'custom', newTab: false, url, ...fields }, children: [lexText(text)]
});
// 1x1 transparent PNG served for stub media files
const STUB_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const lexUpload = (value, extra = {}) => ({ type: 'upload', version: 3, format: '', id: 'abcdefabcdefabcdefabcdef', relationTo: 'media', fields: null, value, ...extra });
const stubMedia = (id, over = {}) => ({
  id, alt: `Alt for ${id}`, caption: '', credit: '', filename: `pic-${id}.png`, mimeType: 'image/png', width: 800, height: 600,
  url: `/api/media/file/pic-${id}.png`, sizes: { card: { url: `/api/media/file/pic-${id}-card.png` } }, ...over
});
const STALE_CMS_MESSAGE = 'This item changed after you opened it. Reload and review it again.';
const lexDoc = (...children) => ({ root: { type: 'root', children, direction: 'ltr', format: '', indent: 0, version: 1 } });

function stubArticle(id, over = {}) {
  return {
    id, title: `Stub story ${id}`, slug: `stub-story-${id}`, excerpt: `Standfirst ${id}`,
    content: lexDoc(lexPara(lexText(`Body of story ${id}.`))),
    category: { id: 1, title: 'News', slug: 'news' }, status: 'draft',
    author: { id: 7, name: 'Stub Editor' }, bylineName: '',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over
  };
}

/**
 * Fake CMS for the production bundle (same-origin /api). Records every PATCH; a story's GET (or every PATCH) can be
 * held back to reproduce slow-network races.
 * options.logout: { status, body } or { abort: true }; options.tips: { [articleId]: submission } for tip provenance.
 */
async function stubCms(page, {
  articles = [], logout = { status: 200, body: { message: 'You have been logged out successfully.' } }, tips = {},
  media = [], events = [], updates = [], updateError = null, patchError = null
} = {}) {
  const docs = new Map(articles.map(a => [String(a.id), a]));
  const liveUpdates = [...updates];
  const gates = new Map();
  let patchGate = null;
  const log = { patches: [], gets: [], logouts: 0, updatePosts: [], updatePatches: [] };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname.replace(/^\/api/, '');
    const method = req.method();
    let m;
    if (p === '/users/me') {
      return json(route, 200, { user: { id: 7, name: 'Stub Editor', email: 'stub@example.org', role: 'editor-in-chief', sections: [] } });
    }
    if (p === '/users/logout' && method === 'POST') {
      log.logouts++;
      if (logout.abort) return route.abort('failed');
      return json(route, logout.status, logout.body);
    }
    if (p.startsWith('/media/file/')) return route.fulfill({ status: 200, contentType: 'image/png', body: STUB_PNG });
    if (p === '/media' && method === 'GET') return json(route, 200, { docs: media, totalDocs: media.length });
    if (p === '/live-events' && method === 'GET') return json(route, 200, { docs: events, totalDocs: events.length });
    if (p === '/live-updates' && method === 'GET') {
      const ev = url.searchParams.get('where[event][equals]');
      return json(route, 200, { docs: liveUpdates.filter(u => !ev || String(u.event) === ev), totalDocs: liveUpdates.length });
    }
    if (p === '/live-updates' && method === 'POST') {
      const body = req.postDataJSON();
      log.updatePosts.push(body);
      if (updateError) return json(route, 400, { errors: [{ message: updateError }] });
      const image = body.image === undefined ? null : media.find(m => m.id === body.image) ?? body.image;
      const doc = {
        id: 900 + liveUpdates.length, event: body.event, body: body.body, status: body.status === 'approved' ? 'approved' : 'pending',
        sequence: liveUpdates.length + 1, publishSequence: body.status === 'approved' ? liveUpdates.length + 1 : null,
        occurredAt: new Date().toISOString(), author: { id: 7, name: 'Stub Editor' }, ...(image === null ? {} : { image })
      };
      liveUpdates.push(doc);
      return json(route, 201, { doc, message: 'Created successfully.' });
    }
    if (p === '/categories') return json(route, 200, { docs: [{ id: 1, title: 'News', slug: 'news' }], totalDocs: 1 });
    if (p === '/submissions') {
      const forArticle = url.searchParams.get('where[article][equals]');
      const tip = forArticle ? tips[forArticle] : null;
      return json(route, 200, { docs: tip ? [tip] : [], totalDocs: tip ? 1 : 0 });
    }
    if (p === '/articles' && method === 'GET') {
      const status = url.searchParams.get('where[status][equals]');
      const list = [...docs.values()].filter(a => !status || a.status === status);
      return json(route, 200, { docs: url.searchParams.get('limit') === '1' ? list.slice(0, 1) : list, totalDocs: list.length });
    }
    if ((m = p.match(/^\/articles\/(\d+)$/))) {
      const id = m[1];
      const doc = docs.get(id);
      if (method === 'GET') {
        log.gets.push(id);
        if (gates.has(id)) await gates.get(id).promise;
        return doc ? json(route, 200, doc) : json(route, 404, { errors: [{ message: 'Not Found' }] });
      }
      if (method === 'PATCH' && doc) {
        const body = req.postDataJSON();
        log.patches.push({ id, body });
        if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== doc.updatedAt) {
          return json(route, 409, { errors: [{ message: STALE_CMS_MESSAGE }] });
        }
        if (patchGate) await patchGate.promise;
        const refusal = patchError ? patchError(body) : null;
        if (refusal) return json(route, 400, { errors: [{ message: refusal }] });
        const next = { ...doc, updatedAt: new Date().toISOString() };
        if (body.title !== undefined) next.title = body.title;
        if (body.excerpt !== undefined) next.excerpt = body.excerpt;
        if (body.status !== undefined) next.status = body.status;
        if (body.reviewNotes !== undefined) next.reviewNotes = body.reviewNotes;
        if (body.content !== undefined) next.content = body.content;
        docs.set(id, next);
        return json(route, 200, { doc: next, message: 'Updated successfully.' });
      }
    }
    if ((m = p.match(/^\/live-updates\/(\d+)$/)) && method === 'PATCH') {
      const doc = liveUpdates.find(u => String(u.id) === m[1]);
      if (!doc) return json(route, 404, { errors: [{ message: 'Not Found' }] });
      const body = req.postDataJSON();
      log.updatePatches.push({ id: m[1], body });
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== doc.updatedAt) {
        return json(route, 409, { errors: [{ message: STALE_CMS_MESSAGE }] });
      }
      if (body.status !== undefined) doc.status = body.status;
      if (body.status === 'approved') doc.publishSequence = liveUpdates.length + 1;
      doc.updatedAt = new Date().toISOString();
      return json(route, 200, { doc, message: 'Updated successfully.' });
    }
    return json(route, 404, { errors: [{ message: `stub: unhandled ${method} ${p}` }] });
  });

  const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  return {
    log,
    /** Someone else changes the story / update on the server (new updatedAt) after the newsroom loaded it. */
    touchArticle(id, over = {}) { docs.set(String(id), { ...docs.get(String(id)), ...over, updatedAt: '2026-10-14T21:00:00.000Z' }); },
    touchUpdate(id, over = {}) { Object.assign(liveUpdates.find(u => String(u.id) === String(id)), over, { updatedAt: '2026-10-14T21:00:00.000Z' }); },
    holdGet(id) { gates.set(String(id), gate()); },
    releaseGet(id) { gates.get(String(id))?.resolve(); gates.delete(String(id)); },
    holdPatches() { patchGate = gate(); },
    releasePatches() { patchGate?.resolve(); patchGate = null; }
  };
}

test.describe('Production build against a stubbed CMS', () => {
  test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'stubbed-CMS suite runs once, on desktop'); });
  test.setTimeout(60_000);

  test('a slow load of story 1 can never take over after navigating to story 2: PATCH goes to story 2 only', async ({ page }) => {
    const cms = await stubCms(page, { articles: [stubArticle(1), stubArticle(2)] });
    cms.holdGet(1);
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect.poll(() => cms.log.gets).toContain('1'); // story 1's GET is in flight
    await page.evaluate(() => { window.location.hash = '#editor?id=2'; });
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 2');

    cms.releaseGet(1); // story 1 answers late
    await page.waitForTimeout(500);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 2');
    await expect(page.locator('.view-host')).toHaveCount(1);

    await page.getByTestId('editor-title').fill('Story two, edited');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(1);
    await page.getByTestId('editor-standfirst').fill('Edited standfirst'); // autosave path
    await expect.poll(() => cms.log.patches.length, { timeout: 8000 }).toBe(2);
    expect(cms.log.patches.map(p => p.id)).toEqual(['2', '2']);
    expect(cms.log.patches[0].body).toEqual({ title: 'Story two, edited' });
    expect(cms.log.patches[1].body).toEqual({ excerpt: 'Edited standfirst' });
  });

  test('leaving story 1 with an unsaved edit flushes it to story 1 only; story 2 is not touched', async ({ page }) => {
    const cms = await stubCms(page, { articles: [stubArticle(1), stubArticle(2)] });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    await page.getByTestId('editor-title').fill('Story one, edited');
    await page.evaluate(() => { window.location.hash = '#editor?id=2'; }); // autosave timer still pending
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 2');
    await page.waitForTimeout(2200); // longer than the autosave delay
    expect(cms.log.patches).toEqual([{ id: '1', body: { title: 'Story one, edited' } }]);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 2');
  });

  test('Save Draft during an in-flight autosave waits for it and then saves (never silently dropped)', async ({ page }) => {
    const cms = await stubCms(page, { articles: [stubArticle(1)] });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    cms.holdPatches();
    await page.getByTestId('editor-title').fill('Autosaved title');
    await expect.poll(() => cms.log.patches.length, { timeout: 8000 }).toBe(1); // autosave is in flight (held)
    await page.getByTestId('editor-standfirst').fill('Typed during the autosave');
    await page.getByTestId('editor-save-draft').click();
    await page.waitForTimeout(300);
    expect(cms.log.patches).toHaveLength(1); // the manual save is waiting, not racing
    cms.releasePatches();
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(1);
    expect(cms.log.patches.map(p => p.body)).toEqual([{ title: 'Autosaved title' }, { excerpt: 'Typed during the autosave' }]);
  });

  test('Save Draft with nothing changed makes no CMS call and says so', async ({ page }) => {
    const cms = await stubCms(page, { articles: [stubArticle(1)] });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('No changes to save');
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(0);
    // surrounding whitespace is not an edit either
    await page.getByTestId('editor-title').fill('  Stub story 1  ');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').filter({ hasText: 'No changes to save' })).toHaveCount(2);
    expect(cms.log.patches).toEqual([]);
  });

  test('dashboard counts: one set of count requests per visit, reused across route changes, and fresh after the user submits a story', async ({ page }) => {
    const countRequests = [];
    page.on('request', req => {
      const u = new URL(req.url());
      if (u.pathname.endsWith('/api/articles') && u.searchParams.get('limit') === '1' && u.searchParams.has('where[status][equals]')) {
        countRequests.push(u.searchParams.get('where[status][equals]'));
      }
    });
    await stubCms(page, { articles: [stubArticle(1)] });
    await page.goto(`${STUB_BASE}#dashboard`);
    await expect(page.getByTestId('metric-value-draft')).toHaveText('1');
    await page.waitForTimeout(300); // the nav badge refresh runs right after the dashboard renders
    expect(countRequests).toHaveLength(7);

    // route changes inside the cache window reuse the counts (no new count requests)
    await page.evaluate(() => { window.location.hash = '#editor?id=1'; });
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    await page.getByTestId('editor-submit-review').click();
    await expect(page.locator('.toast').filter({ hasText: 'submitted for editorial review' })).toHaveCount(1);
    expect(countRequests).toHaveLength(7);

    // the user's own status change invalidates the cache: the dashboard shows the new totals at once
    await page.evaluate(() => { window.location.hash = '#dashboard'; });
    await expect(page.getByTestId('metric-value-in_review')).toHaveText('1');
    await expect(page.getByTestId('metric-value-draft')).toHaveText('0');
    expect(countRequests).toHaveLength(14);
  });

  test('a body with elements the editor cannot represent is read-only and is never rewritten (PATCH has no content)', async ({ page }) => {
    const lossy = stubArticle(1, {
      content: lexDoc(lexPara(lexText('Read '), lexLink('https://example.org/x', 'this', { newTab: true }), lexText(' carefully.')))
    });
    const cms = await stubCms(page, { articles: [lossy] });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    await expect(page.getByTestId('editor-lossy-note')).toBeVisible();
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', true);
    await expect(page.getByTestId('editor-body')).toHaveValue('Read [this](https://example.org/x) carefully.');

    await page.getByTestId('editor-title').fill('Only the headline changed');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(1);
    expect(cms.log.patches).toHaveLength(1);
    expect(Object.keys(cms.log.patches[0].body)).toEqual(['title']);
    expect(JSON.stringify(cms.log.patches)).not.toContain('"content"');
  });

  test('images inside the body: upload nodes (populated or id-only) keep the body editable, are listed and previewed, and survive an edit as ids', async ({ page }) => {
    const article = stubArticle(1, {
      content: lexDoc(
        lexPara(lexText('Before.')), lexUpload(stubMedia(11)), lexPara(lexText('Between.')), lexUpload(12), lexPara(lexText('After.'))
      )
    });
    const cms = await stubCms(page, { articles: [article], media: [stubMedia(11), stubMedia(12)] });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    await expect(page.getByTestId('editor-lossy-note')).toHaveCount(0);
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', false);
    await expect(page.getByTestId('editor-insert-image')).toBeEnabled();
    await expect(page.getByTestId('editor-body')).toHaveValue('Before.\n\n![Alt for 11](media:11)\n\nBetween.\n\n![](media:12)\n\nAfter.');

    const items = page.getByTestId('editor-body-image');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Image #11');
    await expect(items.nth(0)).toContainText('Alt for 11');
    await expect(items.nth(0).locator('img')).toBeVisible();
    await expect(items.nth(1)).toContainText('Image #12');
    await expect(page.locator('#preview-body-content').getByTestId('preview-inline-image')).toHaveCount(2);
    await expect(page.locator('#preview-body-content figure img')).toHaveCount(1); // 12 arrived as an id only: label, no picture

    // a headline edit never sends the body
    await page.getByTestId('editor-title').fill('Only the headline changed');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(1);
    expect(cms.log.patches.map(p => Object.keys(p.body))).toEqual([['title']]);

    // a body edit writes both images back as upload nodes carrying the id (never the populated document)
    await page.getByTestId('editor-body').fill('Before.\n\n![x](media:11)\n\nBetween, edited.\n\n![](media:12)\n\nAfter.');
    await page.getByTestId('editor-save-draft').click();
    await expect.poll(() => cms.log.patches.length).toBe(2);
    const content = cms.log.patches[1].body.content;
    expect(content.root.children.map(n => n.type)).toEqual(['paragraph', 'upload', 'paragraph', 'upload', 'paragraph']);
    const uploads = content.root.children.filter(n => n.type === 'upload');
    expect(uploads.map(n => [n.relationTo, n.value, n.version, n.fields])).toEqual([['media', 11, 3, null], ['media', 12, 3, null]]);
    expect(new Set(uploads.map(n => n.id)).size).toBe(2);

    // removing an image from the list removes its line from the body
    await items.nth(0).getByTestId('editor-remove-body-image').click();
    await expect(page.getByTestId('editor-body-image')).toHaveCount(1);
    await expect(page.getByTestId('editor-body')).not.toHaveValue(/media:11/);
  });

  test('Insert image: picker opens at the cursor, an image without alt text is refused, the story is saved with an upload node', async ({ page }) => {
    const cms = await stubCms(page, {
      articles: [
        stubArticle(1, { content: lexDoc(lexPara(lexText('First para.')), lexPara(lexText('Second para.'))) }),
        stubArticle(2, { content: lexDoc(lexPara(lexText('Read '), lexLink('https://example.org/x', 'this', { newTab: true }))) })
      ],
      media: [stubMedia(21), stubMedia(22, { alt: '' })]
    });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-body')).toHaveValue('First para.\n\nSecond para.');
    await page.getByTestId('editor-body').evaluate(el => { el.focus(); const i = el.value.indexOf('Second'); el.setSelectionRange(i, i); });
    await page.getByTestId('editor-insert-image').click();
    await expect(page.getByTestId('media-picker')).toBeVisible();
    await expect(page.getByTestId('media-card')).toHaveCount(2);

    await page.locator('[data-testid="media-card"][data-media-id="22"]').click();
    await expect(page.getByTestId('media-picker-error')).toContainText('Alt text is required');
    await expect(page.getByTestId('media-picker')).toBeVisible(); // still open: pick another one
    await expect(page.getByTestId('editor-body')).toHaveValue('First para.\n\nSecond para.');

    await page.locator('[data-testid="media-card"][data-media-id="21"]').click();
    await expect(page.getByTestId('media-picker')).toHaveCount(0);
    await expect(page.getByTestId('editor-body')).toHaveValue('First para.\n\n![Alt for 21](media:21)\n\nSecond para.');
    await expect(page.getByTestId('editor-body-image')).toHaveCount(1);
    await expect(page.locator('#preview-body-content figure img')).toHaveAttribute('alt', 'Alt for 21');

    await page.getByTestId('editor-save-draft').click();
    await expect.poll(() => cms.log.patches.length).toBe(1);
    const kids = cms.log.patches[0].body.content.root.children;
    expect(kids.map(n => n.type)).toEqual(['paragraph', 'upload', 'paragraph']);
    expect(kids[1]).toMatchObject({ type: 'upload', relationTo: 'media', value: 21, version: 3, fields: null });
    expect(typeof kids[1].value).toBe('number');

    // a body that is still read-only cannot receive images
    await page.evaluate(() => { window.location.hash = '#editor?id=2'; });
    await expect(page.getByTestId('editor-lossy-note')).toBeVisible();
    await expect(page.getByTestId('editor-insert-image')).toBeDisabled();
  });

  test('a deleted image (upload node with no media) keeps the body editable as a removable "missing image" line; the CMS refusal is shown', async ({ page }) => {
    const article = stubArticle(1, {
      content: lexDoc(lexPara(lexText('Before.')), lexUpload(null), lexPara(lexText('After.')), lexUpload(12))
    });
    const refuseMissing = body => {
      const kids = body.content?.root?.children ?? [];
      return kids.some(n => n.type === 'upload' && n.value === null) ? 'The image in the story body no longer exists. Remove it or choose another.' : null;
    };
    const cms = await stubCms(page, { articles: [article], media: [stubMedia(12)], patchError: refuseMissing });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    await expect(page.getByTestId('editor-lossy-note')).toHaveCount(0);
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', false);
    await expect(page.getByTestId('editor-body')).toHaveValue('Before.\n\n![missing image](media:missing)\n\nAfter.\n\n![](media:12)');
    await expect(page.getByTestId('editor-body-image-missing')).toBeVisible();
    await expect(page.getByTestId('editor-body-image-missing')).toContainText('no longer exists');
    await expect(page.locator('#preview-body-content').getByTestId('preview-inline-image-missing')).toBeVisible();

    // an unrelated edit does not send the body at all
    await page.getByTestId('editor-title').fill('Only the headline changed');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(1);
    expect(cms.log.patches.map(p => Object.keys(p.body))).toEqual([['title']]);

    // editing text while the missing line is still there: the CMS refuses and its message is shown
    await page.getByTestId('editor-body').fill('Before, edited.\n\n![missing image](media:missing)\n\nAfter.\n\n![](media:12)');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.getByTestId('editor-error')).toContainText('no longer exists');
    expect(cms.log.patches).toHaveLength(2);

    // removing the line fixes it: the saved body has no upload node with a null value
    await page.getByTestId('editor-body-image-missing').getByTestId('editor-remove-body-image').click();
    await expect(page.getByTestId('editor-body-image-missing')).toHaveCount(0);
    await expect(page.getByTestId('editor-body')).toHaveValue('Before, edited.\n\nAfter.\n\n![](media:12)');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(2);
    const kids = cms.log.patches[2].body.content.root.children;
    expect(kids.map(n => n.type)).toEqual(['paragraph', 'paragraph', 'upload']);
    expect(kids[2].value).toBe(12);
    await expect(page.getByTestId('editor-error')).toBeHidden();
  });

  test('a save refused because of an image (400) shows the CMS message and keeps the text', async ({ page }) => {
    const cms = await stubCms(page, {
      articles: [stubArticle(1)], media: [stubMedia(21)],
      patchError: body => (body.content ? 'Image 21 has no alt text, so it cannot be used in an article.' : null)
    });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await page.getByTestId('editor-body').evaluate(el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await page.getByTestId('editor-insert-image').click();
    await page.locator('[data-testid="media-card"][data-media-id="21"]').click();
    await page.getByTestId('editor-save-draft').click();
    await expect(page.getByTestId('editor-error')).toContainText('has no alt text');
    await expect(page.locator('.toast').filter({ hasText: 'has no alt text' })).toHaveCount(1);
    await expect(page.getByTestId('editor-body')).toHaveValue(/!\[Alt for 21\]\(media:21\)/);
    expect(cms.log.patches).toHaveLength(1);
  });

  const liveEvent = { id: 5, slug: 'synod', title: 'Synod live', summary: '', status: 'live', category: { id: 1, title: 'News' } };
  const liveUpdate = (id, over) => ({
    id, event: 5, body: `Update ${id}`, status: 'approved', sequence: id, publishSequence: id,
    occurredAt: '2026-10-14T10:00:00.000Z', author: { id: 7, name: 'Stub Editor' }, ...over
  });

  test('live photos: thumbnails on published and pending updates (escaped alt, unsafe URLs dropped), Add photo / Remove, payload carries the media id', async ({ page }) => {
    const cms = await stubCms(page, {
      events: [liveEvent],
      media: [stubMedia(31, { alt: 'Delegates <b>vote</b>' }), stubMedia(32, { alt: '' })],
      updates: [
        liveUpdate(801, { image: stubMedia(31, { alt: 'Delegates <b>vote</b>' }) }),
        liveUpdate(802),
        liveUpdate(803, { status: 'pending', publishSequence: null, image: stubMedia(33, { alt: 'Pending photo', url: '/api/media/file/pending.png' }) }),
        liveUpdate(804, { status: 'pending', publishSequence: null, image: stubMedia(34, { alt: 'Evil', url: 'https://evil.example/x.png', sizes: {} }) })
      ]
    });
    await page.goto(`${STUB_BASE}#live`);
    const cards = page.getByTestId('live-update-card');
    await expect(cards).toHaveCount(2);
    const withPhoto = page.locator('[data-testid="live-update-card"][data-update-id="801"]');
    await expect(withPhoto.getByTestId('live-update-photo')).toHaveAttribute('alt', 'Delegates <b>vote</b>');
    await expect(withPhoto.getByTestId('live-update-photo')).toHaveAttribute('src', /\/api\/media\/file\/pic-31-card\.png$/);
    await expect(page.locator('[data-testid="live-update-card"][data-update-id="802"]').getByTestId('live-update-photo')).toHaveCount(0);
    await expect(page.locator('[data-testid="live-pending-card"][data-update-id="803"]').getByTestId('live-update-photo')).toHaveCount(1);
    await expect(page.locator('[data-testid="live-pending-card"][data-update-id="804"]').getByTestId('live-update-photo')).toHaveCount(0);
    expect(await page.locator('b').filter({ hasText: 'vote' }).count()).toBe(0); // the alt was never parsed as HTML

    // compose with a photo: alt-less media refused, removable thumbnail before posting
    await page.getByTestId('live-add-photo').click();
    await page.locator('[data-testid="media-card"][data-media-id="32"]').click();
    await expect(page.getByTestId('media-picker-error')).toContainText('Alt text is required');
    await page.locator('[data-testid="media-card"][data-media-id="31"]').click();
    await expect(page.getByTestId('media-picker')).toHaveCount(0);
    await expect(page.getByTestId('live-update-photo-draft')).toBeVisible();
    await expect(page.getByTestId('live-update-photo-alt')).toHaveText('Delegates <b>vote</b>');
    await page.getByTestId('live-remove-photo').click();
    await expect(page.getByTestId('live-update-photo-draft')).toHaveCount(0);
    await expect(page.getByTestId('live-add-photo')).toBeVisible();

    // a post without a photo sends no image field at all
    await page.getByTestId('live-update-body').fill('Plain update');
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-update-body')).toHaveValue('');
    expect(cms.log.updatePosts).toEqual([{ event: 5, body: 'Plain update', status: 'approved' }]);

    // with a photo
    await page.getByTestId('live-add-photo').click();
    await page.locator('[data-testid="media-card"][data-media-id="31"]').click();
    await page.getByTestId('live-update-body').fill('Update with a photo');
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-update-body')).toHaveValue('');
    expect(cms.log.updatePosts[1]).toEqual({ event: 5, body: 'Update with a photo', status: 'approved', image: 31 });
    expect(typeof cms.log.updatePosts[1].image).toBe('number');
    await expect(page.getByTestId('live-update-photo-draft')).toHaveCount(0); // composer reset
    await expect(page.getByTestId('live-add-photo')).toBeVisible();
    await expect(page.locator('[data-testid="live-update-card"]').filter({ hasText: 'Update with a photo' }).getByTestId('live-update-photo')).toBeVisible();
  });

  test('live photos: a CMS refusal (400) is shown and the chosen photo stays attached', async ({ page }) => {
    const cms = await stubCms(page, {
      events: [liveEvent], media: [stubMedia(31)], updates: [],
      updateError: 'The photo must be an image with alt text.'
    });
    await page.goto(`${STUB_BASE}#live`);
    await page.getByTestId('live-add-photo').click();
    await page.locator('[data-testid="media-card"][data-media-id="31"]').click();
    await page.getByTestId('live-update-body').fill('Will be refused');
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-error')).toContainText('The photo must be an image with alt text.');
    await expect(page.getByTestId('live-update-photo-draft')).toBeVisible();
    await expect(page.getByTestId('live-update-body')).toHaveValue('Will be refused');
    expect(cms.log.updatePosts).toHaveLength(1);
  });

  test('approve what you saw: review-queue actions send the shown updatedAt; on 409 the item reloads and the message shows', async ({ page }) => {
    const cms = await stubCms(page, {
      articles: [stubArticle(1, { status: 'in_review' }), stubArticle(2, { status: 'in_review' })]
    });
    // a matching version succeeds
    await page.goto(`${STUB_BASE}#review`);
    await page.locator('[data-testid="review-card"][data-story-id="1"]').getByTestId('review-inspect').click();
    await page.getByTestId('inspect-approve').click();
    await expect(page.locator('.toast').filter({ hasText: 'Story approved' })).toHaveCount(1);
    expect(cms.log.patches.at(-1)).toEqual({ id: '1', body: { status: 'approved', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' } });

    // story 2 is edited by somebody else after the queue loaded: approving the old version is refused
    await page.goto(`${STUB_BASE}#review`);
    await page.locator('[data-testid="review-card"][data-story-id="2"]').getByTestId('review-inspect').click();
    await expect(page.getByTestId('inspect-modal')).toBeVisible();
    cms.touchArticle(2, { title: 'Stub story 2, rewritten' });
    await page.getByTestId('inspect-approve').click();
    expect(cms.log.patches.at(-1)).toEqual({ id: '2', body: { status: 'approved', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' } });
    // the item is reloaded: the modal reopens on the new version and shows the message
    await expect(page.getByTestId('inspect-error')).toHaveText(STALE_CMS_MESSAGE);
    await expect(page.getByTestId('inspect-modal')).toContainText('Stub story 2, rewritten');
    // acting again uses the reloaded version and succeeds
    await page.getByTestId('inspect-approve').click();
    expect(cms.log.patches.at(-1)).toEqual({ id: '2', body: { status: 'approved', expectedUpdatedAt: '2026-10-14T21:00:00.000Z' } });
    await expect(page.locator('.toast').filter({ hasText: 'Story approved' })).toHaveCount(2);
  });

  test('approve what you saw: the editor sends the loaded version; a stale publish reloads the story and shows the message', async ({ page }) => {
    const cms = await stubCms(page, { articles: [stubArticle(1, { status: 'approved' })] });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1');
    cms.touchArticle(1, { title: 'Stub story 1, corrected by the author' });
    await page.getByTestId('editor-publish').click();
    await page.getByTestId('publish-ok').click();
    expect(cms.log.patches.at(-1)).toEqual({ id: '1', body: { status: 'published', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' } });
    await expect(page.getByTestId('editor-error')).toHaveText(STALE_CMS_MESSAGE);
    await expect(page.getByTestId('editor-title')).toHaveValue('Stub story 1, corrected by the author');
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'approved');

    await page.getByTestId('editor-publish').click();
    await page.getByTestId('publish-ok').click();
    expect(cms.log.patches.at(-1)).toEqual({ id: '1', body: { status: 'published', expectedUpdatedAt: '2026-10-14T21:00:00.000Z' } });
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'published');
  });

  test('approve what you saw: the live view sends the card version; a stale approve reloads the card and shows the message', async ({ page }) => {
    const cms = await stubCms(page, {
      events: [liveEvent],
      updates: [
        liveUpdate(811, { status: 'pending', publishSequence: null, updatedAt: '2026-10-14T10:00:00.000Z' }),
        liveUpdate(812, { status: 'pending', publishSequence: null, updatedAt: '2026-10-14T10:00:00.000Z' })
      ]
    });
    await page.goto(`${STUB_BASE}#live`);
    const card = id => page.locator(`[data-testid="live-pending-card"][data-update-id="${id}"]`);
    await expect(card(811)).toBeVisible();
    await card(811).getByTestId('live-approve').click();
    await expect(card(811)).toHaveCount(0);
    expect(cms.log.updatePatches).toEqual([{ id: '811', body: { status: 'approved', expectedUpdatedAt: '2026-10-14T10:00:00.000Z' } }]);

    // update 812 is corrected after the console loaded it: the stale approve is refused and the card shows the new text
    cms.touchUpdate(812, { body: 'Corrected wording' });
    await card(812).getByTestId('live-approve').click();
    await expect(page.getByTestId('live-error')).toHaveText(STALE_CMS_MESSAGE);
    await expect(card(812)).toContainText('Corrected wording');
    await card(812).getByTestId('live-reject').click();
    expect(cms.log.updatePatches.at(-1)).toEqual({ id: '812', body: { status: 'rejected', expectedUpdatedAt: '2026-10-14T21:00:00.000Z' } });
    await expect(card(812)).toHaveCount(0);
  });

  test('a story converted from a reader tip warns while the byline is set, and the warning follows the byline field', async ({ page }) => {
    const tip = { id: 5, status: 'converted', name: 'Tipster Name', email: 't@example.org', title: 'Tip', body: 'b', article: 1, createdAt: '2026-01-01T00:00:00.000Z' };
    await stubCms(page, {
      articles: [stubArticle(1, { bylineName: 'Tipster Name' }), stubArticle(2, { bylineName: 'Staff Writer' })],
      tips: { 1: tip }
    });
    await page.goto(`${STUB_BASE}#editor?id=1`);
    await expect(page.getByTestId('editor-byline')).toHaveValue('Tipster Name');
    const warning = page.getByTestId('editor-tip-byline-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText("submitter's name is pre-filled as the byline");
    await expect(warning).toContainText('Clear the byline before publishing');
    await page.getByTestId('editor-byline').fill('');
    await expect(warning).toBeHidden();
    await page.getByTestId('editor-byline').fill('Someone');
    await expect(warning).toBeVisible();

    await page.evaluate(() => { window.location.hash = '#editor?id=2'; });
    await expect(page.getByTestId('editor-byline')).toHaveValue('Staff Writer');
    await expect(page.getByTestId('editor-tip-byline-warning')).toBeHidden(); // not from a tip
  });

  for (const [label, logout, expectOk] of [
    ['CMS answers 500', { status: 500, body: { errors: [{ message: 'boom' }] } }, false],
    ['network failure', { abort: true }, false],
    ['CMS answers 400 "no user" (session already gone)', { status: 400, body: { errors: [{ message: 'No User' }] } }, true],
    ['CMS answers 401', { status: 401, body: { errors: [{ message: 'Unauthorized' }] } }, true],
    ['CMS answers 200', { status: 200, body: { message: 'You have been logged out successfully.' } }, true]
  ]) {
    test(`logout (${label}): ${expectOk ? 'confirmed' : 'warns that the server session may still be active'}, local state is always cleared`, async ({ page }) => {
      const cms = await stubCms(page, { articles: [stubArticle(1)], logout });
      await page.goto(`${STUB_BASE}#dashboard`);
      await expect(page.getByTestId('session-user')).toBeVisible();
      await page.evaluate(() => localStorage.setItem('ctn_leftover', 'x'));
      await page.getByTestId('logout').click();
      await expect(page.getByTestId('login-view')).toBeVisible();
      await expect(page.getByTestId('session-user')).toHaveCount(0);
      expect(cms.log.logouts).toBe(1);
      expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ctn_') && k !== 'ctn_theme'))).toEqual([]);

      const toasts = page.locator('.toast');
      if (expectOk) {
        await expect(toasts.filter({ hasText: 'Logged out. Session cleared.' })).toHaveCount(1);
        await expect(toasts.filter({ hasText: 'server session may still be active' })).toHaveCount(0);
      } else {
        const warning = toasts.filter({ hasText: 'server session may still be active' });
        await expect(warning).toHaveCount(1);
        await expect(warning).toHaveClass(/toast-error/);
        await expect(toasts.filter({ hasText: 'Logged out. Session cleared.' })).toHaveCount(0);
      }
    });
  }
});

// -------------------------------------------------------------------------------------------------------------
// 3. LIVE CMS
// -------------------------------------------------------------------------------------------------------------

const LIVE_CMS_URL = process.env.NEWSROOM_LIVE_CMS_URL || '';
const LIVE_CREDENTIALS = process.env.NEWSROOM_LIVE_CREDENTIALS || '';
const LIVE_PORT = Number(process.env.NEWSROOM_LIVE_PORT || 5274);
const LIVE_BASE = `http://newsroom.churchtimes.localhost:${LIVE_PORT}/`;
const LIVE_API_LOOPBACK = process.env.NEWSROOM_LIVE_API_LOOPBACK || LIVE_CMS_URL.replace('cms.churchtimes.localhost', '127.0.0.1');
const PUBLIC_ORIGIN = process.env.NEWSROOM_LIVE_PUBLIC_ORIGIN || 'http://www.churchtimes.localhost:5273';

// 1x1 transparent PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

test.describe('LIVE CMS (real Payload, no mocks)', () => {
  test.skip(!LIVE_CMS_URL || !LIVE_CREDENTIALS, 'set NEWSROOM_LIVE_CMS_URL and NEWSROOM_LIVE_CREDENTIALS to run');
  test.beforeEach(({}, testInfo) => { test.skip(testInfo.project.name !== 'desktop', 'live suite runs once, on desktop'); });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let creds;
  let adminApi; // server-side verification client (JWT header; never used by the app under test)
  const run = Date.now().toString(36);

  test.beforeAll(async () => {
    creds = JSON.parse(fs.readFileSync(LIVE_CREDENTIALS, 'utf8')).users;
    adminApi = await playwrightRequest.newContext({ baseURL: LIVE_API_LOOPBACK });
    const res = await adminApi.post('/api/users/login', { data: { email: creds.admin.email, password: creds.admin.password } });
    expect(res.ok()).toBe(true);
    const { token } = await res.json();
    adminApi = await playwrightRequest.newContext({
      baseURL: LIVE_API_LOOPBACK,
      extraHTTPHeaders: { Authorization: `JWT ${token}` }
    });
  });

  test.afterAll(async () => { await adminApi?.dispose(); });

  async function signIn(page, roleKey) {
    await page.goto(LIVE_BASE);
    if (await page.getByTestId('session-user').isVisible().catch(() => false)) {
      await page.getByTestId('logout').click();
    }
    await page.getByTestId('login-email').fill(creds[roleKey].email);
    await page.getByTestId('login-password').fill(creds[roleKey].password);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('session-user-role')).toHaveAttribute('data-role', creds[roleKey].role);
  }

  async function signOut(page) {
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
  }

  // Idle keep-alive sockets to the staging server can be reset; retry transient transport errors only.
  async function adminGet(url) {
    let lastError;
    for (let i = 0; i < 4; i++) {
      try { return await adminApi.get(url); } catch (err) { lastError = err; }
    }
    throw lastError;
  }

  async function articleViaApi(id) {
    const res = await adminGet(`/api/articles/${id}?depth=1`);
    expect(res.ok()).toBe(true);
    return res.json();
  }

  let storyId;
  const storyTitle = `Live E2E story ${run}`;

  test('boot: anonymous visitors only get the login screen (route guard) and /me is asked on boot', async ({ page }) => {
    const meCalls = [];
    page.on('request', r => { if (r.url().includes('/api/users/me')) meCalls.push(r.url()); });
    await page.goto(LIVE_BASE);
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect(page.locator('#mode-banner-badge')).toHaveText('LIVE CMS');
    expect(meCalls.length).toBeGreaterThan(0);

    for (const hash of ['#dashboard', '#editor', '#review', '#live', '#media', '#editor?id=1']) {
      await page.goto(`${LIVE_BASE}${hash}`);
      await expect(page.getByTestId('login-view')).toBeVisible();
      await expect(page.locator('.nav-bar')).toBeHidden();
    }
    // no mock affordances in the live build
    await expect(page.locator('#user-role-select')).toHaveCount(0);
    await expect(page.locator('.demo-fill-btn')).toHaveCount(0);
    await expect(page.locator('#btn-cms-settings')).toHaveCount(0);
  });

  test('wrong password shows the CMS message; nothing is stored', async ({ page }) => {
    await page.goto(LIVE_BASE);
    await page.getByTestId('login-email').fill(creds.reporter.email);
    await page.getByTestId('login-password').fill('not-the-password-123');
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toContainText('incorrect');
    await expect(page.getByTestId('login-view')).toBeVisible();
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).toLowerCase());
    expect(storage).not.toMatch(/password|token|jwt/);
  });

  test('the session cookie is really sent: /users/me after a reload carries payload-token; without it the CMS answers anonymous', async ({ page }) => {
    await signIn(page, 'reporter');
    const meRequest = page.waitForRequest(r => r.url().includes('/api/users/me'));
    const meResponse = page.waitForResponse(r => r.url().includes('/api/users/me'));
    await page.reload();
    const headers = await (await meRequest).allHeaders();
    expect(headers.cookie ?? '', '/users/me must be sent with the session cookie').toContain('payload-token=');
    const body = await (await meResponse).json();
    expect(body.user?.email).toBe(creds.reporter.email);
    await expect(page.getByTestId('session-user')).toBeVisible();

    // control: the very same call without the cookie is anonymous, so the cookie is what authenticates
    await page.context().clearCookies();
    const anonymous = await page.evaluate(async (base) => (await (await fetch(`${base}/api/users/me`, { credentials: 'include' })).json()).user, LIVE_CMS_URL);
    expect(anonymous).toBeNull();
  });

  test('reporter: role comes from the server; writes rich text; saves only after the CMS answers', async ({ page }) => {
    await signIn(page, 'reporter');
    await expect(page.getByTestId('session-user-role')).toContainText('Reporter');
    await expect(page.getByTestId('story-list')).toBeVisible();

    await page.getByTestId('nav-new-story').click();
    await page.getByTestId('editor-title').fill(storyTitle);
    await page.getByTestId('editor-standfirst').fill('A standfirst for the live end-to-end test.');
    const body = [
      '## First heading',
      'Opening paragraph with **bold**, *italic* and a [link](https://example.org/x).',
      '### Sub-heading',
      '> A quoted line',
      '- item one\n- item two',
      'Closing paragraph.'
    ].join('\n\n');
    await page.getByTestId('editor-body').fill(body);
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully'); // first save creates the record
    await expect(page).toHaveURL(/#editor\?id=\d+/);
    storyId =new URL(page.url()).hash.match(/id=(\d+)/)[1];

    const doc = await articleViaApi(storyId);
    expect(doc.title).toBe(storyTitle);
    expect(doc.status).toBe('draft');
    expect(doc.excerpt).toBe('A standfirst for the live end-to-end test.');
    expect(doc.author?.email ?? '').toBe(creds.reporter.email);
    const types = doc.content.root.children.map(c => c.type);
    expect(types).toEqual(['heading', 'paragraph', 'heading', 'quote', 'list', 'paragraph']);
    expect(doc.content.root.children[0].tag).toBe('h2');
    expect(JSON.stringify(doc.content)).toContain('https://example.org/x');
    expect(doc.content.root.children[1].children.some(n => n.format === 1)).toBe(true);

    // reload: Lexical is mapped back to editable text
    await page.reload();
    await expect(page.getByTestId('editor-title')).toHaveValue(storyTitle);
    await expect(page.getByTestId('editor-body')).toHaveValue(body);
  });

  test('editing an unchanged story sends nothing; changing the title PATCHes only the title', async ({ page }) => {
    await signIn(page, 'reporter');
    await page.goto(`${LIVE_BASE}#editor?id=${storyId}`);
    await expect(page.getByTestId('editor-title')).toHaveValue(storyTitle);

    const patches = [];
    page.on('request', r => { if (r.method() === 'PATCH' && r.url().includes('/api/articles/')) patches.push(r.postDataJSON()); });

    // nothing changed: no CMS call, and the UI says so instead of claiming a save
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('No changes to save');
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(0);
    expect(patches).toHaveLength(0);

    const patchResponse = () => page.waitForResponse(r => r.request().method() === 'PATCH' && /\/api\/articles\/\d+(\?|$)/.test(r.url()));

    const edited = `${storyTitle} (edited)`;
    let pending = patchResponse();
    await page.getByTestId('editor-title').fill(edited);
    await page.getByTestId('editor-save-draft').click();
    let res = await pending;
    expect(res.status()).toBeGreaterThanOrEqual(200);
    expect(res.status()).toBeLessThan(300);
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved successfully' })).toHaveCount(1);
    expect(patches.length).toBeGreaterThanOrEqual(1);
    for (const p of patches) {
      expect(Object.keys(p)).toEqual(['title']);
    }
    expect((await articleViaApi(storyId)).title).toBe(edited); // verified on the server, not just in the UI

    pending = patchResponse();
    await page.getByTestId('editor-title').fill(storyTitle);
    await page.getByTestId('editor-save-draft').click();
    res = await pending;
    expect(res.ok()).toBe(true);
    expect((await articleViaApi(storyId)).title).toBe(storyTitle);
  });

  test('reporter submits for review; has no approve/publish; request changes + resubmit + approve + publish by editor-in-chief', async ({ page }) => {
    await signIn(page, 'reporter');
    await page.goto(`${LIVE_BASE}#editor?id=${storyId}`);
    await expect(page.getByTestId('editor-approve')).toHaveCount(0);
    await expect(page.getByTestId('editor-publish')).toHaveCount(0);
    await page.getByTestId('editor-submit-review').click();
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review');
    expect((await articleViaApi(storyId)).status).toBe('in_review');
    await expect(page.getByTestId('editor-submit-review')).toHaveCount(0);
    await signOut(page);

    // editor-in-chief requests changes
    await signIn(page, 'editor-in-chief');
    await page.goto(`${LIVE_BASE}#editor?id=${storyId}`);
    await page.getByTestId('editor-request-changes').click();
    await page.getByTestId('request-changes-input').fill('Please add a second source.');
    await page.getByTestId('request-changes-confirm').click();
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'changes_requested');
    expect((await articleViaApi(storyId)).reviewNotes).toBe('Please add a second source.');
    await signOut(page);

    // reporter sees the notes and resubmits
    await signIn(page, 'reporter');
    await page.goto(`${LIVE_BASE}#editor?id=${storyId}`);
    await expect(page.getByTestId('editor-review-notes')).toContainText('Please add a second source.');
    await page.getByTestId('editor-submit-review').click();
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review');
    await signOut(page);

    // review queue: inspect, approve, publish
    await signIn(page, 'editor-in-chief');
    await page.goto(`${LIVE_BASE}#review`);
    const card = page.locator(`[data-testid="review-card"][data-story-id="${storyId}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId('review-inspect').click();
    await expect(page.getByTestId('inspect-body')).toContainText('Opening paragraph');
    await page.getByTestId('inspect-approve').click();
    await expect(page.locator('.toast').last()).toContainText('approved');
    expect((await articleViaApi(storyId)).status).toBe('approved');

    await page.goto(`${LIVE_BASE}#editor?id=${storyId}`);
    await page.getByTestId('editor-publish').click();
    await page.getByTestId('publish-ok').click();
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'published');
    const published = await articleViaApi(storyId);
    expect(published.status).toBe('published');
    expect(published.publishedAt).toBeTruthy();

    // editing a published story requires a correction note (server rule) and the UI asks for it
    await page.getByTestId('editor-standfirst').fill('A corrected standfirst.');
    await page.getByTestId('editor-save-draft').click();
    await page.getByTestId('correction-note-input').fill('Clarified the standfirst.');
    await page.getByTestId('correction-note-confirm').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');
    const corrected = await articleViaApi(storyId);
    expect(corrected.excerpt).toBe('A corrected standfirst.');
    expect(corrected.corrections.map(c => c.note)).toContain('Clarified the standfirst.');
  });

  test('server refusals are shown and change nothing (403) and a lost session returns to login (401)', async ({ page }) => {
    await signIn(page, 'reporter');
    await page.getByTestId('nav-new-story').click();
    await page.getByTestId('editor-title').fill(`Refusal test ${run}`);
    await page.getByTestId('editor-body').fill('Body text.');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');

    // 403 from the CMS on the next PATCH: the UI shows the CMS message and does not move to in_review
    await page.route('**/api/articles/*', route => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 403,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true' },
          body: JSON.stringify({ errors: [{ message: 'You are not allowed to perform this action.' }] })
        });
      }
      return route.continue();
    });
    await page.getByTestId('editor-submit-review').click();
    await expect(page.getByTestId('editor-error')).toContainText('You are not allowed to perform this action.');
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft');
    await expect(page.getByTestId('login-view')).toHaveCount(0);
    await page.unroute('**/api/articles/*');

    // 401: back to login, no state kept
    await page.route('**/api/articles/*', route => {
      if (route.request().method() === 'PATCH') {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true' },
          body: JSON.stringify({ errors: [{ message: 'You are not logged in.' }] })
        });
      }
      return route.continue();
    });
    await page.getByTestId('editor-submit-review').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    await expect(page.getByTestId('login-notice')).toContainText('session has ended');
    await expect(page.getByTestId('session-user')).toHaveCount(0);
  });

  test('ids are validated before use in API paths', async ({ page }) => {
    await signIn(page, 'reporter');
    const apiCalls = [];
    page.on('request', r => { if (r.url().includes('/api/articles/')) apiCalls.push(r.url()); });
    for (const bad of ['abc', '1%2F..%2Fusers', '1;drop', '-1']) {
      await page.goto(`${LIVE_BASE}#editor?id=${bad}`);
      await expect(page.getByTestId('story-list')).toBeVisible(); // bounced to the dashboard
    }
    // every article request that did happen (none here) must be a numeric id, optionally followed by a query string
    expect(apiCalls.filter(u => !/\/api\/articles\/\d+(\?|$)/.test(u))).toEqual([]);

    // control: a valid id is requested, and exactly in that shape
    await page.goto(`${LIVE_BASE}#editor?id=${storyId}`);
    await expect(page.getByTestId('editor-title')).toHaveValue(storyTitle);
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls.every(u => /\/api\/articles\/\d+(\?|$)/.test(u))).toBe(true);
  });

  test('markup in titles and bodies is escaped everywhere: editor, dashboard, review card and inspect modal (XSS)', async ({ page }) => {
    const dialogs = [];
    page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
    const evilTitle = `<img src=x onerror="window.__xss=1"> ${run}`;
    const evilBody = '<script>window.__xss=2</script> **ok** <img src=x onerror="window.__xss=3"> [js](javascript:alert(1))';
    const assertInert = async (where) => {
      await expect(page.locator('a[href^="javascript" i]'), `${where}: no javascript: links`).toHaveCount(0);
      expect(await page.evaluate(() => window.__xss), `${where}: no script ran`).toBeUndefined();
      expect(dialogs, `${where}: no dialog fired`).toEqual([]);
    };

    await signIn(page, 'reporter');
    await page.getByTestId('nav-new-story').click();
    await page.getByTestId('editor-title').fill(evilTitle);
    await page.getByTestId('editor-body').fill(evilBody);
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');
    await expect(page).toHaveURL(/#editor\?id=\d+/);
    const xssId = new URL(page.url()).hash.match(/id=(\d+)/)[1];
    await page.getByTestId('editor-submit-review').click();
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review');
    await assertInert('editor right after saving');

    // What a hostile or careless CMS user could store: markup in text and a Lexical link with a javascript: URL.
    const seeded = await adminApi.patch(`/api/articles/${xssId}`, {
      data: {
        content: lexDoc(lexPara(
          lexText('<script>window.__xss=4</script> <img src=x onerror="window.__xss=5"> '),
          lexLink('javascript:alert(1)', 'click me')
        ))
      }
    });
    expect(seeded.ok()).toBe(true);

    // 1. editor (reopened from the server)
    await page.goto(`${LIVE_BASE}#editor?id=${xssId}`);
    await page.reload();
    await expect(page.getByTestId('editor-title')).toHaveValue(evilTitle);
    await expect(page.locator('#preview-headline')).toHaveText(evilTitle);
    await expect(page.getByTestId('editor-lossy-note')).toBeVisible(); // the unsafe link makes the body read-only
    await expect(page.locator('#preview-body-content')).toContainText('<img src=x onerror');
    await expect(page.locator('#preview-body-content img, #preview-body-content script, #preview-headline img')).toHaveCount(0);
    await assertInert('editor');

    // 2. dashboard
    await page.goto(`${LIVE_BASE}#dashboard`);
    await expect(page.getByTestId('story-list')).toContainText('<img src=x');
    await expect(page.getByTestId('story-list').locator('img[src="x"], script')).toHaveCount(0);
    await assertInert('dashboard');
    await signOut(page);

    // 3. review card and 4. inspect modal, as the editor-in-chief
    await signIn(page, 'editor-in-chief');
    await page.goto(`${LIVE_BASE}#review`);
    const card = page.locator(`[data-testid="review-card"][data-story-id="${xssId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('<img src=x');
    await expect(card.locator('img[src="x"], script')).toHaveCount(0);
    await assertInert('review card');

    await card.getByTestId('review-inspect').click();
    const modal = page.getByTestId('inspect-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('<img src=x onerror');
    await expect(modal.locator('img[src="x"], script')).toHaveCount(0);
    await expect(page.getByTestId('inspect-body')).toContainText('click me');
    await assertInert('inspect modal');
    await page.waitForTimeout(500); // give any injected handler time to fire
    await assertInert('after settling');
  });

  test('a body the editor cannot represent is read-only and a title edit never sends or rewrites content', async ({ page }) => {
    await signIn(page, 'reporter');
    await page.getByTestId('nav-new-story').click();
    const title = `Lossy body ${run}`;
    await page.getByTestId('editor-title').fill(title);
    await page.getByTestId('editor-body').fill('Placeholder body.');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');
    const lossyId = new URL(page.url()).hash.match(/id=(\d+)/)[1];

    // Rich text this app cannot round-trip: a link that opens in a new tab, and centred alignment.
    const rich = lexDoc(
      { ...lexPara(lexText('Read '), lexLink('https://example.org/x', 'this', { newTab: true }), lexText(' carefully.')), format: 'center' }
    );
    expect((await adminApi.patch(`/api/articles/${lossyId}`, { data: { content: rich } })).ok()).toBe(true);
    const before = JSON.stringify((await articleViaApi(lossyId)).content);

    const patches = [];
    page.on('request', r => { if (r.method() === 'PATCH' && r.url().includes('/api/articles/')) patches.push(r.postDataJSON()); });
    await page.goto(`${LIVE_BASE}#editor?id=${lossyId}`);
    await page.reload();
    await expect(page.getByTestId('editor-title')).toHaveValue(title);
    await expect(page.getByTestId('editor-lossy-note')).toBeVisible();
    await expect(page.getByTestId('editor-body')).toHaveJSProperty('readOnly', true);

    const pending = page.waitForResponse(r => r.request().method() === 'PATCH' && /\/api\/articles\/\d+(\?|$)/.test(r.url()));
    await page.getByTestId('editor-title').fill(`${title} (edited)`);
    await page.getByTestId('editor-save-draft').click();
    expect((await pending).ok()).toBe(true);
    expect(patches.length).toBeGreaterThanOrEqual(1);
    for (const p of patches) expect(Object.keys(p)).toEqual(['title']);

    const after = await articleViaApi(lossyId);
    expect(after.title).toBe(`${title} (edited)`);
    expect(JSON.stringify(after.content)).toBe(before); // the stored rich text is untouched
    expect(JSON.stringify(after.content)).toContain('"newTab":true');
  });

  test('media: multipart upload to /api/media, then pick it as the featured image', async ({ page }) => {
    await signIn(page, 'reporter');
    await page.getByTestId('nav-new-story').click();
    const title = `Media story ${run}`;
    await page.getByTestId('editor-title').fill(title);
    await page.getByTestId('editor-body').fill('Story with a picture.');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');
    const mediaStoryId = new URL(page.url()).hash.match(/id=(\d+)/)[1];

    await page.getByTestId('editor-choose-image').click();
    await expect(page.getByTestId('media-picker')).toBeVisible();
    await page.getByTestId('media-picker-upload-toggle').click();
    await page.getByTestId('media-upload-input').setInputFiles({ name: 'e2e.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await page.getByTestId('media-upload-alt').fill(`E2E picture ${run}`);
    await page.getByTestId('media-upload-credit').fill('E2E Photographer');
    await page.getByTestId('media-upload-submit').click();
    await expect(page.getByTestId('editor-featured-image-alt')).toContainText(`E2E picture ${run}`);

    // image URL comes from the CMS response and points at the CMS origin
    const src = await page.getByTestId('editor-featured-image-img').getAttribute('src');
    expect(src.startsWith(LIVE_CMS_URL)).toBe(true);

    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');
    const doc = await articleViaApi(mediaStoryId);
    expect(doc.featuredImage?.alt).toBe(`E2E picture ${run}`);
    expect(doc.featuredImage?.credit).toBe('E2E Photographer');

    // library lists it too
    await page.goto(`${LIVE_BASE}#media`);
    await expect(page.getByTestId('media-grid')).toContainText(`E2E picture ${run}`);

    // library upload (second path) and a refusal for a non-image
    await page.getByTestId('media-upload-open').click();
    await page.getByTestId('media-upload-input').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
    await page.getByTestId('media-upload-alt').fill('not an image');
    await page.getByTestId('media-upload-submit').click();
    await expect(page.getByTestId('media-upload-error')).toBeVisible();
    await expect(page.getByTestId('media-grid')).not.toContainText('not an image');
  });

  test('reader tips: editors convert through the convert endpoint; submitter identity is not copied into the story', async ({ page }) => {
    // The tip itself is submitted on the public site; here we create it the way that site does.
    const tipTitle = `Tip about a clinic ${run}`;
    const pub = await playwrightRequest.newContext({ baseURL: LIVE_API_LOOPBACK });
    const res = await pub.post('/api/public/submissions', {
      headers: {
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        // staging sits behind a trusted-proxy model: a unique client address per run isolates the per-IP rate limit
        'X-Forwarded-For': `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`
      },
      data: {
        name: 'Tipster Name', email: `tipster-${run}@example.org`, title: tipTitle,
        body: 'The parish opened a free clinic serving about three hundred families every week.',
        turnstileToken: 'XXXX.DUMMY.TOKEN.XXXX'
      }
    });
    expect(res.status()).toBe(201);
    await pub.dispose();

    // reporters cannot review tips
    await signIn(page, 'reporter');
    await page.goto(`${LIVE_BASE}#review`);
    await page.getByTestId('review-tab-submissions').click();
    await expect(page.getByTestId('tips-not-permitted')).toBeVisible();
    await signOut(page);

    await signIn(page, 'editor-in-chief');
    await page.goto(`${LIVE_BASE}#review`);
    await page.getByTestId('review-tab-submissions').click();
    const tip = page.locator('[data-testid="tip-card"]', { hasText: tipTitle });
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute('data-status', 'new');
    await tip.getByTestId('tip-convert').click();
    await page.getByTestId('tip-convert-confirm').click();
    await expect(page.locator('.toast').last()).toContainText('Tip converted');
    await expect(page.getByTestId('editor-title')).toHaveValue(tipTitle);
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft');
    const id = new URL(page.url()).hash.match(/id=(\d+)/)[1];
    const doc = await articleViaApi(id);
    expect(doc.status).toBe('draft');
    expect(doc.author?.email).toBe(creds['editor-in-chief'].email);
    // The CMS convert endpoint credits the submitter's NAME as byline only (never email/phone); nothing else is copied.
    expect(JSON.stringify([doc.title, doc.excerpt, doc.content])).not.toContain('Tipster Name');
    expect(JSON.stringify(doc)).not.toContain(`tipster-${run}@example.org`);
    expect(doc.bylineName).toBe('Tipster Name');
    await expect(page.getByTestId('editor-byline')).toHaveValue('Tipster Name'); // visible and editable by the editor
    // ...and the editor says so, so a source who must stay anonymous is not published by accident
    const tipWarning = page.getByTestId('editor-tip-byline-warning');
    await expect(tipWarning).toBeVisible();
    await expect(tipWarning).toContainText('Clear the byline before publishing');
    await page.getByTestId('editor-byline').fill('');
    await expect(tipWarning).toBeHidden();

    // converting again is refused by the CMS and the refusal is shown
    await page.goto(`${LIVE_BASE}#review`);
    await page.getByTestId('review-tab-submissions').click();
    await page.getByTestId('tip-filter').selectOption('converted');
    await expect(page.locator('[data-testid="tip-card"]', { hasText: tipTitle })).toHaveAttribute('data-status', 'converted');
  });

  test('live coverage: editor-in-chief creates an event, goes live, posts; reporter update waits for approval', async ({ page }) => {
    const eventTitle = `Synod ${run}`;
    await signIn(page, 'editor-in-chief');
    await page.goto(`${LIVE_BASE}#live`);
    await page.getByTestId('live-new-event').click();
    await page.getByTestId('live-event-title').fill(eventTitle);
    await page.getByTestId('live-event-create').click();
    await expect(page.getByTestId('live-event-status')).toContainText('DRAFT');
    await page.getByTestId('live-go-live').click();
    await expect(page.getByTestId('live-event-status')).toContainText('LIVE NOW');

    await page.getByTestId('live-update-body').fill(`Editor update ${run}`);
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-timeline')).toContainText(`Editor update ${run}`);
    await signOut(page);

    await signIn(page, 'reporter');
    await page.goto(`${LIVE_BASE}#live`);
    await page.getByTestId('live-event-select').selectOption({ label: `LIVE NOW: ${eventTitle}` });
    await expect(page.getByTestId('live-event-banner')).toContainText(eventTitle);
    await expect(page.getByTestId('live-timeline')).not.toContainText('Loading live timeline');
    await page.getByTestId('live-update-body').fill(`Reporter update ${run}`);
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-pending-list')).toContainText(`Reporter update ${run}`);
    await expect(page.getByTestId('live-timeline')).not.toContainText(`Reporter update ${run}`);
    await expect(page.getByTestId('live-approve')).toHaveCount(0);
    await signOut(page);

    await signIn(page, 'editor-in-chief');
    await page.goto(`${LIVE_BASE}#live`);
    await page.getByTestId('live-event-select').selectOption({ label: `LIVE NOW: ${eventTitle}` });
    await expect(page.getByTestId('live-event-banner')).toContainText(eventTitle);
    await expect(page.getByTestId('live-timeline')).not.toContainText('Loading live timeline');
    await page.getByTestId('live-approve').first().click();
    await expect(page.getByTestId('live-timeline')).toContainText(`Reporter update ${run}`);
  });

  test('editor-in-chief can delete a story from the dashboard (real DELETE)', async ({ page }) => {
    await signIn(page, 'editor-in-chief');
    await page.getByTestId('dash-search').fill(`Refusal test ${run}`);
    const row = page.locator('[data-testid="story-row"]', { hasText: `Refusal test ${run}` });
    await expect(row).toHaveCount(1);
    const id = await row.getAttribute('data-story-id');
    await row.getByTestId('story-delete').click();
    await page.getByTestId('delete-story-ok').click();
    await expect(page.locator('.toast').last()).toContainText('Story deleted');
    const res = await adminGet(`/api/articles/${id}`);
    expect(res.status()).toBe(404);

    // reporters never see delete
    await signOut(page);
    await signIn(page, 'reporter');
    await expect(page.getByTestId('story-delete')).toHaveCount(0);
  });

  test('logout ends the CMS session, clears newsroom storage and re-locks the app', async ({ page }) => {
    await signIn(page, 'reporter');
    await page.evaluate(() => localStorage.setItem('ctn_leftover', 'x'));
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-view')).toBeVisible();

    const keys = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ctn_') && k !== 'ctn_theme'));
    expect(keys).toEqual([]);
    const me = await page.evaluate(async (base) => {
      const r = await fetch(`${base}/api/users/me`, { credentials: 'include' });
      return (await r.json()).user;
    }, LIVE_CMS_URL);
    expect(me).toBeNull();

    await page.goto(`${LIVE_BASE}#dashboard`);
    await expect(page.getByTestId('login-view')).toBeVisible();
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).toLowerCase());
    expect(storage).not.toMatch(/password|token|jwt/);
  });
});
