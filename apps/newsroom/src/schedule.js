/**
 * Scheduling helpers (pure, no DOM): convert between the browser's <input type="datetime-local"> value (local time,
 * no zone) and the ISO instant the CMS stores in `scheduledFor`. The CMS is the only authority on whether a time is
 * acceptable ("scheduledFor must be in the future."); this module only rejects values that are not a date at all, so a
 * clock difference between the browser and the server can never silently change what the CMS decides.
 */

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** @returns {{ok: true, iso: string} | {ok: false, message: string}} */
export function parseScheduleInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, message: 'Pick the date and time to publish.' };
  const m = LOCAL_RE.exec(raw);
  if (!m) return { ok: false, message: 'That is not a valid date and time.' };
  const [y, mo, d, h, mi, s] = m.slice(1).map(x => (x === undefined ? 0 : Number(x)));
  const date = new Date(y, mo - 1, d, h, mi, s);
  // new Date() silently rolls 31 Feb over to March: reject anything that did not round-trip.
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d ||
    date.getHours() !== h || date.getMinutes() !== mi || date.getSeconds() !== s
  ) {
    return { ok: false, message: 'That is not a valid date and time.' };
  }
  return { ok: true, iso: date.toISOString() };
}

const pad = n => String(n).padStart(2, '0');

/** ISO instant -> value for <input type="datetime-local"> in the viewer's local time (seconds included). '' when invalid. */
export function isoToLocalInput(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Human label for a scheduled instant, in the viewer's local time. */
export function formatScheduled(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A sensible default for the picker: one hour from `now`, rounded up to the next full minute. */
export function defaultScheduleValue(now = new Date()) {
  const t = new Date(Math.ceil((now.getTime() + 3600_000) / 60_000) * 60_000);
  return isoToLocalInput(t.toISOString()).slice(0, 16);
}
