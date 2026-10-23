import { test, expect } from '@playwright/test';

/**
 * Staff newsroom UI suite, MOCK MODE ONLY.
 *
 * These tests run against `vite apps/newsroom --mode mock` (see playwright.newsroom-app.config.js). The mock backend
 * exists only in dev builds; production builds are covered in newsroom-security.spec.js (no mock code shipped) and
 * live-CMS behaviour in the "live CMS" suite there.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('./');
  await page.evaluate(() => localStorage.clear());
  await page.goto('./#dashboard');
  await expect(page.getByTestId('session-user')).toBeVisible();
});

test.describe('Newsroom UI (dev mock mode)', () => {
  test('dashboard renders masthead, environment banner, kpis and story pipeline', async ({ page }) => {
    await expect(page.locator('.brand-title')).toHaveText('CHURCH TIMES');
    await expect(page.locator('.brand-workspace-tag')).toHaveText('Newsroom');

    await expect(page.locator('#mode-banner-badge')).toHaveText('LOCAL MOCK MODE');
    await expect(page.locator('.skip-link')).toHaveAttribute('href', '#main-content');

    await expect(page.locator('#dash-metrics-container')).toBeVisible();
    await expect(page.locator('.metric-card')).toHaveCount(6);
    await expect(page.locator('#launch-write-story')).toBeVisible();
    await expect(page.getByTestId('story-list').getByTestId('story-row').first()).toBeVisible();

    // The public tip form is not part of the staff app
    await expect(page.locator('[data-view-nav="submit"]')).toHaveCount(0);
    await expect(page.locator('#sub-headline-input')).toHaveCount(0);
  });

  test('story editor saves a draft only after the backend answers, then submits for review', async ({ page }) => {
    await page.getByTestId('dash-new-story').click();
    await expect(page.getByTestId('editor-title')).toBeVisible();

    const title = 'Diocesan Synod Opens in Lagos with Call for Youth Welfare';
    await page.getByTestId('editor-title').fill(title);
    await page.getByTestId('editor-standfirst').fill('Bishops and lay delegates deliberate on social investments.');
    await page.getByTestId('editor-category').selectOption({ index: 1 });
    await page.getByTestId('editor-body').fill('## Opening\n\nThe annual synod session commenced with **an opening service** and a [programme](https://example.org/programme).');

    await expect(page.locator('#preview-headline')).toHaveText(title);
    await expect(page.locator('#preview-body-content h2')).toHaveText('Opening');
    await expect(page.locator('#preview-body-content strong')).toHaveText('an opening service');
    await expect(page.getByTestId('editor-slug')).toHaveValue('diocesan-synod-opens-in-lagos-with-call-for-youth-welfare');
    await expect(page.locator('#word-count-badge')).toContainText('words');

    await page.getByTestId('editor-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');
    await expect(page).toHaveURL(/#editor\?id=/);

    await page.getByTestId('editor-submit-review').click();
    await expect(page.locator('.toast').last()).toContainText('submitted for editorial review');
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'in_review');
  });

  test('editor refuses to save without a headline and shows the message', async ({ page }) => {
    await page.getByTestId('dash-new-story').click();
    await page.getByTestId('editor-save-draft').click();
    await expect(page.getByTestId('editor-error')).toContainText('Enter a headline');
    await expect(page.locator('.toast').filter({ hasText: 'Draft saved' })).toHaveCount(0);
  });

  test('review queue lets an editor inspect and approve an in-review story', async ({ page }) => {
    await page.locator('#user-role-select').selectOption({ label: 'Derin Adeogun (Section Editor)' });
    await page.goto('./#review');
    await expect(page.locator('.review-tabs')).toBeVisible();
    await page.getByTestId('review-tab-articles_review').click();

    const inspect = page.getByTestId('review-inspect').first();
    await expect(inspect).toBeVisible();
    await inspect.click();
    await expect(page.locator('.modal-overlay')).toBeVisible();
    await expect(page.locator('.checklist-box')).toBeVisible();
    await page.getByTestId('inspect-approve').click();
    await expect(page.locator('.toast').last()).toContainText('approved for publication');
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
  });

  test('reader tips are reviewed in the queue and converted through the convert action', async ({ page }) => {
    await page.locator('#user-role-select').selectOption({ label: 'Derin Adeogun (Section Editor)' });
    await page.goto('./#review');
    await page.getByTestId('review-tab-submissions').click();
    await expect(page.getByTestId('tip-list').getByTestId('tip-card').first()).toBeVisible();
    // Never auto-published
    await expect(page.getByTestId('tip-card').first()).toHaveAttribute('data-status', /new|under_review/);

    await page.getByTestId('tip-convert').first().click();
    await page.getByTestId('tip-convert-confirm').click();
    await expect(page.locator('.toast').last()).toContainText('Tip converted into a new draft story');
    await expect(page.getByTestId('editor-title')).toBeVisible();
    await expect(page.getByTestId('editor-status')).toHaveAttribute('data-status', 'draft');
  });

  test('live coverage: editor creates an event, goes live and publishes an update', async ({ page }) => {
    await page.locator('#user-role-select').selectOption({ label: 'Derin Adeogun (Section Editor)' });
    await page.goto('./#live');
    await expect(page.locator('.view-title')).toHaveText('Live Coverage & Real-Time Updates');
    await expect(page.locator('#live-viewer-count')).toHaveCount(0); // no invented viewer numbers

    await page.getByTestId('live-new-event').click();
    await page.getByTestId('live-event-title').fill('Mock Synod Opening');
    await page.getByTestId('live-event-create').click();
    await page.getByTestId('live-go-live').click();
    await expect(page.getByTestId('live-event-status')).toContainText('LIVE NOW');

    await page.getByTestId('live-update-body').fill('Delegates assembled for the opening session.');
    await page.getByTestId('live-update-post').click();
    await expect(page.getByTestId('live-timeline')).toContainText('Delegates assembled for the opening session.');
  });

  test('media library lists assets, searches and opens details', async ({ page }) => {
    await page.goto('./#media');
    await expect(page.getByTestId('media-grid')).toBeVisible();
    await expect(page.getByTestId('media-card')).toHaveCount(6);

    await page.getByTestId('media-search').fill('Omololu');
    await expect(page.getByTestId('media-card')).toHaveCount(1);

    await page.getByTestId('media-card').first().click();
    await expect(page.locator('.modal-overlay')).toContainText('Accessible Alt Text');
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal-overlay')).toHaveCount(0);
  });

  test('archive review: a reporter has no access; an editor filters, reads provenance, approves and rejects', async ({ page }) => {
    // Reporter (the mock default): no nav entry, and the screen refuses.
    await expect(page.locator('[data-archive-nav]')).toHaveJSProperty('hidden', true);
    await page.goto('./#archive');
    await expect(page.getByTestId('archive-not-permitted')).toBeVisible();

    await page.locator('#user-role-select').selectOption({ label: 'Derin Adeogun (Section Editor)' });
    await page.goto('./#archive');
    await expect(page.locator('[data-archive-nav]')).toHaveJSProperty('hidden', false);
    await expect(page.locator('.view-title')).toHaveText('Archive review');
    // Default view: pending drafts, with counts.
    await expect(page.getByTestId('archive-row')).toHaveCount(3);
    await expect(page.getByTestId('archive-count-pending')).toContainText('3');
    await expect(page.getByTestId('archive-count-reviewed')).toContainText('1');
    const first = page.getByTestId('archive-row').first();
    await expect(first.getByTestId('archive-source-host')).toHaveText('old-site.test');
    await expect(first.getByTestId('archive-confidence')).toBeVisible();

    await page.getByLabel('Recovery confidence').selectOption('missing');
    await page.getByTestId('archive-apply').click();
    await expect(page.getByTestId('archive-row')).toHaveCount(1);
    await page.getByTestId('archive-clear').click();
    await expect(page.getByTestId('archive-row')).toHaveCount(4);

    // Review screen: provenance beside the body; the source opens only on click, safely.
    await page.getByTestId('archive-row').first().getByTestId('archive-open').click();
    await expect(page.getByTestId('archive-publish-blocked')).toContainText('has not been reviewed');
    await expect(page.getByTestId('archive-body')).toBeVisible();
    await expect(page.getByTestId('archive-sha')).toContainText('11111111');
    const link = page.getByTestId('archive-source-link');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(page.locator('iframe, img[src*="old-site"]')).toHaveCount(0);
    await expect(page.getByTestId('archive-open-editor')).toBeVisible();

    await page.getByTestId('archive-approve').click();
    await page.getByTestId('archive-approve-confirm-ok').click();
    await expect(page.getByTestId('archive-publish-clear')).toBeVisible();
    await expect(page.getByTestId('archive-approve')).toHaveCount(0);

    await page.getByTestId('archive-reject').click();
    await page.getByTestId('archive-reject-confirm-ok').click();
    await expect(page.getByTestId('archive-publish-blocked')).toContainText('rejected');
  });

  test('archive review: outbound links are listed as text, flagged, and must be acknowledged before Approve', async ({ page }) => {
    await page.locator('#user-role-select').selectOption({ label: 'Derin Adeogun (Section Editor)' });
    await page.goto('./#archive');
    await page.getByTestId('archive-row').filter({ hasText: 'Invented synod headline only' }).getByTestId('archive-open').click();

    const panel = page.getByTestId('archive-links');
    await expect(page.getByTestId('archive-links-summary')).toHaveText('Links in this article (3)');
    await expect(page.getByTestId('archive-links-counts')).toContainText('3 of 3 point to a host not on the known list');
    await expect(panel.getByTestId('archive-link-item')).toHaveCount(3);
    await expect(panel.getByTestId('archive-link-host').first()).toHaveText('spam-casino.test');
    await expect(panel.getByTestId('archive-link-href').first()).toHaveText('https://spam-casino.test/win');
    await expect(panel.getByTestId('archive-link-unknown').first()).toBeVisible();
    // The list is text only: nothing in it can be clicked through.
    await expect(panel.locator('a')).toHaveCount(0);

    const approve = page.getByTestId('archive-approve');
    await expect(approve).toBeDisabled();
    await page.getByTestId('archive-links-ack').check();
    await expect(approve).toBeEnabled();
    await page.getByTestId('archive-links-ack').uncheck();
    await expect(approve).toBeDisabled();
    await page.getByTestId('archive-links-ack').check();
    await approve.click();
    await page.getByTestId('archive-approve-confirm-ok').click();
    await expect(page.getByTestId('archive-publish-clear')).toBeVisible();

    // A story without links needs no acknowledgement.
    await page.goto('./#archive');
    await page.getByLabel('Review status').selectOption('pending');
    await page.getByTestId('archive-apply').click();
    await page.getByTestId('archive-row').filter({ hasText: 'harvest festival' }).getByTestId('archive-open').click();
    await expect(page.getByTestId('archive-links')).toHaveCount(0);
    await expect(page.getByTestId('archive-approve')).toBeEnabled();
  });

  test('the app loads under its Content-Security-Policy with no violations', async ({ page }) => {
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', e => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.reload(); // hash-only goto would not start a new document, so the init script must run via a reload
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('__NEWSROOM_CSP__');
    await expect(page.getByTestId('session-user')).toBeVisible();
    await expect(page.locator('#dash-metrics-container')).toBeVisible();
    await page.goto('./#review');
    await expect(page.locator('.view-title')).toHaveText('Editorial Review Queue');
    expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  });

  test('keyboard shortcuts navigate between views; dev role switcher changes permissions', async ({ page }) => {
    await page.keyboard.press('Alt+2');
    await expect(page.getByTestId('editor-title')).toBeVisible();
    await page.keyboard.press('Alt+3');
    await expect(page.locator('.view-title')).toHaveText('Editorial Review Queue');
    await page.keyboard.press('Alt+1');
    await expect(page.locator('.view-title')).toHaveText('Editorial Newsroom Desk');

    await page.locator('#user-role-select').selectOption({ label: 'Lanre Ogundipe (Editor-in-Chief)' });
    await expect(page.getByTestId('session-user-role')).toHaveAttribute('data-role', 'editor-in-chief');
  });
});
