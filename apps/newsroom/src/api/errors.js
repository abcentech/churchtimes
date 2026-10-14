/** Error type for every failed CMS call. The message is always safe to show (rendered with textContent). */
export class ApiError extends Error {
  constructor(message, { status = 0, errors = [], retryAfter = null, network = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors;
    this.retryAfter = retryAfter;
    this.network = network;
  }
  get isUnauthorized() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
}

function firstMessage(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const parts = [];
  for (const e of errors) {
    const inner = Array.isArray(e?.data?.errors) ? e.data.errors : [];
    if (inner.length) {
      for (const i of inner) {
        if (i?.message) parts.push(i.path ? `${i.path}: ${i.message}` : i.message);
      }
    } else if (e?.message) {
      parts.push(e.field ? `${e.field}: ${e.message}` : e.message);
    }
  }
  return parts.slice(0, 4).join(' ');
}

/** Build an ApiError from a non-2xx fetch Response. Never returns a success value. */
export async function toApiError(res) {
  let payload = null;
  try { payload = await res.json(); } catch { /* non-JSON body */ }
  const server = firstMessage(payload);
  const retryAfter = Number.parseInt(res.headers.get('Retry-After') || '', 10);
  let message = server;
  if (!message) {
    message = {
      400: 'The CMS rejected the request.',
      401: 'You are not signed in.',
      403: 'You are not permitted to do that.',
      404: 'Not found.',
      409: 'That conflicts with the current state (it may already have been done).',
      413: 'The upload is too large.',
      429: 'Too many attempts. Please wait and try again.'
    }[res.status] || `The CMS returned an error (HTTP ${res.status}).`;
  } else if (res.status === 403 && !/permit|forbidden|allow|outside|scope/i.test(message)) {
    message = `Not permitted: ${message}`;
  }
  return new ApiError(message, {
    status: res.status,
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : null
  });
}
