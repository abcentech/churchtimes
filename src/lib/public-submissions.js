// Public-only transport. Backend fields are provisional and documented in
// docs/public-forms.md. No authentication or secret verification belongs here.
export const STORY_CATEGORIES = ['News', 'Features', 'Interviews', 'Business', 'Health & education', 'Opinion', 'Other'];
export const FIELD_LIMITS = { name: 100, email: 254, title: 180, message: 12000 };

export function validateSubmission(values, kind = 'story') {
  const errors = {};
  if (!values.name?.trim()) errors.name = 'Enter your name.';
  else if (values.name.trim().length > FIELD_LIMITS.name) errors.name = 'Use no more than 100 characters for your name.';
  if (!values.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) || values.email.trim().length > FIELD_LIMITS.email) errors.email = 'Enter a valid email address so the newsroom can reply.';
  if (!values.title?.trim()) errors.title = kind === 'story' ? 'Enter a headline or a short description of your story.' : 'Enter a subject for your message.';
  else if (values.title.trim().length > FIELD_LIMITS.title) errors.title = 'Use no more than 180 characters.';
  if (!values.message?.trim()) errors.message = kind === 'story' ? 'Tell us about your story.' : 'Enter your message.';
  else if (values.message.trim().length > FIELD_LIMITS.message) errors.message = 'Use no more than 12,000 characters.';
  if (kind === 'story' && !STORY_CATEGORIES.includes(values.category)) errors.category = 'Choose the section that best fits your story.';
  if (values.consent !== true) errors.consent = 'Confirm that the newsroom may use these details to review and reply.';
  return errors;
}

export function submissionEndpoint({ kind = 'story', cmsUrl, storyUrl, contactUrl } = {}) {
  try {
    const value = kind === 'contact' ? contactUrl : storyUrl || (cmsUrl ? new URL('/api/public/submissions', cmsUrl).href : '');
    if (!value) return '';
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    // HTTPS is required outside loopback development; never post personal data
    // over an unencrypted connection to a remote host.
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return '';
    return url.href;
  } catch { return ''; }
}

export function submissionPayload(values, token, kind = 'story') {
  const shared = { name: values.name.trim(), email: values.email.trim(), consent: values.consent === true, turnstileToken: token };
  return kind === 'contact'
    ? { ...shared, subject: values.title.trim(), message: values.message.trim() }
    : { ...shared, title: values.title.trim(), category: values.category, body: values.message.trim() };
}

export class SubmissionError extends Error {
  constructor(type, { fields = {}, retryAfter = 0 } = {}) {
    super(type);
    this.type = type;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}
function retryDelay(value) {
  if (!value) return 60;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  return Number.isFinite(seconds) ? Math.max(1, seconds) : 60;
}
export async function sendPublicSubmission({ endpoint, values, token, kind = 'story', signal, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!submissionEndpoint({ storyUrl: endpoint }) || !token) throw new SubmissionError('configuration');
  const validation = validateSubmission(values, kind);
  if (Object.keys(validation).length) throw new SubmissionError('validation', { fields: validation });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(submissionPayload(values, token, kind)), signal: controller.signal,
    });
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (response.status === 429) throw new SubmissionError('rate-limit', { retryAfter: retryDelay(response.headers.get('Retry-After')) });
    if (['TURNSTILE_INVALID', 'TURNSTILE_EXPIRED'].includes(result?.code)) throw new SubmissionError('challenge');
    if (response.status === 400 || response.status === 422) {
      const fields = {};
      // Translate known backend field names; never echo raw backend messages.
      const mapping = { name:'name', email:'email', title:'title', subject:'title', body:'message', message:'message', category:'category', consent:'consent' };
      for (const key of Object.keys(result?.errors || {})) {
        if (mapping[key]) fields[mapping[key]] = 'Please check this field and try again.';
      }
      throw new SubmissionError('validation', { fields });
    }
    if (!response.ok) throw new SubmissionError('server');
    if (result?.accepted !== true && result?.status !== 'pending') throw new SubmissionError('unconfirmed');
    return { reference: typeof result.reference === 'string' ? result.reference.slice(0, 100) : '' };
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError(signal?.aborted ? 'cancelled' : 'network');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
