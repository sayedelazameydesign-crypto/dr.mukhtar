#!/usr/bin/env node
'use strict';
// Local Node/ICU test only; not GAS, Sheets-cell, or real Calendar evidence.
const assert = require('node:assert/strict');
const { wallTimeToInstant, cairoInterval, acquireCairoOperationalSlot } = require('./cairo-slot-model');
const { finalizeSlotStatus } = require('./operational-slot-model');
const durations = { 'كشف': 60, 'متابعة': 30 };
const claimId = '123e4567-e89b-42d3-a456-426614174000';
const otherClaim = '123e4567-e89b-42d3-a456-426614174001';
function instant(day, time) { return new Date(wallTimeToInstant(day, time).startMs).toISOString(); }
assert.equal(instant('2026-01-15', '10:00'), '2026-01-15T08:00:00.000Z');
assert.equal(instant('2026-07-15', '10:00'), '2026-07-15T07:00:00.000Z');
assert.equal(wallTimeToInstant('2026-04-24', '00:30').code, 'NONEXISTENT_WALL_TIME', 'spring DST gap is rejected');
assert.equal(wallTimeToInstant('2026-10-29', '23:30').code, 'AMBIGUOUS_WALL_TIME', 'fall DST fold is rejected');
assert.equal(wallTimeToInstant('2026-02-30', '10:00').code, 'INVALID_WALL_TIME');
assert.equal(wallTimeToInstant('2026-11-05', '24:00').code, 'INVALID_WALL_TIME');
assert.equal(wallTimeToInstant('2026-11-05', '9:00').code, 'INVALID_WALL_TIME');
assert.equal(wallTimeToInstant('2026-11-05', new Date()).code, 'INVALID_WALL_TIME', 'no coercion of Sheets Date cells');
assert.equal(cairoInterval('2026-11-05', '09:00', 'unknown', durations).code, 'UNKNOWN_VISIT_TYPE');
assert.equal(cairoInterval('2026-11-05', '09:00', 'كشف', { 'كشف': 0 }).code, 'INVALID_DURATION');
const visit = cairoInterval('2026-11-05', '09:00', 'كشف', durations);
const followup = cairoInterval('2026-11-05', '09:00', 'متابعة', durations);
assert.equal(visit.endMs - visit.startMs, 60 * 60000);
assert.equal(followup.endMs - followup.startMs, 30 * 60000);
// Duration is elapsed time even if the clocks spring forward during the visit.
const crossing = cairoInterval('2026-04-23', '23:30', 'كشف', durations);
assert.equal(new Date(crossing.startMs).toISOString(), '2026-04-23T21:30:00.000Z');
assert.equal(new Date(crossing.endMs).toISOString(), '2026-04-23T22:30:00.000Z');
const pending = { reference: 'A', status: 'REQUESTED', day: '2026-11-05', time: '09:00', visitType: 'كشف' };
const blocker = { reference: 'B', status: `UNDER_CREATION::${otherClaim}::30`, day: '2026-11-05', time: '09:30', visitType: 'متابعة' };
function captured(record, minutes) {
  return { status: record.status, day: record.day, time: record.time, visitType: record.visitType, minutes };
}
function plan(records, changes = {}) {
  const reservationDurations = Object.fromEntries(records.map((record) => [record.reference, captured(record, durations[record.visitType])]));
  return acquireCairoOperationalSlot({ lockHeld: true, snapshotComplete: true, reference: 'A', claimId, records, durations,
    reservationDurationsReadable: true, reservationDurations, ...changes });
}
assert.equal(plan([pending, blocker]).code, 'CONFLICT', 'partial overlap of distinct visit durations');
assert.equal(plan([pending, blocker], { reservationDurationsReadable: false }).code, 'CONFLICT', 'claim duration is embedded in the status');
assert.equal(plan([pending, blocker], { reservationDurations: {} }).code, 'CONFLICT', 'claim does not depend on the mutable catalogue');
const confirmed = { ...blocker, status: 'CONFIRMED' };
assert.equal(plan([pending, confirmed], { reservationDurationsReadable: false }).code, 'UNKNOWN', 'confirmed duration still needs evidence');
assert.equal(plan([pending, confirmed], { reservationDurations: { B: { ...captured(confirmed, 30), time: '10:00' } } }).code, 'UNKNOWN', 'confirmed snapshot must match the row');
const earlierClaim = { ...blocker, time: '08:30', visitType: 'كشف', status: `UNDER_CREATION::${otherClaim}::60` };
assert.equal(plan([pending, earlierClaim], { durations: { 'كشف': 30, 'متابعة': 30 },
  reservationDurations: {} }).code, 'CONFLICT', 'settings change does not shorten the stored interval');
assert.equal(plan([pending, { ...blocker, status: `UNDER_CREATION::${otherClaim}` }]).code, 'UNKNOWN', 'legacy claim without duration fails closed');
assert.equal(plan([pending, { ...blocker, time: '10:00' }]).code, 'RESERVATION_PROPOSED', 'adjacent is not overlap');
assert.equal(plan([pending, { ...blocker, status: 'PENDING_APPROVAL' }]).code, 'RESERVATION_PROPOSED', 'pending requests are not reservations');
assert.equal(plan([pending, { ...blocker, day: '2026-02-30' }]).code, 'UNKNOWN', 'bad blocking row fails closed');
assert.equal(plan([pending, { ...blocker, day: '2026-10-29', time: '23:30' }]).code, 'UNKNOWN', 'ambiguous blocking row fails closed');
assert.equal(plan([pending, { ...blocker, status: 'UNDER_CREATION::bad' }]).code, 'UNKNOWN', 'malformed claim fails closed');
// A claim is never released merely because any amount of time passes in this model.
const reservation = plan([pending]).reservation;
assert.equal(reservation.status, `UNDER_CREATION::${claimId}::60`, 'the proposed claim captures its duration in the status');
for (const age of [0, 3600000, 86400000, 365 * 86400000]) {
  const withOldTimestamp = { ...reservation, updatedAtMs: 1, simulatedNowMs: 1 + age };
  const other = { ...pending, reference: 'B' };
  const claimedRow = { ...withOldTimestamp, day: pending.day, time: pending.time, visitType: pending.visitType };
  assert.equal(acquireCairoOperationalSlot({ lockHeld: true, snapshotComplete: true, reference: 'B', claimId: otherClaim, durations,
    reservationDurationsReadable: true, reservationDurations: { A: captured(claimedRow, 60) },
    records: [claimedRow, other] }).code, 'CONFLICT');
  assert.equal(finalizeSlotStatus({ lockHeld: true, snapshotComplete: true, records: [withOldTimestamp], verification: { code: 'NEEDS_REVIEW' } }).code, 'NEEDS_REVIEW');
}
console.log('Cairo interval model passed (Node ICU, local fixtures only).');
