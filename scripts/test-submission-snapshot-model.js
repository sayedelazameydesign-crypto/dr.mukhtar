#!/usr/bin/env node
'use strict';
// Offline fake snapshots only: not a Sheets schema or a real submission test.
const assert = require('node:assert/strict');
const { captureSubmissionSnapshot, compareSubmissionAndClaim } = require('./submission-snapshot-model');
const request = { reference: 'TST-001', day: '2026-11-05', time: '09:00', visitType: 'كشف', status: 'PENDING_APPROVAL' };
const settings = { readable: true, complete: true, stable: true, revision: 'fixture-v1', durations: { 'كشف': 60, 'متابعة': 30 } };
const requestBefore = JSON.stringify(request); const settingsBefore = JSON.stringify(settings);
const submission = captureSubmissionSnapshot(request, settings);
assert.equal(submission.code, 'SNAPSHOT_PROPOSED'); assert.equal(submission.write, false);
assert.equal(submission.snapshot.submittedDuration, 60);
const claim = { request, settings, snapshotReadable: true, snapshot: submission.snapshot };
assert.deepEqual(compareSubmissionAndClaim(claim), { code: 'DURATION_MATCH_OBSERVED', proceed: false, write: false,
  submittedDuration: 60, claimDuration: 60, settingsRevisionChanged: false });
function check(overrides, code) {
  const result = compareSubmissionAndClaim({ ...claim, ...overrides });
  assert.equal(result.code, code); assert.equal(result.proceed, false); assert.equal(result.write, false);
}
check({ settings: { ...settings, revision: 'fixture-v2', durations: { 'كشف': 30 } } }, 'DURATION_DRIFT_REVIEW');
const sameDuration = compareSubmissionAndClaim({ ...claim, settings: { ...settings, revision: 'fixture-v2' } });
assert.equal(sameDuration.code, 'DURATION_MATCH_OBSERVED'); assert.equal(sameDuration.settingsRevisionChanged, true);
assert.equal(sameDuration.proceed, false, 'unchanged duration does not authorize a booking');
check({ snapshotReadable: false }, 'SUBMISSION_SNAPSHOT_UNKNOWN');
check({ snapshot: null }, 'SUBMISSION_SNAPSHOT_UNKNOWN');
check({ snapshot: { ...submission.snapshot, submittedDuration: 0 } }, 'SUBMISSION_SNAPSHOT_UNKNOWN');
check({ snapshot: { ...submission.snapshot, submittedDuration: '60' } }, 'SUBMISSION_SNAPSHOT_UNKNOWN');
for (const patch of [{ reference: 'TST-002' }, { day: '2026-11-06' }, { time: '10:00' }, { visitType: 'متابعة' }]) {
  check({ request: { ...request, ...patch } }, 'SUBMISSION_MISMATCH_REVIEW');
}
check({ request: { ...request, status: 'CONFIRMED' } }, 'STATUS_REVIEW_REQUIRED');
check({ request: { ...request, status: 'UNDER_CREATION::bad' } }, 'STATUS_REVIEW_REQUIRED');
for (const patch of [{ readable: false }, { complete: false }, { stable: false }, { revision: '' }, { durations: {} }, { durations: { 'كشف': NaN } }]) {
  assert.equal(captureSubmissionSnapshot(request, { ...settings, ...patch }).code, 'CONFIG_UNKNOWN');
  check({ settings: { ...settings, ...patch } }, 'CONFIG_UNKNOWN');
}
assert.equal(captureSubmissionSnapshot({ ...request, day: '2026-04-24', time: '00:30' }, settings).code, 'TIME_UNKNOWN');
assert.equal(captureSubmissionSnapshot({ ...request, day: '2026-10-29', time: '23:30' }, settings).code, 'TIME_UNKNOWN');
check({ request: { ...request, day: '2026-04-24', time: '00:30' }, snapshot: { ...submission.snapshot, day: '2026-04-24', time: '00:30' } }, 'TIME_UNKNOWN');
assert.equal(JSON.stringify(request), requestBefore); assert.equal(JSON.stringify(settings), settingsBefore);
console.log('Submission snapshot model passed (offline only; no durable capture or booking authorization).');
