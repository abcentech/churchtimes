// Give page (lazy chunk): one-time gifts through Paystack's hosted checkout. Card, bank-transfer and USSD details are
// entered on Paystack's page, never here. This module only sends the reader's choices to the CMS, which creates the
// donation, and later asks the CMS (never the browser) whether the payment was confirmed.
import { mountTurnstile } from '../../lib/turnstile.js';
import { hasConsent, requestConsent, subscribeConsent } from '../../lib/reader-consent.js';
import { givingEndpointFrom } from './endpoint.js';
import { formatMinor, majorToMinor, returnReference, safeCheckoutUrl } from './money.js';
import './give.css';

const STORE_KEY = 'ct-give-reference';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const para = text => esc(text).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
const givingEndpoint = () => givingEndpointFrom(import.meta.env.VITE_PUBLIC_GIVING_URL);

async function getJSON(url, signal) {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit', signal });
  const data = await response.json().catch(() => null);
  return { response, data };
}

const PRIVACY = 'We use your email address to send your receipt and, if needed, to contact you about this gift. Your name is optional and is not stored if you give anonymously. Paystack processes the payment under its own privacy terms; we never see or store your card details. We keep donation records for as long as the law requires for financial records, then delete the personal details.';

function formMarkup(settings, siteKeyReady) {
  const [first] = settings.currencies;
  const multi = settings.currencies.length > 1;
  return `<section class="give-intro"><span class="eyebrow">SUPPORT OUR JOURNALISM</span><h1 id="give-title">Keep independent reporting free to read.</h1><p>Church Times Nigeria is reader-supported. A one-time gift helps us report on the church and public life with care and independence.</p>${settings.testMode ? '<p class="give-test" role="note"><strong>Test mode.</strong> No real money will be taken.</p>' : ''}</section>
  <form class="give-form" novalidate data-give-form aria-labelledby="give-title">
    <div class="give-errors" data-give-errors tabindex="-1" role="alert" hidden></div>
    ${multi ? `<div class="give-field"><label for="give-currency">Currency</label><select id="give-currency" name="currency">${settings.currencies.map(c => `<option value="${esc(c.currency)}">${esc(c.label)} (${esc(c.currency)})</option>`).join('')}</select><p class="give-hint">Giving from abroad? Choose your currency here, or give in naira with any international card.</p></div>` : `<input type="hidden" name="currency" value="${esc(first.currency)}">`}
    <fieldset class="give-amounts" aria-describedby="give-amount-error"><legend>Choose an amount</legend><div class="give-presets" data-give-presets></div>
      <div class="give-field give-other"><label for="give-amount">Other amount (<span data-give-symbol></span>)</label><input id="give-amount" name="amount" inputmode="decimal" autocomplete="off" aria-describedby="give-range give-amount-error"><p class="give-hint" id="give-range" data-give-range></p></div>
      <p class="give-error" id="give-amount-error" hidden></p></fieldset>
    ${settings.causes.length > 1 ? `<fieldset class="give-causes"><legend>Where should it go?</legend>${settings.causes.map((c, i) => `<label class="give-choice"><input type="radio" name="cause" value="${esc(c.key)}" ${i ? '' : 'checked'}> ${esc(c.label)}</label>`).join('')}</fieldset>` : `<input type="hidden" name="cause" value="${esc(settings.causes[0]?.key || 'general')}">`}
    <fieldset class="give-details"><legend>Your details</legend>
      <div class="give-field"><label for="give-email">Email address (for your receipt)</label><input id="give-email" name="email" type="email" autocomplete="email" maxlength="254" required aria-describedby="give-email-error"><p class="give-error" id="give-email-error" hidden></p></div>
      <div class="give-field" data-give-name><label for="give-name">Name (optional)</label><input id="give-name" name="name" autocomplete="name" maxlength="100" aria-describedby="give-name-error"><p class="give-error" id="give-name-error" hidden></p></div>
      <label class="give-choice"><input type="checkbox" name="anonymous"> Give anonymously (we will not store your name)</label>
    </fieldset>
    <div class="give-notice"><h2>How we use your details</h2><p>${esc(PRIVACY)}</p><p><button type="button" class="text-button" data-give-privacy>Read our privacy notice</button></p></div>
    <label class="give-choice give-consent" for="give-consent"><input id="give-consent" name="consent" type="checkbox" required aria-describedby="give-consent-error"> I agree that Church Times Nigeria may use my details as described above for this gift.</label><p class="give-error" id="give-consent-error" hidden></p>
    <div class="give-honeypot" aria-hidden="true"><label for="give-website">Leave this field empty</label><input id="give-website" name="website" tabindex="-1" autocomplete="off"></div>
    ${siteKeyReady ? `<div class="give-verify" data-give-verify><p>Spam protection uses Cloudflare Turnstile. It loads only with your permission.</p><button type="button" class="text-button" data-give-permission>Allow spam protection</button><div data-give-widget></div><p data-give-challenge role="status"></p></div>` : ''}
    <p class="give-status" data-give-status role="status" tabindex="-1"></p>
    <button class="button button-dark give-submit" type="submit">Continue to secure payment</button>
    <p class="give-hint">You will pay on Paystack's secure page by card, bank transfer or USSD.</p>
  </form>
  ${settings.bankTransferNote ? `<section class="give-note"><h2>Other ways to give</h2>${para(settings.bankTransferNote)}</section>` : ''}`;
}

function bindForm(root, { endpoint, settings, siteKey, signal }) {
  const form = root.querySelector('[data-give-form]');
  const $ = selector => form.querySelector(selector);
  const status = $('[data-give-status]');
  const submit = $('.give-submit');
  const amountInput = $('#give-amount');
  let token = '', challenge = null, pending = false;
  const option = () => settings.currencies.find(c => c.currency === form.elements.currency.value) || settings.currencies[0];

  function drawPresets() {
    const o = option();
    $('[data-give-presets]').innerHTML = o.presets.map((p, i) => `<label class="give-preset"><input type="radio" name="preset" value="${p}" ${i === Math.min(1, o.presets.length - 1) ? 'checked' : ''}><span>${esc(formatMinor(p, o.currency))}</span></label>`).join('') + (o.presets.length ? '<label class="give-preset"><input type="radio" name="preset" value="other"><span>Other</span></label>' : '');
    $('[data-give-symbol]').textContent = o.currency;
    $('[data-give-range]').textContent = `Between ${formatMinor(o.minimumMinor, o.currency)} and ${formatMinor(o.maximumMinor, o.currency)}.`;
    $('.give-other').hidden = o.presets.length > 0;
    amountInput.value = '';
  }
  drawPresets();
  form.elements.currency.addEventListener?.('change', drawPresets, { signal });
  form.addEventListener('change', event => {
    if (event.target.name === 'preset') { $('.give-other').hidden = event.target.value !== 'other'; if (event.target.value === 'other') amountInput.focus(); }
    if (event.target.name === 'anonymous') { const name = $('[data-give-name]'); name.hidden = event.target.checked; if (event.target.checked) form.elements.name.value = ''; }
  }, { signal });

  const verify = $('[data-give-verify]');
  const startChallenge = () => {
    // The SPA replaces the page without calling the disposer: a detached form must not start a challenge.
    if (!verify || signal.aborted || !form.isConnected) return;
    const consent = hasConsent('forms');
    $('[data-give-permission]').hidden = consent;
    const text = $('[data-give-challenge]');
    if (!consent) { token = ''; challenge?.dispose(); challenge = null; text.textContent = 'Allow spam protection before continuing.'; return; }
    if (challenge) return;
    challenge = mountTurnstile($('[data-give-widget]'), { siteKey, action: 'giving-init',
      onToken: value => { token = value; text.textContent = 'Verification complete.'; },
      onReady: () => { if (!token) text.textContent = 'Complete the spam-protection challenge.'; },
      onExpired: () => { token = ''; text.textContent = 'Verification expired. It will restart.'; challenge?.reset(); },
      onError: () => { token = ''; text.textContent = 'Verification is unavailable. Please try again later.'; } });
  };
  $('[data-give-privacy]').addEventListener('click', requestConsent, { signal });
  if (verify) { $('[data-give-permission]').addEventListener('click', requestConsent, { signal }); startChallenge(); const off = subscribeConsent(startChallenge); signal.addEventListener('abort', () => { off(); challenge?.dispose(); }); }

  const showErrors = errors => {
    for (const name of ['amount', 'email', 'name', 'consent']) {
      const el = $(`#give-${name}-error`); if (!el) continue;
      el.textContent = errors[name] || ''; el.hidden = !errors[name];
      const input = name === 'amount' ? amountInput : form.elements[name];
      input?.setAttribute('aria-invalid', String(Boolean(errors[name])));
    }
    const summary = $('[data-give-errors]');
    summary.textContent = Object.values(errors).join(' ');
    summary.hidden = !summary.textContent;
    if (summary.textContent) summary.focus();
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const o = option();
    const preset = form.elements.preset?.value;
    const amountMinor = preset && preset !== 'other' ? Number(preset) : majorToMinor(amountInput.value);
    const email = form.elements.email.value.trim();
    const anonymous = form.elements.anonymous.checked;
    const errors = {};
    if (!amountMinor) errors.amount = 'Enter an amount, for example 5000 or 5000.50.';
    else if (amountMinor < o.minimumMinor || amountMinor > o.maximumMinor) errors.amount = `Choose an amount between ${formatMinor(o.minimumMinor, o.currency)} and ${formatMinor(o.maximumMinor, o.currency)}.`;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) errors.email = 'Enter a valid email address for your receipt.';
    if (!form.elements.consent.checked) errors.consent = 'Please agree to how we use your details before continuing.';
    if (verify && (!hasConsent('forms') || !token)) errors.challenge = 'Allow spam protection and complete its challenge before continuing.';
    showErrors(errors);
    if (Object.keys(errors).length) return;

    pending = true; submit.disabled = true; form.setAttribute('aria-busy', 'true');
    status.textContent = 'Preparing your secure payment…';
    try {
      const body = { amountMinor, currency: o.currency, cause: form.elements.cause.value, email, anonymous, consent: true, website: form.elements.website.value, ...(anonymous || !form.elements.name.value.trim() ? {} : { name: form.elements.name.value.trim() }), ...(token ? { turnstileToken: token } : {}) };
      const response = await fetch(`${endpoint}/init`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, credentials: 'omit', body: JSON.stringify(body), signal });
      const data = await response.json().catch(() => null);
      const checkout = response.status === 201 && data?.ok === true ? safeCheckoutUrl(data.checkoutUrl) : null;
      if (!checkout || !/^CTG-[0-9a-f]{32}$/.test(data.reference || '')) {
        const fieldErrors = {};
        for (const e of Array.isArray(data?.errors) ? data.errors : []) if (e?.field === 'amountMinor') fieldErrors.amount = 'Please check the amount.'; else if (['email', 'name', 'consent'].includes(e?.field)) fieldErrors[e.field] = 'Please check this field.';
        if (Object.keys(fieldErrors).length) showErrors(fieldErrors);
        status.textContent = response.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : response.status === 404 ? 'Online giving is not available right now.' : data?.errors?.some?.(e => e?.field === 'turnstileToken') ? 'Please complete a new spam-protection challenge and try again.' : response.status >= 500 ? 'We could not reach the payment service. Nothing was charged. Please try again.' : 'We could not start this payment. Please check your details.';
        status.focus();
        return;
      }
      try { sessionStorage.setItem(STORE_KEY, data.reference); } catch {}
      status.textContent = 'Taking you to Paystack…';
      location.assign(checkout);
    } catch (error) {
      if (signal.aborted) return;
      status.textContent = 'We could not reach the giving service. Nothing was charged. Please check your connection and try again.';
      status.focus();
    } finally {
      pending = false; token = ''; challenge?.reset?.();
      if (!signal.aborted) { submit.disabled = false; form.setAttribute('aria-busy', 'false'); }
    }
  }, { signal });
}

const RESULT = {
  succeeded: ['Thank you. Your gift was received.', 'Your payment is confirmed. A receipt is on its way to your email address.'],
  pending: ['We are confirming your payment…', 'This usually takes a few seconds. Bank transfers and USSD can take a few minutes.'],
  failed: ['The payment did not go through.', 'Nothing was taken. You can try again with another method.'],
  abandoned: ['The payment was not completed.', 'Nothing was taken. You can start again whenever you are ready.'],
};

async function showResult(root, { endpoint, settings, signal }) {
  let stored = null;
  try { stored = sessionStorage.getItem(STORE_KEY); } catch {}
  const reference = returnReference(location.search, stored);
  // Keep the reference out of history, bookmarks and shared links once read; this tab still has it.
  if (reference) { try { sessionStorage.setItem(STORE_KEY, reference); } catch {} if (location.search) history.replaceState(history.state, '', location.pathname + location.hash); }
  root.innerHTML = `<section class="give-result" aria-live="polite"><span class="eyebrow">SUPPORT OUR JOURNALISM</span><h1 tabindex="-1" data-give-heading>${reference ? RESULT.pending[0] : 'We could not find your payment.'}</h1><p data-give-detail>${reference ? RESULT.pending[1] : 'If you were charged, email the newsroom and we will help.'}</p>${reference ? `<p class="give-ref">Reference: <code>${esc(reference)}</code></p>` : ''}<p><a class="button button-dark" href="give/">Back to the Give page</a></p></section>`;
  if (!reference) return;
  const heading = root.querySelector('[data-give-heading]');
  const detail = root.querySelector('[data-give-detail]');
  const delays = [0, 2000, 3000, 5000, 8000, 13000, 21000];
  for (const wait of delays) {
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    if (signal.aborted || !root.isConnected) return;
    let result;
    try { result = await getJSON(`${endpoint}/status?reference=${encodeURIComponent(reference)}`, signal); } catch { continue; }
    const { response, data } = result;
    if (response.status === 404 || response.status === 400) { heading.textContent = 'We could not find this payment.'; detail.textContent = 'If you were charged, email the newsroom with the reference above.'; return; }
    if (!response.ok || data?.ok !== true || data.reference !== reference) continue;
    const state = RESULT[data.status] ? data.status : 'pending';
    if (state === 'pending' && !data.expired) continue;
    if (state === 'succeeded') { try { sessionStorage.removeItem(STORE_KEY); } catch {} }
    heading.textContent = state === 'pending' ? 'We have not received confirmation yet.' : RESULT[state][0];
    detail.textContent = state === 'pending' ? 'If you completed the payment, your receipt will arrive by email once it is confirmed. If not, contact the newsroom with the reference above.' : state === 'succeeded' && Number.isSafeInteger(data.amountMinor) ? `${formatMinor(data.amountMinor, data.currency)} — ${RESULT.succeeded[1]}${settings?.thankYouNote ? ' ' + settings.thankYouNote : ''}` : RESULT[state][1];
    heading.focus();
    return;
  }
  heading.textContent = 'We are still waiting for confirmation.';
  detail.textContent = 'You do not need to pay again. Your receipt will arrive by email once the payment is confirmed. Contact the newsroom with the reference above if it does not.';
}

/** Mount the Give page (or its return page) into `root`. Returns a disposer. */
export function mountGive(root, { thanks = false } = {}) {
  const controller = new AbortController();
  const { signal } = controller;
  const endpoint = givingEndpoint();
  const unavailable = () => { root.innerHTML = '<section class="give-result"><h1>Online giving is not available right now.</h1><p>Thank you for thinking of us. Please try again later or contact the newsroom.</p></section>'; };
  if (!endpoint) { unavailable(); return () => controller.abort(); }
  getJSON(`${endpoint}/settings`, signal).then(({ response, data }) => {
    if (signal.aborted || !root.isConnected) return;
    const enabled = response.ok && data?.enabled === true && Array.isArray(data.currencies) && data.currencies.length;
    if (thanks) return showResult(root, { endpoint, settings: enabled ? data : null, signal });
    if (!enabled) return unavailable();
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || '';
    // The CMS requires a Turnstile token for every gift: without a site key the form could never succeed.
    if (!siteKey) return unavailable();
    root.innerHTML = formMarkup(data, true);
    bindForm(root, { endpoint, settings: data, siteKey, signal });
  }).catch(() => { if (!signal.aborted && root.isConnected) (thanks ? showResult(root, { endpoint, settings: null, signal }) : unavailable()); });
  return () => controller.abort();
}
