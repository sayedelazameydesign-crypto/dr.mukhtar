#!/usr/bin/env node
'use strict';
// Synthetic shape validation only. No concurrency, GAS, deployment or patient data.
const assert = require('node:assert/strict');
const { validateContentionLedger } = require('./trial-ledger-model');
const timestamps = { startedAt: 1000, lock1Acquired: null, reservationPersisted: null, calendarCallStarted: null, calendarCallFinished: null, lock2Acquired: null, finishedAt: 1200 };
const rows = Array.from({ length: 3 }, (_, round) => Array.from({ length: 10 }, (_, attempt) => ({
  suite: 'contention', runId: 'TST-RUN-LOCAL', roundId: round + 1, attemptId: attempt,
  testReference: `TST-R${round + 1}-A${attempt}`, deploymentVersion: 0,
  timestamps: { ...timestamps }, outcome: 'UNKNOWN', finalSheetStatus: 'UNKNOWN', matchingEventCount: null, errorCode: null
}))).flat();
assert.deepEqual(validateContentionLedger(rows), { ok: true, code: 'STRUCTURALLY_VALID_ONLY', count: 30 });
assert.equal(validateContentionLedger(rows.slice(1)).code, 'EXPECTED_30_RECORDS');
assert.equal(validateContentionLedger([...rows.slice(0, 29), rows[0]]).code, 'DUPLICATE_FIXTURE');
assert.equal(validateContentionLedger(rows.map((row, index) => index ? row : { ...row, suite: 'fault-injection' })).code, 'INVALID_RECORD', 'fault runs are not mixed into contention');
assert.equal(validateContentionLedger(rows.map((row, index) => index ? row : { ...row, phone: 'not-allowed' })).code, 'INVALID_RECORD', 'unknown fields are rejected');
assert.equal(validateContentionLedger(rows.map((row, index) => index ? row : { ...row, runId: 'not-a-test-id' })).code, 'INVALID_RECORD');
assert.equal(validateContentionLedger(rows.map((row, index) => index ? row : { ...row, timestamps: { ...row.timestamps, startedAt: 'invalid' } })).code, 'INVALID_RECORD');
assert.equal(validateContentionLedger(rows.map((row, index) => index ? row : { ...row, deploymentVersion: 1 })).code, 'MIXED_RUN');
assert.equal(validateContentionLedger(rows.map((row, index) => index ? row : { ...row, matchingEventCount: -1 })).code, 'INVALID_RECORD');
console.log('Trial ledger shape passed (synthetic, structural validation only; no contention run).');
