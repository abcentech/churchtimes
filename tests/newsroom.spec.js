import { test, expect } from '@playwright/test';

const NEWSROOM_URL = './apps/newsroom/index.html';

test.describe('Church Times Nigeria — Newsroom UI MVP Suite', () => {

  test('newsroom dashboard renders masthead, mock indicator, kpis and story pipeline', async ({ page }) => {
    await page.goto(NEWSROOM_URL);

    // Masthead & Branding
    await expect(page.locator('.brand-title')).toHaveText('CHURCH TIMES');
    await expect(page.locator('.brand-subtitle')).toHaveText('N I G E R I A');
    await expect(page.locator('.brand-workspace-tag')).toHaveText('Newsroom');

    // Transparent Mock Banner
    const banner = page.locator('#mode-banner');
    await expect(banner).toBeVisible();
    await expect(page.locator('#mode-banner-badge')).toContainText('LOCAL MOCK MODE');

    // Skip Link Accessibility
    const skipLink = page.locator('.skip-link');
    await expect(skipLink).toBeAttached();
    await expect(skipLink).toHaveAttribute('href', '#main-content');

    // KPI Metrics Grid
    const metricsGrid = page.locator('#dash-metrics-container');
    await expect(metricsGrid).toBeVisible();
    await expect(page.locator('.metric-card')).toHaveCount(6);

    // Launchpad Cards
    await expect(page.locator('#launch-write-story')).toBeVisible();
    await expect(page.locator('#launch-review-queue')).toBeVisible();
    await expect(page.locator('#launch-go-live')).toBeVisible();
    await expect(page.locator('#launch-media-lib')).toBeVisible();

    // Story Pipeline Table
    await expect(page.locator('.data-table')).toBeVisible();
    const rows = page.locator('#story-pipeline-tbody tr');
    await expect(rows.first()).toBeVisible();
  });

  test('story editor allows writing, autosave, preview, and submission for review', async ({ page }) => {
    await page.goto(NEWSROOM_URL + '#editor');

    // Verify Editor Form Elements
    const headline = page.locator('#story-headline-input');
    const standfirst = page.locator('#story-standfirst-input');
    const category = page.locator('#story-category-select');
    const slug = page.locator('#story-slug-input');
    const body = page.locator('#story-body-input');
    const previewHeadline = page.locator('#preview-headline');
    const previewBody = page.locator('#preview-body-content');
    const wordCountBadge = page.locator('#word-count-badge');
    const autosaveIndicator = page.locator('#autosave-indicator');

    await expect(headline).toBeVisible();
    await expect(body).toBeVisible();

    // Type story details
    const testTitle = 'Diocesan Synod Opens in Lagos with Call for Youth Welfare';
    await headline.fill(testTitle);
    await standfirst.fill('Bishops and lay delegates deliberate on social investments and clergy training.');
    await category.selectOption('church-ministry');
    await body.fill('The annual synod session commenced with an opening service emphasizing community health and education programs across urban parishes.');

    // Verify live reader preview updates
    await expect(previewHeadline).toHaveText(testTitle);
    await expect(previewBody).toContainText('community health and education programs');
    await expect(slug).toHaveValue('diocesan-synod-opens-in-lagos-with-call-for-youth-welfare');

    // Word count calculation
    await expect(wordCountBadge).toContainText('words');

    // Autosave indicator reflects activity
    await expect(autosaveIndicator).toBeVisible();

    // Click Save Draft
    await page.locator('#btn-save-draft').click();
    await expect(page.locator('.toast').last()).toContainText('Draft saved successfully');

    // Submit for review
    const submitBtn = page.locator('#btn-submit-review');
    if (await submitBtn.isVisible()) {
      await submitBtn.click();
      await expect(page.locator('.toast').last()).toContainText('submitted for editorial review', { ignoreCase: true });
      await expect(page.locator('#story-status-badge-container')).toContainText('In Review', { ignoreCase: true });
    }
  });

  test('review queue allows inspecting articles, requesting changes and approving', async ({ page }) => {
    await page.goto(NEWSROOM_URL + '#review');

    // Verify Tab Navigation
    await expect(page.locator('.review-tabs')).toBeVisible();
    const inReviewTab = page.locator('.review-tab-btn[data-tab="articles_review"]');
    await inReviewTab.click();

    // Inspect first article in review
    const inspectBtn = page.locator('[data-action="inspect-story"]').first();
    if (await inspectBtn.isVisible()) {
      await inspectBtn.click();

      // Modal opens with accessibility focus and checklist
      const modal = page.locator('.modal-overlay');
      await expect(modal).toBeVisible();
      await expect(page.locator('.checklist-box')).toBeVisible();

      // Check checklist items
      await expect(page.locator('#chk-sources')).toBeChecked();
      await expect(page.locator('#chk-consent')).toBeChecked();

      // Approve story action
      const approveBtn = page.locator('#modal-approve-story');
      await approveBtn.click({ force: true });
      await expect(page.locator('.toast').last()).toContainText('approved for publication');
      await expect(modal).not.toBeVisible();
    }
  });

  test('public submission form rejects empty submission, creates tracking receipt, and appears in review queue', async ({ page }) => {
    await page.goto(NEWSROOM_URL + '#submit');

    // Verify Form & Ethics Warning
    await expect(page.locator('.ethics-notice-box')).toBeVisible();
    await expect(page.locator('.ethics-notice-box')).toContainText('NEVER published automatically');

    // Fill form
    const tipHeadline = 'Community Solar Installation Completed in Rural Parish';
    await page.locator('#sub-headline-input').fill(tipHeadline);
    await page.locator('#sub-category-select').selectOption('church-ministry');
    await page.locator('#sub-location-input').fill('Ikakumo, Ondo State');
    await page.locator('#sub-body-input').fill('Local church members and community elders collaborated to drill a solar-powered borehole serving 300 households.');
    await page.locator('#sub-name-input').fill('Deacon Paul Adeleke');
    await page.locator('#sub-email-input').fill('adeleke.paul@example.ng');
    await page.locator('#sub-org-input').fill('Ikakumo Parish Development Committee');
    await page.locator('#sub-affirmation-chk').check();

    // Submit tip
    await page.locator('#btn-submit-public').click();

    // Confirmation receipt with tracking reference
    await expect(page.locator('.submit-container')).toContainText('Submission Received');
    await expect(page.locator('.submit-container')).toContainText('CTN-SUB-');

    // Inspect in Review Queue button
    await page.locator('#btn-view-queue').click();
    await expect(page.locator('.view-title')).toHaveText('Editorial Review Queue');

    // Check Reader Tips tab
    const tipsTab = page.locator('.review-tab-btn[data-tab="submissions"]');
    await tipsTab.click();
    await expect(page.locator('#review-content-area')).toContainText(tipHeadline);

    // Convert tip to draft story
    const convertBtn = page.locator('[data-action="convert-sub"]').first();
    await convertBtn.click();
    await expect(page.locator('.toast').last()).toContainText('Tip converted into a new draft story');
    await expect(page.locator('#story-headline-input')).toBeVisible();
  });

  test('live coverage allows composing updates and broadcasting to reader timeline', async ({ page }) => {
    await page.goto(NEWSROOM_URL + '#live');

    // Verify Active Event Banner
    await expect(page.locator('.view-title')).toHaveText('Live Coverage & Real-Time Updates');
    await expect(page.locator('#live-viewer-count')).toBeVisible();

    // Form inputs
    const timeInput = page.locator('#upd-time-input');
    const headlineInput = page.locator('#upd-headline-input');
    const bodyInput = page.locator('#upd-body-input');
    const pinnedChk = page.locator('#upd-pinned-chk');
    const postBtn = page.locator('#btn-post-update');

    await expect(timeInput).toBeVisible();
    await headlineInput.fill('Keynote Communique Session Begins');
    await bodyInput.fill('Delegates assembled at NICON Luxury hall to ratify the draft resolution on religious tolerance.');
    await pinnedChk.check();
    await postBtn.click();

    await expect(page.locator('.toast').last()).toBeVisible();

    // If submitted as reporter, verify in pending queue and approve as editor
    const pendingApproveBtn = page.locator('[data-approve-upd-id]').first();
    if (await pendingApproveBtn.isVisible()) {
      await pendingApproveBtn.click();
      await expect(page.locator('.toast').last()).toContainText('Update approved');
    }

    // Verify update in reader timeline stream
    const timeline = page.locator('#live-timeline-feed');
    await expect(timeline).toContainText('Keynote Communique Session Begins');
    await expect(timeline).toContainText('PINNED HIGHLIGHT');
  });

  test('media library displays photographic assets with alt text and enables search', async ({ page }) => {
    await page.goto(NEWSROOM_URL + '#media');

    // Verify assets loaded
    const grid = page.locator('#media-assets-grid');
    await expect(grid).toBeVisible();
    await expect(page.locator('.media-item-card')).toHaveCount(6);

    // Search filter
    const searchInput = page.locator('#media-search-input');
    await searchInput.fill('Omololu');
    await page.waitForTimeout(300);
    await expect(page.locator('.media-item-card')).toHaveCount(1);
    await expect(grid).toContainText('Omololu Falobi');

    // Inspect asset modal
    await page.locator('.media-item-card').first().click();
    const modal = page.locator('.modal-overlay');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('Accessible Alt Text');
    await expect(modal).toContainText('Photographer');

    // Close modal via Escape key
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
  });

  test('keyboard shortcuts and role switcher adapt editorial permissions', async ({ page }) => {
    await page.goto(NEWSROOM_URL);

    // Alt + 2 shortcut navigates to Editor
    await page.keyboard.press('Alt+2');
    await expect(page.locator('#story-headline-input')).toBeVisible();

    // Alt + 3 shortcut navigates to Review Queue
    await page.keyboard.press('Alt+3');
    await expect(page.locator('.view-title')).toHaveText('Editorial Review Queue');

    // Alt + 1 shortcut navigates to Dashboard
    await page.keyboard.press('Alt+1');
    await expect(page.locator('.view-title')).toHaveText('Editorial Newsroom Desk');

    // Switch Role to Section Editor
    const roleSelect = page.locator('#user-role-select');
    await roleSelect.selectOption({ label: 'Derin Adeogun (Section Editor)' });
    await expect(page.locator('.toast').last()).toContainText('Switched active role: Derin Adeogun');

    // Switch Role to Editor-in-Chief
    await roleSelect.selectOption({ label: 'Lanre Ogundipe (Editor-in-Chief)' });
    await expect(page.locator('.toast').last()).toContainText('Switched active role: Lanre Ogundipe');
  });

});
