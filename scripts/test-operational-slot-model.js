#!/usr/bin/env node
'use strict';

// Pure offline model checks. These do not test LockService, flush, concurrency,
// Calendar availability or persistence, and must not be used as go-live evidence.
const assert = require('node:assert/strict');
const { acquireOperationalSlot, verifyCalendarEvent, finalizeSlotStatus } = require('./operational-slot-model');
const CLAIM_A = '123e4567-e89b-42d3-a456-426614174000';
const CLAIM_B = '123e4567-e89b-42d3-a456-426614174001';
const pending = (reference, startMs = 1000, endMs = 2000, status = 'PENDING_APPROVAL') => ({ reference, status, startMs, endMs });
const plan = (records, overrides = {}) => acquireOperationalSlot({ lockHeld: true, snapshotComplete: true, reference: 'A', claimId: CLAIM_A, records, ...overrides });
const calendar = (reservation, events, extra = {}) => verifyCalendarEvent({ reservation, snapshotComplete: true, events, ...extra });
const finish = (records, verification, extra = {}) => finalizeSlotStatus({ lockHeld: true, snapshotComplete: true, records, verification, ...extra });
const marker = (ref) => `مرجع إداري: ${ref}\nبيانات طبية: غير محفوظة.`;

for (const status of ['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED']) {
  assert.equal(plan([pending('A', 1000, 2000, status)]).code, 'RESERVATION_PROPOSED', status);
}
assert.equal(plan([pending('A')], { lockHeld: false }).code, 'LOCK_TIMEOUT');
assert.equal(plan([pending('A')], { snapshotComplete: false }).code, 'UNKNOWN');
assert.equal(plan([], { reference: 'missing' }).code, 'NOT_FOUND');
assert.equal(plan([pending('A', 1000, 2000, 'CONFIRMED')]).code, 'ALREADY_PROCESSED');
assert.equal(plan([pending('A'), pending('A')]).code, 'UNKNOWN', 'duplicate references fail closed');
assert.equal(plan([pending('A'), pending('B', 1500, 2500, `UNDER_CREATION::${CLAIM_B}`)]).code, 'CONFLICT', 'partial overlaps block');
assert.equal(plan([pending('A'), pending('B', 3000, 4000, `UNDER_CREATION::${CLAIM_A}`)]).code, 'CLAIM_ID_REUSED');
assert.equal(plan([pending('A'), pending('B', 3000, 4000, `UNDER_CREATION::${CLAIM_B}`), pending('C', 5000, 6000, `UNDER_CREATION::${CLAIM_B}`)]).code, 'UNKNOWN', 'duplicate claim ownership fails closed');
assert.equal(plan([pending('A'), pending('B', 500, 1500, 'NEEDS_REVIEW')]).code, 'CONFLICT', 'needs-review claims block');
assert.equal(plan([pending('A'), pending('B', 2000, 3000, 'CONFIRMED')]).code, 'RESERVATION_PROPOSED', 'adjacent intervals do not overlap');
assert.equal(plan([pending('A'), pending('B', 1500, 2500)]).code, 'RESERVATION_PROPOSED', 'pending competitors do not reserve slots');
assert.equal(plan([pending('A'), pending('B', 1500, 2500, 'UNRECOGNIZED')]).code, 'UNKNOWN');
assert.equal(plan([pending('A'), pending('B', NaN, 2500, 'CONFIRMED')]).code, 'UNKNOWN', 'malformed blocking row fails closed');

const reservation = plan([pending('A')]).reservation;
assert.equal(reservation.status, `UNDER_CREATION::${CLAIM_A}`, 'claim belongs to the single status value');
assert.equal(Object.hasOwn(reservation, 'claimId'), false, 'no new claim column is modelled');
assert.equal(plan([pending('A'), pending('B', 1500, 2500, 'UNDER_CREATION::invalid')]).code, 'UNKNOWN');
assert.equal(plan([pending('A')], { claimId: 'bad-claim' }).code, 'INVALID_INPUT');
const event = { id: 'event-A', startMs: 1000, endMs: 2000, description: marker('A') };
const proof = calendar(reservation, [event]);
assert.equal(proof.code, 'EVENT_VERIFIED');
assert.equal(calendar(reservation, [event], { snapshotComplete: false }).code, 'NEEDS_REVIEW', 'outage is not absence');
assert.equal(calendar(reservation, []).code, 'NEEDS_REVIEW', 'missing read-back is not permission to recreate');
assert.equal(calendar(reservation, [event, { ...event, id: 'event-B' }]).code, 'NEEDS_REVIEW', 'duplicate references');
assert.equal(calendar(reservation, [{ ...event, endMs: 2001 }]).code, 'NEEDS_REVIEW', 'mismatched interval');
assert.equal(calendar(reservation, [{ ...event, description: marker('AB') }]).code, 'NEEDS_REVIEW', 'reference is exact');
assert.equal(calendar(reservation, [event, { id: 'external', startMs: 1900, endMs: 2100, description: '' }]).code, 'NEEDS_REVIEW', 'external overlapping event');
assert.equal(calendar(reservation, [event, { id: 'broken', startMs: 1, endMs: 2 }]).code, 'NEEDS_REVIEW', 'unreadable event');

const claim = { ...reservation };
assert.equal(finish([claim], proof).code, 'CONFIRMATION_PROPOSED');
assert.equal(finish([claim], proof, { lockHeld: false }).code, 'LOCK_TIMEOUT');
assert.equal(finish([claim], proof, { snapshotComplete: false }).code, 'UNKNOWN');
assert.equal(finish([claim], calendar(reservation, [])).code, 'NEEDS_REVIEW');
assert.equal(finish([{ ...claim, status: `UNDER_CREATION::${CLAIM_B}` }], proof).code, 'NEEDS_REVIEW', 'stale claim cannot finalize');
assert.equal(finish([{ ...claim, endMs: 2001 }], proof).code, 'NEEDS_REVIEW', 'changed interval cannot finalize');
assert.equal(finish([{ ...claim, status: 'CANCELLED' }], proof).code, 'NEEDS_REVIEW', 'changed status cannot finalize');
assert.equal(finish([claim, pending('B', 1500, 2500, 'CONFIRMED')], proof).code, 'NEEDS_REVIEW', 'new blocking reservation prevents finalize');
assert.equal(finish([claim, claim], proof).code, 'UNKNOWN', 'duplicate rows fail closed');

// Sequential mock decision only: persistence and actual concurrent execution are
// intentionally not simulated. A proposed claim is explicitly inserted as a fixture.
let rows = Array.from({ length: 10 }, (_, i) => pending(String(i)));
const first = acquireOperationalSlot({ lockHeld: true, snapshotComplete: true, records: rows, reference: '0', claimId: CLAIM_A });
assert.equal(first.code, 'RESERVATION_PROPOSED');
rows = rows.map((row) => row.reference === '0' ? first.reservation : row);
for (let i = 1; i < 10; i += 1) {
  assert.equal(acquireOperationalSlot({ lockHeld: true, snapshotComplete: true, records: rows, reference: String(i), claimId: CLAIM_B }).code, 'CONFLICT');
}
console.log('Operational slot model passed (offline decisions only; not concurrency or persistence proof).');
