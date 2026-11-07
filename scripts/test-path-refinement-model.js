#!/usr/bin/env node
'use strict';
// Prototype-only tests, separate from the diagnostic of actual Code.gs.
const assert = require('node:assert/strict');
const { inspectMutation, inspectAvailability } = require('./path-refinement-model');
const { cairoInterval } = require('./cairo-slot-model');
const claim = 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::60';
const other = 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174001::60';
const row = { reference: 'TST-A', status: claim, day: '2026-11-05', time: '09:00', visitType: 'كشف' };
const original = JSON.stringify(row);
for (const action of ['cancel', 'erase']) {
  assert.deepEqual(inspectMutation(row, action), { code: 'CLAIM_BLOCKED', mutate: false });
  assert.deepEqual(inspectMutation({ ...row, status: 'NEEDS_REVIEW' }, action), { code: 'CLAIM_BLOCKED', mutate: false });
  for (const status of ['UNDER_CREATION::bad', 'UNDER_CREATION', 'UNDER_CREATION::123-',
    'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000', 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::0', 'OTHER_UNKNOWN']) {
    assert.deepEqual(inspectMutation({ ...row, status }, action), { code: 'UNKNOWN', mutate: false });
  }
  assert.deepEqual(inspectMutation({ ...row, status: 'PENDING_APPROVAL' }, action), { code: 'FURTHER_CHECKS_REQUIRED', mutate: false });
}
assert.equal(JSON.stringify(row), original, 'no operation mutates a fixture');
assert.equal(inspectMutation(row, 'approve').code, 'UNKNOWN');
const base = { day: '2026-11-05', time: '09:30', visitType: 'متابعة', durations: { 'كشف': 60, 'متابعة': 30 },
  requestsReadable: true, calendarReadable: true, closuresReadable: true, quarantinesReadable: true,
  reservationDurationsReadable: true, ambiguityScanComplete: true, criticalAmbiguity: false,
  requests: [row], events: [], closures: [], quarantines: [] };
function snapshot(record, minutes = 60) {
  return { status: record.status, day: record.day, time: record.time, visitType: record.visitType, minutes };
}
function availability(changes) {
  const input = { ...base, ...changes };
  if (!Object.prototype.hasOwnProperty.call(changes, 'reservationDurations')) {
    input.reservationDurations = Object.fromEntries(input.requests.map((record) => [record.reference, snapshot(record)]));
  }
  return inspectAvailability(input);
}
assert.deepEqual(availability({}), { code: 'BLOCKED', available: false }, 'partial overlap with claim');
assert.deepEqual(availability({ time: '08:30', visitType: 'كشف' }), { code: 'BLOCKED', available: false }, 'candidate starts before claim and overlaps it');
assert.deepEqual(availability({ requests: [{ ...row, day: '2026-11-04', time: '23:30' }], time: '00:00' }), { code: 'BLOCKED', available: false }, 'overlap across midnight');
assert.deepEqual(availability({ day: '2026-04-24', time: '01:00', requests: [{ ...row, day: '2026-04-23', time: '23:30' }] }), { code: 'BLOCKED', available: false }, 'overlap across DST spring transition');
assert.deepEqual(availability({ requests: [{ ...row, status: 'CONFIRMED' }] }), { code: 'BLOCKED', available: false });
assert.deepEqual(availability({ requests: [{ ...row, status: 'NEEDS_REVIEW' }] }), { code: 'BLOCKED', available: false });
assert.deepEqual(availability({ durations: { 'كشف': 30, 'متابعة': 30 }, reservationDurations: {} }),
  { code: 'BLOCKED', available: false }, 'a later settings change cannot shorten the embedded claim duration');
assert.deepEqual(availability({ reservationDurationsReadable: false }), { code: 'BLOCKED', available: false }, 'claims have embedded minutes');
const confirmedRow = { ...row, status: 'CONFIRMED' };
assert.deepEqual(availability({ requests: [confirmedRow], reservationDurationsReadable: false }), { code: 'UNKNOWN', available: false }, 'confirmed duration still requires evidence');
assert.deepEqual(availability({ requests: [confirmedRow], reservationDurations: {} }), { code: 'UNKNOWN', available: false }, 'missing confirmed duration fails closed');
assert.deepEqual(availability({ requests: [confirmedRow], reservationDurations: { 'TST-A': { ...snapshot(confirmedRow), status: other } } }),
  { code: 'UNKNOWN', available: false }, 'confirmed duration snapshot must match the status');
assert.deepEqual(availability({ requests: [confirmedRow], reservationDurations: { 'TST-A': { ...snapshot(confirmedRow), time: '10:00' } } }),
  { code: 'UNKNOWN', available: false }, 'confirmed duration snapshot must match the interval');
assert.deepEqual(availability({ requests: [confirmedRow], reservationDurations: { 'TST-A': snapshot(confirmedRow, 0) } }),
  { code: 'UNKNOWN', available: false }, 'invalid stored duration fails closed');
assert.deepEqual(availability({ requests: [{ ...row, status: 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000' }] }),
  { code: 'UNKNOWN', available: false }, 'legacy UUID-only claims fail closed');
assert.deepEqual(availability({ requests: [{ ...row, status: 'PENDING_APPROVAL' }] }), { code: 'NO_CONFLICT_OBSERVED', available: null }, 'pending does not reserve');
assert.deepEqual(availability({ time: '10:00' }), { code: 'NO_CONFLICT_OBSERVED', available: null }, 'adjacent interval');
assert.deepEqual(availability({ requests: [{ ...row, status: 'UNDER_CREATION::bad' }] }), { code: 'UNKNOWN', available: false });
assert.deepEqual(availability({ requests: [{ ...row, status: other, day: '2026-10-29', time: '23:30' }] }), { code: 'UNKNOWN', available: false }, 'ambiguous Cairo wall time');
assert.deepEqual(availability({ requests: [row, row] }), { code: 'UNKNOWN', available: false }, 'duplicate reference');
assert.deepEqual(availability({ requests: [row, { ...row, reference: 'TST-B', time: '11:00' }] }), { code: 'UNKNOWN', available: false }, 'duplicate claim ownership');
for (const flag of ['requestsReadable', 'calendarReadable', 'closuresReadable', 'quarantinesReadable', 'ambiguityScanComplete']) {
  assert.deepEqual(availability({ [flag]: false }), { code: 'UNKNOWN', available: false }, flag);
}
assert.deepEqual(availability({ requests: [], criticalAmbiguity: true }), { code: 'UNKNOWN', available: false }, 'unpersisted unresolved ambiguity denies availability');
const candidateInterval = cairoInterval(base.day, base.time, base.visitType, base.durations);
assert.deepEqual(availability({ requests: [], events: [candidateInterval] }), { code: 'BLOCKED', available: false }, 'Calendar event overlap');
assert.deepEqual(availability({ requests: [], closures: [candidateInterval] }), { code: 'BLOCKED', available: false }, 'closure overlap');
assert.deepEqual(availability({ requests: [], quarantines: [{ scope: 'INTERVAL', ...candidateInterval }] }), { code: 'BLOCKED', available: false }, 'quarantine overlap');
assert.deepEqual(availability({ requests: [], quarantines: [{ scope: 'GLOBAL' }] }), { code: 'BLOCKED', available: false }, 'unscoped uncertainty quarantines globally in the fake');
assert.deepEqual(availability({ requests: [], quarantines: [{ scope: 'INTERVAL', startMs: 1, endMs: 2 }] }), { code: 'NO_CONFLICT_OBSERVED', available: null });
assert.deepEqual(availability({ requests: [], quarantines: [{ scope: 'INTERVAL', startMs: 2, endMs: 1 }] }), { code: 'UNKNOWN', available: false });
assert.deepEqual(availability({ requests: [], events: [{ startMs: NaN, endMs: 5 }] }), { code: 'UNKNOWN', available: false });
assert.deepEqual(availability({ requests: [], closures: [{ startMs: 2, endMs: 1 }] }), { code: 'UNKNOWN', available: false });
// No elapsed time or timestamp field releases a claim or quarantine in this prototype.
for (const now of [1, 3600000, 365 * 86400000]) {
  assert.equal(availability({ requests: [{ ...row, updatedAtMs: 0 }], nowMs: now }).code, 'BLOCKED');
  assert.equal(availability({ requests: [], quarantines: [{ scope: 'GLOBAL', createdAtMs: 0 }], nowMs: now }).code, 'BLOCKED');
}
console.log('Local path refinement model passed (read-only decisions; not actual GAS path parity).');
