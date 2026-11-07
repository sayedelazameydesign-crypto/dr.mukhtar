#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { inspectIntegratedTrial } = require('./integrated-trial-audit-model');
const { captureSubmissionSnapshot } = require('./submission-snapshot-model');
const { inspectAvailability, inspectMutation } = require('./path-refinement-model');
const claim = 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::60';
const request = { reference: 'TST-1', status: claim, day: '2026-11-05', time: '09:00', visitType: 'كشف', claimObservedAtMs: 1000000 };
const durationSettings = { readable: true, complete: true, stable: true, revision: 'fixture-v1', durations: { 'كشف': 60 } };
const properties = { readable: true, markerReadable: true, marker: 'COMMITTED', requiredKeysPresent: true,
  configIntegrityVerified: true, pinStateReadable: true, pinChangeState: 'COMMITTED' };
const input = { nonce: 'fixture-nonce', reference: 'TST-1', noncesReadable: true, requestsReadable: true,
  nonces: [{ nonce_id: 'fixture-nonce', consumed_at: '2026-11-07T00:00:00Z' }], requests: [request],
  calendarReadable: true, matchingEventCount: 1, calendarConflict: false, properties, durationSettings,
  timing: { clockAssumedSynchronized: true, observationNowMs: 1099999, staleAfterMs: 100000 },
  submissionSnapshotReadable: true, submissionSnapshot: captureSubmissionSnapshot(request, durationSettings).snapshot };
const before = JSON.stringify(input);
function audit(changes, reason, expectedDecision) {
  const r = inspectIntegratedTrial({ ...input, ...changes });
  assert.equal(r.decision, expectedDecision || (reason ? 'RECONCILIATION_CRITICAL_AMBIGUITY' : 'HUMAN_REVIEW_REQUIRED'));
  if (reason) assert.ok(r.reasons.includes(reason), JSON.stringify(r));
  assert.equal(r.requiredQuarantine, reason ? 'GLOBAL_OR_PROVEN_NARROWER' : null);
  assert.equal(r.relationship, 'UNPROVEN'); assert.equal(r.actorIntent, 'NOT_DETERMINABLE');
  assert.equal(r.manualReviewRequired, true); assert.equal(r.allowAvailability, false);
  assert.equal(r.allowBooking, false); assert.equal(r.allowRepair, false); assert.equal(r.allowRelease, false);
  assert.equal(r.allowRetry, false); assert.equal(r.quarantinePersisted, false);
  return r;
}
const observed = audit({});
assert.equal(observed.nonceState, 'PRESENT'); assert.equal(observed.claimState, 'CLAIM_PRESENT');
assert.equal(observed.durationState, 'DURATION_MATCH_OBSERVED');
audit({ nonces: [] }, 'CLAIM_WITHOUT_NONCE_OBSERVED');
audit({ requests: [{ ...request, status: 'PENDING_APPROVAL' }] }, 'NONCE_WITHOUT_CLAIM_OBSERVED');
audit({ noncesReadable: false }, 'NONCE_OBSERVATION_UNKNOWN');
audit({ nonces: [...input.nonces, ...input.nonces] }, 'NONCE_OBSERVATION_UNKNOWN');
audit({ nonces: [{ nonce_id: 'fixture-nonce' }] }, 'NONCE_OBSERVATION_UNKNOWN');
audit({ requestsReadable: false }, 'REQUEST_OBSERVATION_UNKNOWN');
audit({ requests: [...input.requests, ...input.requests] }, 'REQUEST_OBSERVATION_UNKNOWN');
audit({ requests: [] }, 'REQUEST_OBSERVATION_UNKNOWN');
for (const status of ['UNDER_CREATION::bad', 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000',
  'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::0', 'OTHER']) {
  audit({ requests: [{ ...request, status }] }, 'REQUEST_OBSERVATION_UNKNOWN');
}
audit({ properties: { ...properties, marker: 'IN_PROGRESS' } }, 'PROPERTIES_NOT_VERIFIABLE');
audit({ properties: { ...properties, readable: false } }, 'PROPERTIES_NOT_VERIFIABLE');
audit({ properties: { ...properties, pinChangeState: 'UNKNOWN' } }, 'PROPERTIES_NOT_VERIFIABLE');
audit({ submissionSnapshotReadable: false }, 'DURATION_EVIDENCE_REVIEW');
audit({ durationSettings: { ...durationSettings, revision: 'fixture-v2', durations: { 'كشف': 30 } } }, 'DURATION_EVIDENCE_REVIEW');
const drift = audit({ requests: [{ ...request, status: claim.replace('::60', '::30') }] }, 'DURATION_EVIDENCE_REVIEW');
assert.equal(drift.durationState, 'CLAIM_DURATION_DRIFT_REVIEW');
audit({ requests: [{ ...request, time: '10:00' }] }, 'DURATION_EVIDENCE_REVIEW');
audit({ matchingEventCount: 0 }, 'CALENDAR_OR_CROSS_SOURCE_AMBIGUITY');
audit({ calendarReadable: false }, 'CALENDAR_OR_CROSS_SOURCE_AMBIGUITY');
audit({ requests: [{ ...request, status: 'CONFIRMED' }] }, 'DURATION_EVIDENCE_REVIEW');

const changed = { ...durationSettings, revision: 'fixture-v2', durations: { 'كشف': 30 } };
const old = { ...input.timing, observationNowMs: 1100001 };
const suspect = audit({ timing: old, durationSettings: changed }, 'TIMING_DRIFT_SUSPECT', 'LEDGER_TIMING_DRIFT_SUSPECT');
assert.equal(suspect.timingState, 'STALE_OBSERVED');
assert.ok(suspect.reasons.includes('STALE_CLAIM_OBSERVED'));
assert.ok(suspect.reasons.includes('DURATION_EVIDENCE_REVIEW'));
const blocked = inspectAvailability({ day: request.day, time: request.time, visitType: request.visitType,
  durations: changed.durations, requestsReadable: true, calendarReadable: true, closuresReadable: true,
  quarantinesReadable: true, ambiguityScanComplete: true, criticalAmbiguity: suspect.requiredQuarantine !== null,
  requests: [], events: [], closures: [], quarantines: [] });
assert.deepEqual(blocked, { code: 'UNKNOWN', available: false }, 'the caller must propagate the critical observation');
for (const operation of ['cancel', 'erase']) assert.deepEqual(inspectMutation(request, operation), { code: 'CLAIM_BLOCKED', mutate: false });
assert.equal(audit({ timing: { ...old, observationNowMs: 1100000 }, durationSettings: changed }, 'DURATION_EVIDENCE_REVIEW').timingState,
  'WITHIN_ASSUMED_WINDOW', 'the cutoff is strictly greater than the window');
audit({ timing: old }, 'STALE_CLAIM_OBSERVED');
audit({ timing: old, durationSettings: changed, nonces: [] }, 'CLAIM_WITHOUT_NONCE_OBSERVED');
audit({ timing: old, durationSettings: changed, nonces: [...input.nonces, ...input.nonces] }, 'NONCE_OBSERVATION_UNKNOWN');
audit({ timing: old, durationSettings: changed, properties: { ...properties, readable: false } }, 'PROPERTIES_NOT_VERIFIABLE');
audit({ timing: old, durationSettings: { ...changed, readable: false } }, 'DURATION_EVIDENCE_REVIEW');
for (const invalid of [undefined, { ...old, clockAssumedSynchronized: false }, { ...old, staleAfterMs: 0 },
  { ...old, observationNowMs: 999999 }, { ...old, observationNowMs: NaN }]) {
  audit({ timing: invalid }, 'TIMING_OBSERVATION_UNKNOWN');
}
for (const badTime of [undefined, -1, NaN, '1000000']) {
  audit({ requests: [{ ...request, claimObservedAtMs: badTime }] }, 'TIMING_OBSERVATION_UNKNOWN');
}
assert.equal(inspectIntegratedTrial(null).decision, 'RECONCILIATION_CRITICAL_AMBIGUITY');
assert.equal(JSON.stringify(input), before, 'the prototype must not mutate evidence');
console.log('Integrated trial audit model passed (offline observations only; no durable critical state).');
