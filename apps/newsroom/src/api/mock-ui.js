/**
 * DEVELOPMENT-ONLY UI additions for mock mode: role switcher and demo-account helper on the login screen.
 * Only ever loaded via dynamic import() behind `if (MOCK)`; absent from production bundles.
 */
import { formatRoleName, escapeHtml } from '../util.js';

export function installMockUi({ adapter, onSwitch }) {
  const controls = document.querySelector('.masthead-controls');
  if (controls && !document.getElementById('mock-role-picker-wrapper')) {
    const wrap = document.createElement('div');
    wrap.className = 'role-picker';
    wrap.id = 'mock-role-picker-wrapper';
    wrap.innerHTML = `
      <label for="user-role-select">Active Role:</label>
      <select id="user-role-select" class="role-select" aria-label="Switch active newsroom role"></select>`;
    controls.prepend(wrap);
    const select = wrap.querySelector('select');
    select.addEventListener('change', () => {
      adapter.switchMockUser(select.value);
      onSwitch(adapter.getCurrentUser());
    });
  }
  syncMockRolePicker(adapter);
}

export function syncMockRolePicker(adapter) {
  const select = document.getElementById('user-role-select');
  if (!select) return;
  const current = adapter.getCurrentUser();
  select.innerHTML = adapter.getMockUsers().map(u =>
    `<option value="${escapeHtml(u.id)}" ${current && u.id === current.id ? 'selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(formatRoleName(u.role))})</option>`
  ).join('');
}

export function decorateLoginForm(form, adapter) {
  const box = document.createElement('div');
  box.className = 'mock-login-helper';
  box.innerHTML = `
    <div class="mock-login-title">Dev mock accounts</div>
    <div class="mock-login-buttons">
      ${adapter.getMockUsers().map(u => `<button type="button" class="btn btn-outline btn-xs demo-fill-btn" data-email="${escapeHtml(u.email)}">${escapeHtml(formatRoleName(u.role))}</button>`).join('')}
    </div>`;
  form.prepend(box);
  box.querySelectorAll('.demo-fill-btn').forEach(btn => btn.addEventListener('click', () => {
    form.querySelector('#login-email-input').value = btn.getAttribute('data-email');
    form.querySelector('#login-password-input').value = adapter.mockPassword;
  }));
}
