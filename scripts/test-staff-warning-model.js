#!/usr/bin/env node
'use strict';
// Tests view-model text only; no DOM, staff authentication, network or real data.
const assert = require('node:assert/strict');
const { inspectIntegratedTrial } = require('./integrated-trial-audit-model');
const { captureSubmissionSnapshot } = require('./submission-snapshot-model');
const { warningForAudit } = require('./staff-warning-model');
const request = { reference: 'TST-1', status: 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::60',
  day: '2026-11-05', time: '09:00', visitType: 'كشف', claimObservedAtMs: 1000000 };
const originalSettings = { readable: true, complete: true, stable: true, revision: 'fixture-v1', durations: { 'كشف': 60 } };
const changedSettings = { ...originalSettings, revision: 'fixture-v2', durations: { 'كشف': 30 } };
const props = { readable: true, markerReadable: true, marker: 'COMMITTED', requiredKeysPresent: true,
  configIntegrityVerified: true, pinStateReadable: true, pinChangeState: 'COMMITTED' };
const evidence = { nonce: 'fixture-nonce', reference: request.reference, noncesReadable: true, requestsReadable: true,
  nonces: [{ nonce_id: 'fixture-nonce', consumed_at: '2026-11-07T00:00:00Z' }], requests: [request],
  calendarReadable: true, matchingEventCount: 1, calendarConflict: false, properties: props,
  durationSettings: changedSettings, timing: { clockAssumedSynchronized: true, observationNowMs: 1100001, staleAfterMs: 100000 },
  submissionSnapshotReadable: true, submissionSnapshot: captureSubmissionSnapshot(request, originalSettings).snapshot };
const audit = inspectIntegratedTrial(evidence);
assert.equal(audit.decision, 'LEDGER_TIMING_DRIFT_SUSPECT');
const original = JSON.stringify(audit);
function check(result, kind) {
  assert.equal(result.kind, kind); assert.equal(result.manualReviewRequired, true);
  for (const flag of ['allowAvailability', 'allowBooking', 'allowRelease', 'allowRepair', 'allowRetry', 'persisted']) assert.equal(result[flag], false);
  assert.deepEqual(result.actions, []); assert.ok(result.message.length > 10);
  for (const secret of ['fixture-nonce', 'TST-1', '123e4567', '<script>', 'fixture-token']) assert.ok(!result.message.includes(secret));
}
check(warningForAudit({ snapshotReadable: true, audit }), 'TIMING');
check(warningForAudit({ snapshotReadable: true, audit: inspectIntegratedTrial({ ...evidence, noncesReadable: false }) }), 'CRITICAL');
const review = inspectIntegratedTrial({ ...evidence, durationSettings: originalSettings, timing: { ...evidence.timing, observationNowMs: 1000001 } });
assert.equal(review.decision, 'HUMAN_REVIEW_REQUIRED');
check(warningForAudit({ snapshotReadable: true, audit: review }), 'REVIEW');
for (const value of [null, {}, { snapshotReadable: false, audit }, { snapshotReadable: true, audit: null },
  { snapshotReadable: true, audit: { ...audit, decision: '<script>fixture-token</script>' } },
  { snapshotReadable: true, audit: { ...audit, timingState: 'UNKNOWN' } },
  { snapshotReadable: true, audit: { ...audit, reasons: [] } },
  { snapshotReadable: true, audit: { ...audit, allowRelease: true } },
  { snapshotReadable: true, audit: { ...audit, requiredQuarantine: null } },
  { snapshotReadable: true, audit: { ...review, reasons: ['unexpected'] } }]) check(warningForAudit(value), 'UNKNOWN');
assert.equal(warningForAudit({ snapshotReadable: false, audit }).severity, 'critical', 'failed reads cannot look like an empty or healthy dashboard');
assert.equal(JSON.stringify(audit), original, 'the warning must not mutate the audit');
console.log('Staff warning model passed (offline text only; no actual dashboard, hold or recovery).');
