// Money on the Give page: whole minor units (kobo, cents) only. Typed amounts are converted with string arithmetic,
// never floats, so "5,000.10" is exactly 500010 and nothing is rounded behind the reader's back.
const AMOUNT_RE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;
export const REFERENCE_RE = /^CTG-[0-9a-f]{32}$/;

/** "5,000.50" -> 500050; null when it is not a plain positive amount with at most two decimals. */
export function majorToMinor(text) {
  const cleaned = String(text ?? '').trim().replace(/[\s,_]/g, '');
  const match = AMOUNT_RE.exec(cleaned);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

const SYMBOL = { NGN: '₦', USD: '$', GBP: '£', EUR: '€' };
/** 500050 NGN -> "₦5,000.50"; whole amounts drop the ".00". */
export function formatMinor(minor, currency) {
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  return `${SYMBOL[currency] || currency + ' '}${whole.toLocaleString('en-GB')}${cents ? '.' + String(cents).padStart(2, '0') : ''}`;
}

// Loopback checkout pages exist only for the offline browser harness: a development build with this flag. A production
// build never accepts anything but https://checkout.paystack.com, whatever the flag says.
const TEST_CHECKOUT = import.meta.env?.VITE_GIVING_TEST_CHECKOUT === 'true' && !import.meta.env?.PROD;

/** The hosted checkout must be Paystack's own page. */
export function safeCheckoutUrl(value, { allowLoopback = TEST_CHECKOUT } = {}) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:' && url.hostname === 'checkout.paystack.com') return url.href;
    if (allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return url.href;
  } catch {}
  return null;
}

/** The donation reference from the return URL (Paystack appends ?trxref=&reference=) or the one this tab started. */
export function returnReference(search, stored) {
  const params = new URLSearchParams(search || '');
  for (const value of [params.get('reference'), params.get('trxref'), stored]) if (REFERENCE_RE.test(value || '')) return value;
  return null;
}
