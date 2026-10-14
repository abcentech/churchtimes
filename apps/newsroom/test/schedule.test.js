import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleInput, isoToLocalInput, formatScheduled, defaultScheduleValue } from '../src/schedule.js';

test('a datetime-local value is read as LOCAL time and becomes an ISO instant', () => {
  const r = parseScheduleInput('2030-06-15T09:30');
  assert.equal(r.ok, true);
  assert.equal(r.iso, new Date(2030, 5, 15, 9, 30, 0).toISOString());
});

test('seconds are kept when the browser provides them', () => {
  const r = parseScheduleInput('2030-06-15T09:30:42');
  assert.equal(r.ok, true);
  assert.equal(r.iso, new Date(2030, 5, 15, 9, 30, 42).toISOString());
});

test('empty, malformed and impossible values are rejected with a message', () => {
  for (const bad of ['', '   ', null, undefined, 'tomorrow', '2030-06-15', '2030-06-15 09:30', '2030-13-01T10:00', '2030-02-31T10:00', '2030-06-15T25:00', '2030-06-15T10:61']) {
    const r = parseScheduleInput(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.message.length > 0);
  }
});

test('a time in the past is NOT rejected here: the CMS decides ("scheduledFor must be in the future.")', () => {
  assert.equal(parseScheduleInput('2001-01-01T00:00').ok, true);
});

test('isoToLocalInput round-trips through parseScheduleInput', () => {
  const iso = new Date(2031, 0, 2, 3, 4, 5).toISOString();
  const local = isoToLocalInput(iso);
  assert.equal(local, '2031-01-02T03:04:05');
  assert.equal(parseScheduleInput(local).iso, iso);
});

test('isoToLocalInput and formatScheduled tolerate missing or invalid input', () => {
  for (const bad of [null, undefined, '', 'not a date']) {
    assert.equal(isoToLocalInput(bad), '');
    assert.equal(formatScheduled(bad), '');
  }
  assert.ok(formatScheduled(new Date(2031, 0, 2, 3, 4, 5).toISOString()).includes('2031'));
});

test('the default picker value is about an hour ahead, on a whole minute, without seconds', () => {
  const now = new Date(2030, 0, 1, 10, 20, 30);
  const v = defaultScheduleValue(now);
  assert.equal(v, '2030-01-01T11:21');
  assert.ok(parseScheduleInput(v).ok);
});
