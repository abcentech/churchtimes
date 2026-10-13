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
  form.addEventListener('submit', async (e) => {
    e.preventDefault();

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

    if (!headline || !body || !location) {
      alert('Please fill out all required fields marked with *');
      return;
    }
    if (!affirmed) {
      alert('Please confirm the accuracy affirmation checkbox.');
      return;
    }

    const payload = {
      headline,
      category,
      location,
      body,
      submitterName: name,
      organization: org,
      submitterEmail: email,
      submitterPhone: phone,
      honeypot
    };

    const submitBtn = container.querySelector('#btn-submit-public');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting to newsroom...';

    try {
      const res = await apiAdapter.createPublicSubmission(payload);
      renderSuccessReceipt(container, res.data);
      showToast('Story tip received by Church Times newsroom!', 'success');
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = '📨 Submit Story Tip to Newsroom';
      alert(`Submission error: ${err.message}`);
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
