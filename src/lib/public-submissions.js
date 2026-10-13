// Anonymous transport mapped to apps/cms/src/endpoints/publicSubmissions.ts.
// No authentication or secret verification belongs in the browser.
export const STORY_CATEGORIES = ['News', 'Features', 'Interviews', 'Business', 'Health & education', 'Opinion', 'Other'];
export const FIELD_LIMITS = { name: 120, email: 254, phone: 40, title: 200, message: 20000, location: 120 };
export const submissionLimits = kind => kind === 'contact' ? { ...FIELD_LIMITS, name:100, phone:32, title:180, message:12000 } : FIELD_LIMITS;

export function validateSubmission(values, kind = 'story') {
  const errors = {};
  const limits = submissionLimits(kind);
  if (!values.name?.trim()) errors.name = 'Enter your name.';
  else if (values.name.trim().length > limits.name) errors.name = `Use no more than ${limits.name} characters for your name.`;
  if (!values.email?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim()) || values.email.trim().length > limits.email) errors.email = 'Enter a valid email address so the newsroom can reply.';
  const phone = values.phone?.trim() || '';
  if (!phone) errors.phone = 'Enter a phone number so the newsroom can contact you.';
  else if (phone.length > limits.phone || !/^\+?[\d ().-]+$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, ''))) {
    errors.phone = 'Enter a phone number with 7–15 digits. Spaces, brackets, hyphens and a leading + are allowed.';
  }
  if (!values.title?.trim()) errors.title = kind === 'story' ? 'Enter a headline or a short description of your story.' : 'Enter a subject for your message.';
  else if (values.title.trim().length > limits.title) errors.title = `Use no more than ${limits.title} characters.`;
  if (!values.message?.trim()) errors.message = kind === 'story' ? 'Tell us about your story.' : 'Enter your message.';
  else if (values.message.trim().length > limits.message) errors.message = `Use no more than ${limits.message.toLocaleString('en-GB')} characters.`;
  if (kind === 'story' && !STORY_CATEGORIES.includes(values.category)) errors.category = 'Choose the section that best fits your story.';
  if (kind === 'story') {
    if (values.name?.trim() && values.name.trim().length < 2) errors.name = 'Use at least 2 characters for your name.';
    if (values.title?.trim() && values.title.trim().length < 5) errors.title = 'Use at least 5 characters for the story subject.';
    if (values.message?.trim() && values.message.trim().length < 30) errors.message = 'Include at least 30 characters of story detail.';
    if (values.location?.trim().length > limits.location) errors.location = 'Use no more than 120 characters for the location.';
  }
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
    ? { ...shared, consent:values.consent === true, subject:values.title.trim(), message:values.message.trim() }
    : { ...shared, title:values.title.trim(), categorySuggestion:values.category, body:values.message.trim(), location:values.location?.trim() || '', website:'' };
}

const FIELD_MAPPING = {name:'name',email:'email',phone:'phone',title:'title',subject:'title',body:'message',message:'message',categorySuggestion:'category',category:'category',location:'location',consent:'consent',turnstileToken:'challenge','cf-turnstile-response':'challenge'};
function responseFields(result) {
  const fields = {};
  const errors = result?.errors;
  const keys = Array.isArray(errors) ? errors.flatMap(error => [error?.field,error?.path,...(Array.isArray(error?.data?.errors)?error.data.errors.map(e=>e?.path):[])]) : Object.keys(errors || {});
  for(const key of keys) if(Object.hasOwn(FIELD_MAPPING,key)) fields[FIELD_MAPPING[key]] = 'Please check this field and try again.';
  return fields;
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
  if (signal?.aborted) throw new SubmissionError('cancelled');
  if (!submissionEndpoint({ storyUrl: endpoint }) || !token) throw new SubmissionError('configuration');
  const validation = validateSubmission(values, kind);
  if (Object.keys(validation).length) throw new SubmissionError('validation', { fields: validation });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(()=>{timedOut=true;abort();}, timeoutMs);
  const body = JSON.stringify(submissionPayload(values, token, kind));
  try {
    if (kind === 'story' && new TextEncoder().encode(body).length > 64*1024) throw new SubmissionError('too-large');
    const response = await fetchImpl(endpoint, {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body, signal: controller.signal,
    });
    let result;
    try { result = await response.json(); } catch(error) { if(controller.signal.aborted)throw error;result = null; }
    const fields = responseFields(result);
    if (response.status === 429) throw new SubmissionError('rate-limit', { retryAfter: retryDelay(response.headers?.get('Retry-After')) });
    if (fields.challenge || ['TURNSTILE_INVALID', 'TURNSTILE_EXPIRED'].includes(result?.code)) throw new SubmissionError('challenge');
    if (response.status === 400 || response.status === 422) throw new SubmissionError('validation', { fields });
    if (response.status === 409) throw new SubmissionError('duplicate');
    if (response.status === 413) throw new SubmissionError('too-large');
    if ([401,403].includes(response.status)) throw new SubmissionError('forbidden');
    if ([404,405,415].includes(response.status)) throw new SubmissionError('configuration');
    if (!response.ok) throw new SubmissionError('server');
    const reference = typeof result?.reference === 'string' ? result.reference.trim().slice(0,100) : '';
    const confirmed = result?.ok === true && reference && !result.errors?.length;
    const legacy = result && !Object.hasOwn(result,'ok') && (result.accepted === true || result.status === 'pending');
    if (!confirmed && !legacy) throw new SubmissionError('unconfirmed');
    return { reference: reference };
  } catch (error) {
    if (error instanceof SubmissionError) throw error;
    throw new SubmissionError(signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
