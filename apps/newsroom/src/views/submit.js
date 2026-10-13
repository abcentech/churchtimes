/**
 * Public Submission Form View for Church Times Nigeria
 * 
 * Accessible, mobile-first interface allowing public readers, citizen witnesses,
 * and church correspondents to submit story tips and reports.
 * 
 * Non-negotiable requirement:
 * Public submissions are NEVER published automatically.
 */

import { apiAdapter } from '../api/adapter.js';
import { store } from '../store.js';
import { showToast } from '../components/toast.js';

export function renderSubmit(container) {
  container.innerHTML = `
    <div class="submit-container" id="submit-form-container">
      <div class="view-header" style="text-align: center; margin-bottom: 1.5rem;">
        <span class="brand-subtitle" style="color: var(--color-clay); font-size: 0.75rem;">Church Times Nigeria</span>
        <h1 class="view-title" style="font-size: 2rem; margin-top: 0.25rem;">Submit News or Story Tip</h1>
        <p class="view-subtitle" style="margin: 0.5rem auto 0 auto;">
          Faith. People. Public life. Share verifiable reports, documentary evidence, or community developments.
        </p>
      </div>

      <!-- Mandatory Editorial Disclaimer Notice -->
      <div class="ethics-notice-box" role="alert">
        <h4>🔒 Public Verification Notice</h4>
        <p>
          Submissions are received directly by our newsroom editors and are <strong>NEVER published automatically</strong>.
          Every report undergoes corroboration, right-of-reply checks, and dignity review before being assigned to a journalist.
        </p>
      </div>

      <!-- Rate Limit Alert Banner -->
      <div class="rate-limit-banner" id="rate-limit-banner" style="display: none;" role="alert">
        <span class="rate-limit-icon">⏳</span>
        <div>
          <h4 style="margin: 0 0 0.25rem 0; color: #991B1B; font-size: 0.9375rem; font-weight: 700;">Rate Limit Active</h4>
          <p style="margin: 0; font-size: 0.8125rem; color: #7F1D1D;">
            You have reached the maximum submission limit. Please wait <strong id="rate-limit-countdown">900</strong> seconds before submitting another story tip.
          </p>
        </div>
      </div>

      <!-- Validation Summary Alert -->
      <div class="validation-summary-alert" id="validation-summary-box" style="display: none;" role="alert">
        <h4 style="margin: 0 0 0.35rem 0; color: #991B1B; font-size: 0.875rem; font-weight: 700;">Please correct the following errors:</h4>
        <ul id="validation-error-list" style="margin: 0; padding-left: 1.25rem; font-size: 0.8125rem; color: #B91C1C;"></ul>
      </div>

      <form id="public-submission-form" novalidate>
        <!-- Story Headline -->
        <div class="form-group" style="margin-bottom: 1.25rem;">
          <label for="sub-headline-input" class="form-label">
            Working Headline / Story Summary <span style="color: #DC2626;">*</span>
          </label>
          <input
            type="text"
            id="sub-headline-input"
            class="form-input"
            placeholder="e.g. Solar borehole project commissioned in Akoko rural parish"
            required
            aria-required="true"
          />
          <span class="form-help">State the core fact or event clearly.</span>
        </div>

        <div class="form-grid-2" style="margin-bottom: 1.25rem;">
          <!-- Category -->
          <div class="form-group">
            <label for="sub-category-select" class="form-label">Relevant Section <span style="color: #DC2626;">*</span></label>
            <select id="sub-category-select" class="form-select" required aria-required="true">
              <option value="faith-society">Faith & Society (Public policy & health)</option>
              <option value="church-ministry">Church & Ministry (Dioceses, parishes, missions)</option>
              <option value="people-purpose">People & Purpose (Profiles & service)</option>
              <option value="business-vocation">Business & Vocation (Work & enterprise)</option>
              <option value="culture-ideas">Culture & Ideas (Theology, arts & books)</option>
            </select>
          </div>

          <!-- Location -->
          <div class="form-group">
            <label for="sub-location-input" class="form-label">Event Location / Town <span style="color: #DC2626;">*</span></label>
            <input
              type="text"
              id="sub-location-input"
              class="form-input"
              placeholder="e.g. Ikakumo, Ondo State"
              required
              aria-required="true"
            />
          </div>
        </div>

        <!-- Full Details -->
        <div class="form-group" style="margin-bottom: 1.25rem;">
          <label for="sub-body-input" class="form-label">
            Full Story Details & Corroborating Facts <span style="color: #DC2626;">*</span>
          </label>
          <textarea
            id="sub-body-input"
            class="form-textarea"
            rows="6"
            placeholder="Describe what occurred, when, who was involved, and any witnesses or documentary records. Please include specific dates and contact details for verification..."
            required
            aria-required="true"
          ></textarea>
        </div>

        <!-- Contributor Details -->
        <div style="background-color: var(--color-parchment-light); border: 1px solid var(--color-rule); border-radius: var(--radius-md); padding: 1.25rem; margin-bottom: 1.5rem;">
          <h3 style="font-family: var(--font-serif); font-size: 1.05rem; color: var(--color-forest); margin-bottom: 0.75rem;">
            Contributor Identity & Confidentiality
          </h3>

          <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
            <input type="checkbox" id="sub-anon-toggle">
            <label for="sub-anon-toggle" style="font-size: 0.875rem; cursor: pointer;">
              Keep my identity confidential from the public (editorial newsroom only)
            </label>
          </div>

          <div class="form-grid-2">
            <div class="form-group">
              <label for="sub-name-input" class="form-label">Your Full Name</label>
              <input type="text" id="sub-name-input" class="form-input" placeholder="e.g. Deacon Olumide Bello" />
            </div>

            <div class="form-group">
              <label for="sub-org-input" class="form-label">Church / Organization</label>
              <input type="text" id="sub-org-input" class="form-input" placeholder="e.g. Community Observer" />
            </div>
          </div>

          <div class="form-grid-2" style="margin-top: 1rem;">
            <div class="form-group">
              <label for="sub-email-input" class="form-label">Email Address</label>
              <input type="email" id="sub-email-input" class="form-input" placeholder="olumide@example.ng" />
            </div>

            <div class="form-group">
              <label for="sub-phone-input" class="form-label">Phone / WhatsApp Number</label>
              <input type="tel" id="sub-phone-input" class="form-input" placeholder="+234 800 000 0000" />
            </div>
          </div>
        </div>

        <!-- Honeypot (Anti-spam) -->
        <div style="display: none;" aria-hidden="true">
          <label for="sub-honeypot">Leave this field blank</label>
          <input type="text" id="sub-honeypot" name="website_url" tabindex="-1" autocomplete="off" />
        </div>

        <!-- Cloudflare Turnstile Challenge -->
        <div class="form-group" style="margin-bottom: 1.5rem;" id="turnstile-wrapper">
          <div style="background-color: var(--color-parchment-light); border: 1px solid var(--color-rule); border-radius: var(--radius-md); padding: 1rem; display: flex; flex-direction: column; gap: 0.5rem;" id="turnstile-box">
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.5rem;">
              <div style="display: flex; align-items: center; gap: 0.5rem;">
                <span style="font-size: 1.25rem;">🛡️</span>
                <div>
                  <div style="font-size: 0.8125rem; font-weight: 700; color: var(--color-ink);">Cloudflare Turnstile Verification</div>
                  <div style="font-size: 0.75rem; color: var(--color-muted);" id="turnstile-status-text">
                    Challenge status: <strong style="color: #059669;" id="turnstile-status-label">Verified (Mock Key)</strong>
                  </div>
                </div>
              </div>
              <div style="display: flex; gap: 0.35rem; align-items: center;">
                <button type="button" class="btn btn-outline btn-xs" id="btn-expire-turnstile" title="Simulate expired challenge">Expire Challenge</button>
                <button type="button" class="btn btn-outline btn-xs" id="btn-reset-turnstile" title="Simulate missing challenge">Reset Challenge</button>
                <button type="button" class="btn btn-outline btn-xs" id="btn-verify-turnstile" title="Simulate verified challenge">Verify</button>
              </div>
            </div>
            <div id="cf-turnstile-widget" class="cf-turnstile" data-sitekey="0x4AAAAAAAxMockTurnstileKey" style="display: none;"></div>
            <input type="hidden" id="cf-turnstile-response" name="cf-turnstile-response" value="mock-turnstile-token-valid" />
            <span class="form-error-msg" id="turnstile-error-msg" style="display: none;"></span>
          </div>
        </div>

        <!-- Affirmation Checkbox -->
        <div class="form-group" style="margin-bottom: 1.5rem;">
          <label style="display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.8125rem; color: var(--color-ink); cursor: pointer;">
            <input type="checkbox" id="sub-affirmation-chk" required aria-required="true" style="margin-top: 0.2rem;" />
            <span>I confirm that this submission is made in good faith and that the facts described are accurate to the best of my knowledge.</span>
          </label>
        </div>

        <!-- Submit Button -->
        <button type="submit" class="btn btn-primary btn-lg" id="btn-submit-public" style="width: 100%;">
          📨 Submit Story Tip to Newsroom
        </button>

        <p style="text-align: center; font-size: 0.75rem; color: var(--color-muted); margin-top: 0.75rem;">
          Protected by rate limits. Your contact information is never shared without explicit consent.
        </p>
      </form>
    </div>
  `;

  const form = container.querySelector('#public-submission-form');
  const turnstileTokenInput = container.querySelector('#cf-turnstile-response');
  const turnstileStatusLabel = container.querySelector('#turnstile-status-label');
  const turnstileBox = container.querySelector('#turnstile-box');
  const turnstileErrorMsg = container.querySelector('#turnstile-error-msg');

  container.querySelector('#btn-expire-turnstile')?.addEventListener('click', () => {
    turnstileTokenInput.value = 'EXPIRED';
    turnstileStatusLabel.textContent = 'Expired (Simulated)';
    turnstileStatusLabel.style.color = '#DC2626';
  });

  container.querySelector('#btn-reset-turnstile')?.addEventListener('click', () => {
    turnstileTokenInput.value = '';
    turnstileStatusLabel.textContent = 'Unverified (Missing Token)';
    turnstileStatusLabel.style.color = '#DC2626';
  });

  container.querySelector('#btn-verify-turnstile')?.addEventListener('click', () => {
    turnstileTokenInput.value = 'mock-turnstile-token-valid';
    turnstileStatusLabel.textContent = 'Verified (Mock Key)';
    turnstileStatusLabel.style.color = '#059669';
    turnstileErrorMsg.style.display = 'none';
    turnstileBox.classList.remove('has-error');
  });

  let rateLimitInterval = null;

  function showRateLimitBanner(seconds) {
    const banner = container.querySelector('#rate-limit-banner');
    const countdownEl = container.querySelector('#rate-limit-countdown');
    if (!banner || !countdownEl) return;

    banner.style.display = 'flex';
    let remaining = seconds;
    countdownEl.textContent = remaining;

    if (rateLimitInterval) clearInterval(rateLimitInterval);
    rateLimitInterval = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(rateLimitInterval);
        banner.style.display = 'none';
      } else {
        countdownEl.textContent = remaining;
      }
    }, 1000);
  }

  function showValidationErrors(errors) {
    const summaryBox = container.querySelector('#validation-summary-box');
    const errorList = container.querySelector('#validation-error-list');
    if (!summaryBox || !errorList) return;

    errorList.innerHTML = errors.map(e => `<li>${escapeHtml(e.message)}</li>`).join('');
    summaryBox.style.display = 'block';

    errors.forEach(err => {
      if (err.field === 'turnstile') {
        turnstileBox.classList.add('has-error');
        turnstileErrorMsg.textContent = err.message;
        turnstileErrorMsg.style.display = 'block';
      }
    });

    summaryBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function clearErrors() {
    const summaryBox = container.querySelector('#validation-summary-box');
    if (summaryBox) summaryBox.style.display = 'none';
    turnstileBox?.classList.remove('has-error');
    if (turnstileErrorMsg) turnstileErrorMsg.style.display = 'none';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const headline = container.querySelector('#sub-headline-input').value.trim();
    const category = container.querySelector('#sub-category-select').value;
    const location = container.querySelector('#sub-location-input').value.trim();
    const body = container.querySelector('#sub-body-input').value.trim();
    const isAnon = container.querySelector('#sub-anon-toggle').checked;
    const name = isAnon ? 'Anonymous Contributor' : (container.querySelector('#sub-name-input').value.trim() || 'Community Contributor');
    const org = container.querySelector('#sub-org-input').value.trim() || 'Independent';
    const email = container.querySelector('#sub-email-input').value.trim() || 'Not provided';
    const phone = container.querySelector('#sub-phone-input').value.trim() || '';
    const honeypot = container.querySelector('#sub-honeypot').value;
    const affirmed = container.querySelector('#sub-affirmation-chk').checked;
    const turnstileToken = turnstileTokenInput ? turnstileTokenInput.value : 'mock-turnstile-token-valid';

    const clientErrors = [];
    if (!headline) clientErrors.push({ field: 'headline', message: 'Working Headline is required.' });
    if (!location) clientErrors.push({ field: 'location', message: 'Event Location is required.' });
    if (!body) clientErrors.push({ field: 'body', message: 'Full Story Details are required.' });
    if (!affirmed) clientErrors.push({ field: 'affirmation', message: 'Please confirm the accuracy affirmation checkbox.' });

    if (clientErrors.length > 0) {
      showValidationErrors(clientErrors);
      return;
    }

    const payload = {
      headline,
      title: headline,
      category,
      location,
      body,
      submitterName: name,
      name,
      organization: org,
      submitterEmail: email,
      email,
      submitterPhone: phone,
      phone,
      honeypot,
      turnstileToken
    };

    const submitBtn = container.querySelector('#btn-submit-public');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting to newsroom...';

    try {
      const res = await apiAdapter.createPublicSubmission(payload);
      renderSuccessReceipt(container, res.data || payload);
      showToast('Story tip received by Church Times newsroom!', 'success');
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = '📨 Submit Story Tip to Newsroom';

      if (err.name === 'ApiRateLimitError') {
        showRateLimitBanner(err.retryAfter || 900);
      } else if (err.name === 'ApiValidationError' && err.errors) {
        showValidationErrors(err.errors);
      } else {
        showValidationErrors([{ field: 'general', message: err.message }]);
      }
    }
  });
}

function renderSuccessReceipt(container, submission) {
  container.innerHTML = `
    <div class="submit-container" style="text-align: center; padding: 3rem 2rem;">
      <div style="font-size: 3.5rem; margin-bottom: 1rem;">✅</div>
      <h1 class="view-title" style="margin-bottom: 0.5rem;">Submission Received</h1>
      <p style="color: var(--color-muted); font-size: 1rem; max-width: 500px; margin: 0 auto 1.5rem auto;">
        Thank you for contributing to independent Nigerian journalism. Your story tip has been placed in the editorial review queue.
      </p>

      <div style="background-color: var(--color-parchment-light); border: 2px dashed var(--color-rule); border-radius: var(--radius-md); padding: 1.25rem; max-width: 480px; margin: 0 auto 2rem auto; text-align: left;">
        <div style="font-size: 0.75rem; text-transform: uppercase; color: var(--color-muted); font-weight: 700;">Submission Reference ID</div>
        <div style="font-family: var(--font-mono); font-size: 1.25rem; font-weight: 700; color: var(--color-forest); margin: 0.25rem 0 0.75rem 0;">
          CTN-SUB-${submission.id || 'CONFIRMED'}
        </div>
        <div style="font-size: 0.8125rem; color: var(--color-ink-light);">
          <strong>Headline:</strong> ${escapeHtml(submission.headline)}<br>
          <strong>Status:</strong> <span class="badge badge-in_review">PENDING EDITORIAL REVIEW</span><br>
          <strong>Submitted:</strong> ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} WAT
        </div>
      </div>

      <div style="display: flex; justify-content: center; gap: 1rem; flex-wrap: wrap;">
        <button type="button" class="btn btn-secondary" id="btn-submit-another">
          Submit Another Tip
        </button>
        <button type="button" class="btn btn-primary" id="btn-view-queue">
          Inspect in Review Queue →
        </button>
      </div>
    </div>
  `;

  container.querySelector('#btn-submit-another').addEventListener('click', () => {
    renderSubmit(container);
  });

  container.querySelector('#btn-view-queue').addEventListener('click', () => {
    store.setCurrentView('review');
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
