import { mountTurnstile } from '../lib/turnstile.js';
import { CONTACT_TOPICS, NEWSLETTER_SUCCESS, readerEndpoint, newsletterTokenEndpoint, validateReaderForm, postReaderForm } from '../lib/reader-form-contracts.js';
export { captureNewsletterLink } from '../lib/reader-form-contracts.js';
import './reader-forms.css';

export function readerFormConfig(env = import.meta.env) {
  return { newsletter: readerEndpoint(env.VITE_PUBLIC_NEWSLETTER_URL), contact: readerEndpoint(env.VITE_PUBLIC_CONTACT_URL), siteKey: env.VITE_TURNSTILE_SITE_KEY || '' };
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function field(id, name, label, { type = 'text', max = 120, min, optional = false } = {}) {
  return `<div class="reader-field"><label for="${id}-${name}">${label}${optional ? ' (optional)' : ''}</label><input id="${id}-${name}" name="${name}" type="${type}" maxlength="${max}" ${min ? `minlength="${min}"` : ''} autocomplete="${name === 'email' ? 'email' : 'name'}" ${optional ? '' : 'required'} aria-describedby="${id}-${name}-error"><p class="reader-error" id="${id}-${name}-error" hidden></p></div>`;
}
function markup(kind, source, config) {
  const id = `reader-${kind}-${source}`;
  return `<section class="reader-form-section" aria-labelledby="${id}-title"><h2 id="${id}-title">${kind === 'newsletter' ? 'News worth reading, in your inbox.' : 'Write to the newsroom.'}</h2><p>${kind === 'newsletter' ? 'Choose to receive the Church Times Nigeria newsletter. Confirm your email before your subscription begins.' : 'Send a question, correction or enquiry. Your message is private and is not published.'}</p><form data-reader-form="${kind}" data-source="${source}" novalidate><div data-reader-errors tabindex="-1" role="alert" hidden></div><fieldset><legend class="reader-sr-only">${kind === 'newsletter' ? 'Newsletter sign-up' : 'Contact details and message'}</legend>${field(id,'name','Name',{optional:kind==='newsletter',min:2})}${field(id,'email','Email address',{type:'email',max:254})}${kind === 'newsletter' ? `<label class="reader-consent" for="${id}-consent"><input id="${id}-consent" name="consent" type="checkbox" required aria-describedby="${id}-consent-error">I agree to receive the newsletter. I can unsubscribe at any time.</label><p class="reader-error" id="${id}-consent-error" hidden></p>` : `<div class="reader-field"><label for="${id}-topic">Topic</label><select name="topic" id="${id}-topic" aria-describedby="${id}-topic-error">${CONTACT_TOPICS.map(topic=>`<option value="${topic}">${topic[0].toUpperCase()+topic.slice(1)}</option>`).join('')}</select><p class="reader-error" id="${id}-topic-error" hidden></p></div><div class="reader-field"><label for="${id}-message">Message (20 to 5,000 characters)</label><textarea name="message" id="${id}-message" rows="6" minlength="20" maxlength="5000" required aria-describedby="${id}-message-error"></textarea><p class="reader-error" id="${id}-message-error" hidden></p></div>`}<div class="reader-honeypot" aria-hidden="true"><label for="${id}-website">Leave this field empty</label><input id="${id}-website" name="website" tabindex="-1" autocomplete="off"></div></fieldset><div data-reader-verification><p>Spam protection uses Cloudflare Turnstile. It loads only with your permission.</p><button type="button" class="text-button" data-reader-permission>Allow spam protection</button><div data-reader-widget></div><p data-reader-challenge role="status"></p><button type="button" class="text-button" data-reader-retry hidden>Restart verification</button></div><p data-reader-status role="status" tabindex="-1"></p><button class="button button-dark" type="submit">${kind === 'newsletter' ? 'Sign up' : 'Send message'}</button></form></section>`;
}
export function newsletterMarkup(source = 'footer', config = readerFormConfig()) {
  if (!config.newsletter || !config.siteKey) return '';
  return markup('newsletter', ['footer','article','home','other'].includes(source) ? source : 'other', config);
}
export function contactMarkup(config = readerFormConfig()) {
  return config.contact && config.siteKey ? markup('contact','other',config) : '<section class="reader-form-section"><h2>Online sending is unavailable.</h2><p><a href="mailto:info@churchtimesnigeria.net">Email the newsroom</a> to send your enquiry.</p></section>';
}
export function newsletterTokenMarkup(action, token, config = readerFormConfig()) {
  if (!['confirm','unsubscribe'].includes(action)) return '';
  const available = Boolean(newsletterTokenEndpoint(config.newsletter,action) && token);
  // Token stays in the closure supplied to bindReaderForms, never in markup or form attributes.
  return `<section class="container reader-form-section"><h1>${action === 'confirm' ? 'Confirm your newsletter subscription' : 'Unsubscribe from the newsletter'}</h1><p>${available ? 'Nothing changes until you press the button below.' : 'This link is unavailable or no longer valid. Please request a new link.'}</p>${available ? `<form data-reader-token="${escape(action)}"><p data-reader-status role="status" tabindex="-1"></p><button class="button button-dark" type="submit">${action === 'confirm' ? 'Confirm subscription' : 'Unsubscribe'}</button></form>` : ''}</section>`;
}
const messages = {
  'rate-limit':'Too many requests. Please wait before trying again.', unavailable:'Sign-up is unavailable. Please try again later.',
  forbidden:'This service cannot accept requests from this website. Please email the newsroom.', duplicate:'A matching message was already received. Please email the newsroom to add information.',
  size:'Your message is too large. Shorten it and try again.', configuration:'Online sending is unavailable. Please email the newsroom.',
  challenge:'Complete a new spam-protection challenge and try again.', validation:'Please check the form details.',
  'invalid-token':'This link is no longer valid. Please request a new link.', server:'The service is temporarily unavailable. Please try again later.',
  network:'We could not confirm receipt. Your text remains here. Contact the newsroom before resending.', timeout:'The service took too long. Your text remains here. Contact the newsroom before resending.', unconfirmed:'The service did not confirm receipt. Please contact the newsroom before resending.',
};
export function bindReaderForms(root = document, { hasConsent = () => false, requestConsent = () => {}, onConsentChange = () => () => {}, tokenLink = null, config = readerFormConfig() } = {}) {
  const disposers = [];
  for (const form of root.querySelectorAll('[data-reader-form], [data-reader-token]')) {
    const kind = form.dataset.readerForm || form.dataset.readerToken;
    const isToken = Boolean(form.dataset.readerToken);
    const controller = new AbortController();
    const status = form.querySelector('[data-reader-status]');
    const submit = form.querySelector('[type=submit]');
    const originalLabel = submit.textContent;
    let token = '', challenge, disposed = false, pending = false, cooldown = 0, interval, completed = false;
    const notify = text => { status.textContent = text; };
    function updateButton() {
      const seconds = Math.max(0, Math.ceil((cooldown - Date.now()) / 1000));
      submit.disabled = pending || seconds > 0 || completed;
      submit.textContent = pending ? 'Sending…' : seconds ? `Try again in ${seconds}s` : originalLabel;
      if (!seconds && interval) { clearInterval(interval); interval = null; }
    }
    const challengeText = form.querySelector('[data-reader-challenge]');
    const permission = form.querySelector('[data-reader-permission]');
    const retry = form.querySelector('[data-reader-retry]');
    const start = () => {
      if (isToken || disposed || completed) return;
      const consent = hasConsent();
      permission.hidden = consent;
      if (!consent) { token = ''; challenge?.dispose(); challenge = null; retry.hidden = true; challengeText.textContent = 'Allow spam protection before sending.'; return; }
      if (challenge) return;
      const feedback = (text, again = false) => { challengeText.textContent = text; retry.hidden = !again; };
      challenge = mountTurnstile(form.querySelector('[data-reader-widget]'), { siteKey: config.siteKey, action: kind === 'newsletter' ? 'newsletter-subscribe' : 'contact-message',
        onToken: value => { token = value; feedback('Verification complete.'); }, onReady: () => { if (!token) feedback('Complete the spam-protection challenge.'); },
        onExpired: () => { token = ''; feedback('Verification expired. Please restart.', true); }, onError: () => { token = ''; feedback('Verification is unavailable. Please restart or email the newsroom.', true); },
      });
    };
    if (!isToken) { permission.addEventListener('click', requestConsent, { signal: controller.signal }); retry.addEventListener('click', () => { token=''; challenge?.reset(); }, { signal: controller.signal }); start(); disposers.push(onConsentChange(start)); }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending || disposed || completed || Date.now() < cooldown) return;
      const values = isToken ? {} : Object.fromEntries(new FormData(form));
      if (!isToken) { values.consent = form.elements.consent?.checked === true; values.source = form.dataset.source; }
      const errors = isToken ? {} : validateReaderForm(values, kind);
      if (!isToken && (!hasConsent() || !token)) errors.challenge = 'Allow spam protection and complete its challenge before sending.';
      const summary = form.querySelector('[data-reader-errors]');
      if (summary) {
        for (const name of ['name','email','message','topic','consent']) { const input=form.elements.namedItem(name); if (!input) continue; const error = form.querySelector(`#${input.id}-error`); input.setAttribute('aria-invalid',String(Boolean(errors[name]))); error.textContent=errors[name]||''; error.hidden=!errors[name]; }
        summary.textContent = Object.values(errors).join(' '); summary.hidden = !Object.keys(errors).length;
      }
      if (Object.keys(errors).length) { summary.focus(); return; }
      pending = true; updateButton(); form.setAttribute('aria-busy','true');
      const fieldset = form.querySelector('fieldset'); if (fieldset) fieldset.disabled = true;
      notify('Sending…');
      try {
        const endpoint = isToken ? newsletterTokenEndpoint(config.newsletter,kind) : config[kind];
        const receipt = await postReaderForm({ endpoint, kind, values, token: isToken ? (tokenLink?.action === kind ? tokenLink.token : '') : token, signal: controller.signal });
        if (disposed) return;
        completed = true; challenge?.dispose();
        if (!isToken) { form.reset(); fieldset.hidden = true; form.querySelector('[data-reader-verification]').hidden = true; }
        submit.hidden = true;
        notify(kind === 'newsletter' ? NEWSLETTER_SUCCESS : kind === 'contact' ? `Received. We will reply by email. Reference: ${receipt.reference}` : kind === 'confirm' ? 'Your newsletter subscription is confirmed.' : 'You have been unsubscribed.');
        if (isToken && tokenLink) tokenLink.token = '';
        status.focus();
      } catch (error) {
        if (disposed || error.type === 'cancelled') return;
        notify((error.type === 'unavailable' && kind === 'contact' ? 'Online sending is unavailable. Please email the newsroom.' : messages[error.type]) || messages.server);
        if (summary) { summary.textContent = Object.values(error.fields || {}).join(' '); summary.hidden=!summary.textContent; }
        if (error.type === 'rate-limit') { cooldown=Date.now()+error.retryAfter*1000; notify(`${messages['rate-limit']} Try again in ${error.retryAfter} seconds.`); interval=setInterval(updateButton,1000); }
        status.focus();
      } finally {
        token=''; pending=false;
        if (!disposed) { form.setAttribute('aria-busy','false'); if (fieldset) fieldset.disabled=false; updateButton(); if (!completed) challenge?.reset(); }
      }
    }, { signal: controller.signal });
    disposers.push(() => { disposed=true; token=''; clearInterval(interval); controller.abort(); challenge?.dispose(); form.reset(); });
  }
  return () => { for (const dispose of disposers) dispose?.(); };
}
