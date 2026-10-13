// Public-only transport. Payload contract v1.2 is documented in
// docs/public-forms.md. No authentication or secret verification belongs here.
export const STORY_CATEGORIES = ['News', 'Features', 'Interviews', 'Business', 'Health & education', 'Opinion', 'Other'];
export const FIELD_LIMITS = { name: 120, email: 254, phone: 40, title: 200, message: 20000, location: 120 };

export function validateSubmission(values, kind = 'story') {
  const errors = {};
  if (!values.name?.trim()) errors.name = 'Enter your name.';
  else if (values.name.trim().length < 2) errors.name = 'Use at least 2 characters for your name.';
  else if (values.name.trim().length > FIELD_LIMITS.name) errors.name = 'Use no more than 120 characters for your name.';
  if (!values.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) || values.email.trim().length > FIELD_LIMITS.email) errors.email = 'Enter a valid email address so the newsroom can reply.';
  const phone = values.phone?.trim() || '';
  if (!phone) errors.phone = 'Enter a phone number so the newsroom can contact you.';
  else if (phone.length > FIELD_LIMITS.phone || !/^\+?[\d ().-]+$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, ''))) {
    errors.phone = 'Enter a phone number with 7–15 digits. Spaces, brackets, hyphens and a leading + are allowed.';
  }
  if (!values.title?.trim()) errors.title = kind === 'story' ? 'Enter a headline or a short description of your story.' : 'Enter a subject for your message.';
  else if (values.title.trim().length < 5) errors.title = 'Use at least 5 characters for the subject.';
  else if (values.title.trim().length > FIELD_LIMITS.title) errors.title = 'Use no more than 200 characters.';
  if (!values.message?.trim()) errors.message = kind === 'story' ? 'Tell us about your story.' : 'Enter your message.';
  else if (values.message.trim().length < 30) errors.message = 'Include at least 30 characters so the newsroom has enough detail.';
  else if (values.message.trim().length > FIELD_LIMITS.message) errors.message = 'Use no more than 20,000 characters.';
  if ((values.location?.trim() || '').length > FIELD_LIMITS.location) errors.location = 'Use no more than 120 characters for the location.';
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
  const shared = { name: values.name.trim(), email: values.email.trim(), phone: values.phone?.trim() || '', turnstileToken: token };
  return kind === 'contact'
    ? { ...shared, subject: values.title.trim(), message: values.message.trim() }
    : { ...shared, title: values.title.trim(), categorySuggestion: values.category, location: values.location?.trim() || '', website: '', body: values.message.trim() };
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
  if (!submissionEndpoint({ storyUrl: endpoint }) || typeof token !== 'string' || !token.trim() || token.length > 2048) throw new SubmissionError('configuration');
  const validation = validateSubmission(values, kind);
  if (Object.keys(validation).length) throw new SubmissionError('validation', { fields: validation });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(()=>{timedOut=true;abort();}, timeoutMs);
  try {
    if (signal?.aborted) throw new SubmissionError('cancelled');
    const body = JSON.stringify(submissionPayload(values, token, kind));
    if (new TextEncoder().encode(body).byteLength > 64 * 1024) throw new SubmissionError('size');
    const response = await fetchImpl(endpoint, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body, signal: controller.signal,
    });
    let result;
    try { result = await response.json(); } catch { if(controller.signal.aborted) throw new SubmissionError(signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network'); result = null; }
    if (response.status === 429) throw new SubmissionError('rate-limit', { retryAfter: retryDelay(response.headers.get('Retry-After')) });
    const backendErrors = Array.isArray(result?.errors) ? result.errors : [];
    if (backendErrors.some(error => error?.field === 'turnstileToken')) throw new SubmissionError('challenge');
    if (response.status === 409) throw new SubmissionError('duplicate');
    if (response.status === 413) throw new SubmissionError('size');
    if (response.status === 401 || response.status === 403) throw new SubmissionError('forbidden');
    if (response.status === 415) throw new SubmissionError('configuration');
    if (response.status === 400 || response.status === 422) {
      const fields = {};
      // Translate known backend field names; never echo raw backend messages.
      const mapping = { name:'name', email:'email', phone:'phone', title:'title', subject:'title', body:'message', message:'message', categorySuggestion:'category', location:'location' };
      for (const error of backendErrors) {
        if (Object.hasOwn(mapping,error?.field)) fields[mapping[error.field]] = 'Please check this field and try again.';
      }
      throw new SubmissionError('validation', { fields });
    }
    if (!response.ok) throw new SubmissionError('server');
    if (response.status !== 201 || result?.ok !== true || typeof result.reference !== 'string' || !result.reference.trim()) throw new SubmissionError('unconfirmed');
    return { reference: typeof result.reference === 'string' ? result.reference.slice(0, 100) : '' };
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError(signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
