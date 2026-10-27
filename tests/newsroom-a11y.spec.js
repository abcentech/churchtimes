import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Newsroom accessibility suite, MOCK MODE ONLY (same server as tests/newsroom.spec.js).
 *
 * - axe-core (wcag2a, wcag2aa, wcag21a, wcag21aa, best-practice) on every newsroom screen and state, desktop + mobile.
 *   serious/critical violations FAIL the test; minor/moderate ones are reported as test annotations (CI shows them).
 * - Keyboard-only checks, aria-live announcements, form labels, reduced motion and 320px reflow.
 *
 * Unavoidable exceptions live in A11Y_ALLOWLIST below, each with a reason. Keep it empty if you can.
 */

test.setTimeout(120_000); // CI runners and busy dev machines are slow; every test boots a page and runs axe

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

/** { rule: axe rule id, selector: substring of a failing node target, reason: why it cannot be fixed } */
const A11Y_ALLOWLIST = [
  // (none)
];

const isAllowed = (ruleId, node) =>
  A11Y_ALLOWLIST.some(a => a.rule === ruleId && node.target.join(' ').includes(a.selector));

async function scan(page, label, testInfo) {
  await page.waitForTimeout(300); // let entrance animations/transitions settle before measuring contrast
  let results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  // A toast fading out mid-scan makes axe report colour contrast against :root (no stable background). Re-scan once.
  if (results.violations.some(v => v.nodes.some(n => n.target.join(' ') === ':root'))) {
    await page.waitForTimeout(800);
    results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  }
  const blocking = [];
  for (const v of results.violations) {
    const nodes = v.nodes.filter(n => !isAllowed(v.id, n));
    if (!nodes.length) continue;
    const line = `${label}: [${v.impact}] ${v.id} - ${v.help} (${nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}${nodes.length > 3 ? ` +${nodes.length - 3} more` : ''})`;
    if (v.impact === 'serious' || v.impact === 'critical') blocking.push(line);
    else {
      testInfo.annotations.push({ type: 'a11y-minor', description: line });
      if (process.env.GITHUB_ACTIONS) console.log(`::warning title=a11y ${v.id}::${line}`);
    }
  }
  expect(blocking, blocking.join('\n')).toEqual([]);
}

async function signedIn(page, hash, role) {
  await page.goto('./');
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.goto('./#dashboard');
  await expect(page.getByTestId('session-user')).toBeVisible();
  if (role) await page.locator('#user-role-select').selectOption({ label: role });
  await page.goto(`./${hash}`);
}

const EDITOR = 'Derin Adeogun (Section Editor)';
const CHIEF = 'Lanre Ogundipe (Editor-in-Chief)';

test.describe('axe: every screen and state', () => {
  test('login', async ({ page }, ti) => {
    await signedIn(page, '#dashboard');
    await page.getByTestId('logout').click();
    await expect(page.getByTestId('login-view')).toBeVisible();
    await scan(page, 'login', ti);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('login-error')).toBeVisible();
    await scan(page, 'login-error', ti);
  });

  test('dashboard and story list', async ({ page }, ti) => {
    await signedIn(page, '#dashboard');
    await expect(page.getByTestId('story-row').first()).toBeVisible();
    await scan(page, 'dashboard', ti);
    await page.getByTestId('dash-search').fill('zzz-nothing');
    await scan(page, 'story-list-empty', ti);
  });

  test('story editor: new, validation error, saved, publish confirm and result', async ({ page }, ti) => {
    await signedIn(page, '#editor', CHIEF);
    await expect(page.getByTestId('editor-title')).toBeVisible();
    await scan(page, 'editor-new', ti);
    await page.getByTestId('editor-save-draft').click();
    await expect(page.getByTestId('editor-error')).toBeVisible();
    await scan(page, 'editor-validation-error', ti);
    await page.getByTestId('editor-title').fill('Accessibility check story');
    await page.getByTestId('editor-body').fill('Body text for the accessibility check.');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved');
    await scan(page, 'editor-saved', ti);
    await page.getByTestId('editor-publish').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await scan(page, 'editor-publish-confirm', ti);
    await page.getByTestId('publish-ok').click();
    // Whatever the mock answers (published, or blocked with an error) the resulting state must be accessible too.
    await expect(page.locator('.toast').last()).toBeVisible();
    await scan(page, 'editor-after-publish-attempt', ti);
  });

  test('review queue (every tab) and inspect modal', async ({ page }, ti) => {
    await signedIn(page, '#review', EDITOR);
    for (const tab of ['articles_review', 'submissions', 'revisions', 'approved']) {
      await page.getByTestId(`review-tab-${tab}`).click();
      await scan(page, `review-${tab}`, ti);
    }
    await page.getByTestId('review-tab-articles_review').click();
    await page.getByTestId('review-inspect').first().click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await scan(page, 'review-inspect-modal', ti);
  });

  test('live events', async ({ page }, ti) => {
    await signedIn(page, '#live', EDITOR);
    await expect(page.getByTestId('live-new-event')).toBeVisible();
    await scan(page, 'live-list', ti);
    await page.getByTestId('live-new-event').click();
    await scan(page, 'live-new-event-form', ti);
    await page.getByTestId('live-event-title').fill('A11y live event');
    await page.getByTestId('live-event-create').click();
    await page.getByTestId('live-go-live').click();
    await expect(page.getByTestId('live-event-status')).toContainText('LIVE NOW');
    await page.getByTestId('live-update-body').fill('First update.');
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-timeline')).toContainText('First update.');
    await scan(page, 'live-event-running', ti);
  });

  test('media library, detail modal and public tip notice (submit route)', async ({ page }, ti) => {
    await signedIn(page, '#media');
    await expect(page.getByTestId('media-card').first()).toBeVisible();
    await scan(page, 'media', ti);
    await page.getByTestId('media-card').first().click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await scan(page, 'media-detail-modal', ti);
    await page.keyboard.press('Escape');
    await page.goto('./#submit');
    await expect(page.getByTestId('public-tip-notice')).toBeVisible();
    await scan(page, 'public-tip-notice', ti);
  });

  test('archive review: not-permitted, list, filtered, review screen, approve modal', async ({ page }, ti) => {
    await signedIn(page, '#archive');
    await expect(page.getByTestId('archive-not-permitted')).toBeVisible();
    await scan(page, 'archive-not-permitted', ti);
    await signedIn(page, '#archive', EDITOR);
    await expect(page.getByTestId('archive-row').first()).toBeVisible();
    await scan(page, 'archive-list', ti);
    await page.getByLabel('Recovery confidence').selectOption('missing');
    await page.getByTestId('archive-apply').click();
    await expect(page.getByTestId('archive-row')).toHaveCount(1);
    await scan(page, 'archive-list-filtered', ti);
    await page.getByTestId('archive-clear').click();
    await page.getByTestId('archive-row').first().getByTestId('archive-open').click();
    await expect(page.getByTestId('archive-publish-blocked')).toBeVisible();
    await scan(page, 'archive-review-blocked', ti);
    await page.getByTestId('archive-approve').click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await scan(page, 'archive-approve-modal', ti);
  });

  test('archive review: outbound links panel', async ({ page }, ti) => {
    await signedIn(page, '#archive', EDITOR);
    const rows = page.getByTestId('archive-row');
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    for (let i = 0; i < n; i++) {
      await page.goto('./#archive');
      await rows.nth(i).getByTestId('archive-open').click();
      await expect(page.getByTestId('archive-body')).toBeVisible();
      if (await page.getByTestId('archive-links').count()) {
        await scan(page, 'archive-review-links', ti);
        return;
      }
    }
  });

  test('dark theme', async ({ page }, ti) => {
    await signedIn(page, '#dashboard');
    await page.locator('#theme-toggle-btn').click();
    await expect(page.getByTestId('story-row').first()).toBeVisible();
    await scan(page, 'dashboard-dark', ti);
  });
});

test.describe('keyboard and assistive technology behaviour', () => {
  test('skip link is first tab stop, visible on focus, and moves focus to main', async ({ page }) => {
    await signedIn(page, '#dashboard');
    await page.keyboard.press('Tab');
    const skip = page.locator('.skip-link');
    await expect(skip).toBeFocused();
    // it slides in (0.2s transition): wait until it is fully on screen
    await expect.poll(async () => (await skip.boundingBox()).y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    await expect(page.locator('#main-content')).toBeFocused();
  });

  test('tab order reaches primary actions and every focus stop has a visible ring', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // outline transitions would otherwise be sampled mid-way
    await signedIn(page, '#dashboard');
    await expect(page.getByTestId('story-row').first()).toBeVisible();
    const seen = new Set();
    const missingRing = [];
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(60);
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
        return { ids: [el.dataset.testid, el.id].filter(Boolean), label: el.textContent.trim().slice(0, 30), ring, visible: r.width > 0 && r.height > 0 };
      });
      if (!info) continue;
      if (info.visible && !info.ring) missingRing.push(info.ids[0] || info.label);
      info.ids.forEach(id => seen.add(id));
    }
    expect(missingRing).toEqual([]);
    const desktopNav = (page.viewportSize()?.width ?? 0) > 768; // the top nav is replaced by the bottom bar on phones
    const required = ['dash-new-story', 'logout', ...(desktopNav ? ['nav-editor', 'nav-review', 'nav-live', 'nav-media', 'nav-new-story'] : [])];
    for (const id of required) {
      expect([...seen], `tab order never reached ${id}`).toContain(id);
    }
  });

  test('modal traps focus, Escape closes and focus is restored to the trigger', async ({ page }) => {
    await signedIn(page, '#media');
    const card = page.getByTestId('media-card').first();
    await card.focus();
    await page.keyboard.press('Enter');
    const modal = page.locator('.modal-overlay');
    await expect(modal).toBeVisible();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('.modal-overlay')), `focus escaped the modal on Tab ${i + 1}`).toBe(true);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement.closest('.modal-overlay')), `focus escaped the modal on Shift+Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(modal).toHaveCount(0);
    await expect(card).toBeFocused();
  });

  test('page behind an open modal is inert for assistive technology', async ({ page }) => {
    await signedIn(page, '#media');
    await page.getByTestId('media-card').first().click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    const hidden = await page.evaluate(() => {
      const main = document.getElementById('main-content');
      return main.closest('[inert]') !== null || main.closest('[aria-hidden="true"]') !== null;
    });
    expect(hidden, 'content behind aria-modal dialog must be inert/aria-hidden').toBe(true);
  });

  test('save and error messages are announced through live regions', async ({ page }) => {
    await signedIn(page, '#editor');
    await page.getByTestId('editor-save-draft').click();
    const err = page.getByTestId('editor-error');
    await expect(err).toHaveAttribute('role', 'alert');
    await expect(err).toBeVisible();
    // Toasts: the CONTAINER is a persistent live region (a live region injected together with its text is unreliable).
    const live = await page.evaluate(() => {
      const c = document.getElementById('toast-container');
      return c.getAttribute('aria-live');
    });
    expect(['polite', 'assertive']).toContain(live);
    await page.getByTestId('editor-title').fill('Live region story');
    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('#toast-container .toast').last()).toContainText('Draft saved');
    await expect(page.locator('#autosave-indicator')).toHaveAttribute('aria-live', 'polite');
  });

  test('every form control has an accessible name', async ({ page }) => {
    for (const hash of ['#editor', '#dashboard', '#live', '#media', '#review']) {
      await signedIn(page, hash, EDITOR);
      await page.waitForTimeout(300);
      const unnamed = await page.evaluate(() => [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
        .filter(el => el.offsetParent !== null)
        .filter(el => !(el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title))
        .map(el => el.id || el.dataset.testid || el.tagName));
      expect(unnamed, `unlabelled controls on ${hash}`).toEqual([]);
    }
  });

  test('reduced motion disables animations and transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signedIn(page, '#dashboard');
    await expect(page.getByTestId('story-row').first()).toBeVisible();
    const offenders = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
      const cs = getComputedStyle(el);
      const longest = s => Math.max(0, ...s.split(',').map(v => parseFloat(v) * (v.trim().endsWith('ms') ? 1 : 1000)));
      return (cs.animationName !== 'none' && longest(cs.animationDuration) > 50 && cs.animationIterationCount !== '1') ||
             longest(cs.transitionDuration) > 50;
    }).slice(0, 8).map(el => `${el.tagName}.${el.className}`));
    expect(offenders).toEqual([]);
  });

  test('reflow: no horizontal scroll at 320px (400% zoom equivalent)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    for (const [hash, role] of [['#dashboard'], ['#editor'], ['#review', EDITOR], ['#live', EDITOR], ['#media']]) {
      await signedIn(page, hash, role);
      await page.waitForTimeout(400);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, `horizontal overflow on ${hash}`).toBeLessThanOrEqual(0);
    }
  });
});
