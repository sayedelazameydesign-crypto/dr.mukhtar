#!/usr/bin/env node
'use strict';
// Synthetic snapshots only; no real Sheets, Calendar, nonce authentication or hold.
const assert = require('node:assert/strict');
const { summarizeTrialEvidence } = require('./trial-reconciliation-model');
const { inspectAvailability } = require('./path-refinement-model');
const claim = 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::60';
const input = { nonce: 'trial-nonce', reference: 'TST-1', noncesReadable: true, requestsReadable: true,
  nonces: [{ nonce_id: 'trial-nonce', consumed_at: '2026-11-07T00:00:00Z' }], requests: [{ reference: 'TST-1', status: claim }],
  calendarReadable: true, matchingEventCount: 1, calendarConflict: false };
function inspect(changes, expectedNonce, expectedClaim, critical = false, expectedCalendar = 'MATCHES_OBSERVED') {
  const result = summarizeTrialEvidence({ ...input, ...changes });
  assert.equal(result.nonceState, expectedNonce); assert.equal(result.claimState, expectedClaim); assert.equal(result.calendarState, expectedCalendar);
  assert.equal(result.relationship, 'UNPROVEN'); assert.equal(result.actorIntent, 'NOT_DETERMINABLE');
  assert.equal(result.decision, critical ? 'RECONCILIATION_CRITICAL_AMBIGUITY' : 'HUMAN_REVIEW_REQUIRED');
  assert.equal(result.requiredQuarantine, critical ? 'GLOBAL_OR_PROVEN_NARROWER' : null);
  assert.equal(result.quarantinePersisted, false, 'a decision is not a durable hold');
  assert.equal(result.allowRelease, false); assert.equal(result.allowRetry, false);
}
inspect({}, 'PRESENT', 'CLAIM_PRESENT');
inspect({ requests: [{ reference: 'TST-1', status: 'PENDING_APPROVAL' }] }, 'PRESENT', 'NO_CLAIM_OBSERVED', true);
inspect({ matchingEventCount: 0 }, 'PRESENT', 'CLAIM_PRESENT', true, 'NO_MATCH_OBSERVED');
inspect({ matchingEventCount: 2 }, 'PRESENT', 'CLAIM_PRESENT', true, 'MULTIPLE_MATCHES_OBSERVED');
inspect({ matchingEventCount: 1, calendarConflict: true }, 'PRESENT', 'CLAIM_PRESENT', true, 'CONFLICT_OBSERVED');
inspect({ calendarReadable: false }, 'PRESENT', 'CLAIM_PRESENT', true, 'UNKNOWN');
inspect({ calendarConflict: undefined }, 'PRESENT', 'CLAIM_PRESENT', true, 'UNKNOWN');
inspect({ matchingEventCount: -1 }, 'PRESENT', 'CLAIM_PRESENT', true, 'UNKNOWN');
inspect({ requests: [{ reference: 'TST-1', status: 'CONFIRMED' }], matchingEventCount: 0 }, 'PRESENT', 'CONFIRMED_ROW', true, 'NO_MATCH_OBSERVED');
inspect({ nonces: [] }, 'NOT_FOUND', 'CLAIM_PRESENT');
inspect({ nonces: [], requests: [{ reference: 'TST-1', status: 'REQUESTED' }] }, 'NOT_FOUND', 'NO_CLAIM_OBSERVED');
inspect({ noncesReadable: false }, 'UNKNOWN', 'CLAIM_PRESENT');
inspect({ requestsReadable: false }, 'PRESENT', 'UNKNOWN');
inspect({ nonces: [...input.nonces, ...input.nonces] }, 'DUPLICATE_ROWS', 'CLAIM_PRESENT');
inspect({ requests: [...input.requests, ...input.requests] }, 'PRESENT', 'DUPLICATE_ROWS');
inspect({ requests: [{ reference: 'TST-1', status: 'UNDER_CREATION::bad' }] }, 'PRESENT', 'UNKNOWN_STATUS');
inspect({ nonces: [{ nonce_id: 'trial-nonce' }] }, 'INVALID_SNAPSHOT', 'CLAIM_PRESENT');
inspect({ requests: [{ reference: 'TST-1', status: 'CONFIRMED' }] }, 'PRESENT', 'CONFIRMED_ROW');
const ambiguous = summarizeTrialEvidence({ ...input, requests: [{ reference: 'TST-1', status: 'PENDING_APPROVAL' }] });
const availability = inspectAvailability({ day: '2026-11-05', time: '09:00', visitType: 'كشف', durations: { 'كشف': 60 },
  requestsReadable: true, calendarReadable: true, closuresReadable: true, quarantinesReadable: true,
  ambiguityScanComplete: true, criticalAmbiguity: ambiguous.decision === 'RECONCILIATION_CRITICAL_AMBIGUITY',
  requests: [], events: [], closures: [], quarantines: [] });
assert.deepEqual(availability, { code: 'UNKNOWN', available: false }, 'an unresolved ambiguous snapshot fails closed globally in this simulation');
// A hypothetical separate in-memory hold is a fixture, not an implementation of a
// durable write or cross-sheet transaction. Absence is not evidence of safety.
const fakeHold = { scope: 'GLOBAL', reason: ambiguous.decision };
const withHold = inspectAvailability({ day: '2026-11-05', time: '09:00', visitType: 'كشف', durations: { 'كشف': 60 },
  requestsReadable: true, calendarReadable: true, closuresReadable: true, quarantinesReadable: true,
  ambiguityScanComplete: true, criticalAmbiguity: false, requests: [], events: [], closures: [], quarantines: [fakeHold] });
assert.deepEqual(withHold, { code: 'BLOCKED', available: false }, 'a supplied in-memory quarantine blocks');
assert.equal(ambiguous.quarantinePersisted, false, 'the classifier itself wrote nothing');
console.log('Trial reconciliation model passed (read-only; no durable quarantine, intent inference or safe release).');
// Existing CI invokes this entry point directly. Keep the local safety suite here so
// it also runs in that CI step without changing a workflow or production code.
require('./test-submission-snapshot-model');
require('./test-properties-faults');
require('./test-integrated-trial-audit-model');
require('./test-staff-warning-model');
require('./test-nonce-guard-model');
