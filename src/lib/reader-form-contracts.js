import { submissionEndpoint } from './public-submissions.js';

export const NEWSLETTER_SUCCESS = 'If this address can be subscribed, we sent a confirmation email.';
export const CONTACT_TOPICS = ['general', 'advertising', 'corrections', 'tips', 'other'];
export class ReaderFormError extends Error {
  constructor(type, { fields = {}, retryAfter = 0 } = {}) { super(type); Object.assign(this, { type, fields, retryAfter }); }
}
export function readerEndpoint(value) {
  const endpoint = submissionEndpoint({ storyUrl: value });
  if (!endpoint) return '';
  const url = new URL(endpoint);
  return url.search || url.hash ? '' : url.href;
}
export function newsletterTokenEndpoint(subscribe, action) {
  if (!['confirm','unsubscribe'].includes(action)) return '';
  const endpoint = readerEndpoint(subscribe);
  if (!endpoint || !endpoint.endsWith('/subscribe')) return '';
  return endpoint.slice(0, -9) + action;
}
export function boundedRetryAfter(value, now = Date.now()) {
  const delay = /^\d+$/.test(value || '') ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isFinite(delay) && delay > 0 ? Math.min(86400, delay) : 60;
}
export function validateReaderForm(values, kind) {
  const errors = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email?.trim() || '') || values.email.trim().length > 254) errors.email = 'Enter a valid email address.';
  const name = values.name?.trim() || '';
  if ((kind === 'contact' || name) && (name.length < 2 || name.length > 120)) errors.name = 'Use 2 to 120 characters for your name.';
  if (kind === 'newsletter') {
    if (values.consent !== true) errors.consent = 'Agree to receive the newsletter before signing up.';
  } else {
    if (!CONTACT_TOPICS.includes(values.topic)) errors.topic = 'Choose a topic.';
    if ((values.message?.trim().length || 0) < 20 || values.message.trim().length > 5000) errors.message = 'Use 20 to 5,000 characters for your message.';
  }
  return errors;
}
export async function postReaderForm({ endpoint, kind, values = {}, token = '', signal, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!readerEndpoint(endpoint)) throw new ReaderFormError('configuration');
  const tokenAction = kind === 'confirm' || kind === 'unsubscribe';
  if (typeof token !== 'string' || !token || token.length > (tokenAction ? 4096 : 2048)) throw new ReaderFormError(tokenAction ? 'invalid-token' : 'challenge');
  const fields = tokenAction ? {} : validateReaderForm(values, kind);
  if (Object.keys(fields).length) throw new ReaderFormError('validation', { fields });
  const body = tokenAction ? { token } : kind === 'newsletter'
    ? { email: values.email.trim().toLowerCase(), ...(values.name?.trim() ? { name: values.name.trim() } : {}), consent: true, source: ['footer','article','home','other'].includes(values.source) ? values.source : 'other', website: values.website || '', turnstileToken: token }
    : { name: values.name.trim(), email: values.email.trim(), topic: values.topic, message: values.message.trim(), website: values.website || '', turnstileToken: token };
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).length > (kind === 'contact' ? 16384 : 8192)) throw new ReaderFormError('size');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new ReaderFormError('cancelled');
    const response = await fetchImpl(endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: encoded, signal: controller.signal });
    if (response.status === 429) throw new ReaderFormError('rate-limit', { retryAfter: boundedRetryAfter(response.headers.get('Retry-After')) });
    let data;
    try { data = await response.json(); } catch { data = null; }
    const backendErrors = Array.isArray(data?.errors) ? data.errors : [];
    if ([400,403,422].includes(response.status) && backendErrors.some(error => error?.field === 'turnstileToken')) throw new ReaderFormError('challenge');
    if (response.status === 400 || response.status === 422) {
      if (tokenAction) throw new ReaderFormError('invalid-token');
      const errors = {};
      for (const error of backendErrors) if (['name','email','message','topic','consent'].includes(error?.field)) errors[error.field] = 'Please check this field and try again.';
      throw new ReaderFormError('validation', { fields: errors });
    }
    const errors = { 403: 'forbidden', 409: 'duplicate', 413: 'size', 415: 'configuration', 503: 'unavailable' };
    if (errors[response.status]) throw new ReaderFormError(errors[response.status]);
    if (!response.ok) throw new ReaderFormError('server');
    const expected = tokenAction ? 200 : kind === 'newsletter' ? 202 : 201;
    if (response.status !== expected || data?.ok !== true || (kind === 'contact' && !/^MSG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(data.reference || ''))) throw new ReaderFormError('unconfirmed');
    return kind === 'contact' ? { reference: data.reference } : { ok: true };
  } catch (error) {
    if (error instanceof ReaderFormError) throw error;
    throw new ReaderFormError(signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export { captureNewsletterLink } from './reader-newsletter-link.js';
