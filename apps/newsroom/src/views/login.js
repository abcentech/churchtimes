/**
 * Staff sign-in screen. This is the only view reachable without a server-verified session.
 * Credentials go straight to POST /api/users/login (credentials:'include'); the password is never stored and the
 * JWT returned in the response body is ignored (the HttpOnly cookie is the session).
 */

import { api, getDevUi } from '../api/index.js';

export function renderLogin(container, { notice = '', onSuccess } = {}) {
  container.innerHTML = `
    <section class="login-view" data-testid="login-view" aria-labelledby="login-heading">
      <div class="card login-card">
        <h1 id="login-heading" class="view-title" style="font-size: 1.5rem;">Staff sign-in</h1>
        <p class="view-subtitle" style="margin-bottom: 1rem;">Church Times Nigeria newsroom. Accredited journalists and editors only.</p>

        <div class="ethics-notice-box login-notice" id="login-notice" data-testid="login-notice" role="status" style="display:none; margin-bottom: 1rem;"></div>
        <div class="validation-summary-alert" id="login-error-alert" data-testid="login-error" style="display: none; margin-bottom: 1rem;" role="alert">
          <span id="login-error-msg"></span>
        </div>

        <form id="staff-login-form" data-testid="login-form" novalidate>
          <div class="form-group" style="margin-bottom: 1rem;">
            <label for="login-email-input" class="form-label">Email address</label>
            <input type="email" id="login-email-input" data-testid="login-email" class="form-input" required autocomplete="username" />
          </div>
          <div class="form-group" style="margin-bottom: 1.25rem;">
            <label for="login-password-input" class="form-label">Password</label>
            <input type="password" id="login-password-input" data-testid="login-password" class="form-input" required autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary" id="btn-submit-login" data-testid="login-submit" style="width: 100%;">Sign in</button>
        </form>
      </div>
    </section>
  `;

  const form = container.querySelector('#staff-login-form');
  const emailInput = container.querySelector('#login-email-input');
  const passwordInput = container.querySelector('#login-password-input');
  const errorAlert = container.querySelector('#login-error-alert');
  const errorMsg = container.querySelector('#login-error-msg');
  const submitBtn = container.querySelector('#btn-submit-login');
  const noticeEl = container.querySelector('#login-notice');

  if (notice) {
    noticeEl.textContent = notice;
    noticeEl.style.display = 'block';
  }

  const devUi = getDevUi();
  if (devUi) devUi.decorateLoginForm(form, api);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errorAlert.style.display = 'none';
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      errorMsg.textContent = 'Please enter both email and password.';
      errorAlert.style.display = 'block';
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';
    try {
      const user = await api.login({ email, password });
      passwordInput.value = '';
      await onSuccess(user);
    } catch (err) {
      errorMsg.textContent = err.message; // server message, rendered as text
      errorAlert.style.display = 'block';
      passwordInput.value = '';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
    }
  });

  emailInput.focus();
}
