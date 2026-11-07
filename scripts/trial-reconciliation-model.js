'use strict';

// Read-only local evidence classifier. No authorization, Google I/O, mutation,
// release, retry, or conclusion about an actor's intent is implemented here.
const { statusClaim } = require('./operational-slot-model');
function summarizeTrialEvidence(input) {
  const result = { decision: 'HUMAN_REVIEW_REQUIRED', nonceState: 'UNKNOWN', claimState: 'UNKNOWN', calendarState: 'UNKNOWN',
    relationship: 'UNPROVEN', actorIntent: 'NOT_DETERMINABLE', allowRelease: false, allowRetry: false,
    requiredQuarantine: null, quarantinePersisted: false };
  if (!input || typeof input.nonce !== 'string' || !input.nonce || typeof input.reference !== 'string' || !input.reference) return result;
  if (input.noncesReadable === true && Array.isArray(input.nonces)) {
    if (input.nonces.some((row) => !row || typeof row.nonce_id !== 'string' || !row.nonce_id || typeof row.consumed_at !== 'string' || !row.consumed_at)) result.nonceState = 'INVALID_SNAPSHOT';
    else {
      const found = input.nonces.filter((row) => row.nonce_id === input.nonce);
      result.nonceState = found.length === 0 ? 'NOT_FOUND' : found.length === 1 ? 'PRESENT' : 'DUPLICATE_ROWS';
    }
  }
  if (input.requestsReadable === true && Array.isArray(input.requests)) {
    if (input.requests.some((row) => !row || typeof row.reference !== 'string' || !row.reference || typeof row.status !== 'string')) result.claimState = 'INVALID_SNAPSHOT';
    else {
      const found = input.requests.filter((row) => row.reference === input.reference);
      if (found.length === 0) result.claimState = 'NOT_FOUND';
      else if (found.length > 1) result.claimState = 'DUPLICATE_ROWS';
      else if (statusClaim(found[0].status)) result.claimState = 'CLAIM_PRESENT';
      else if (found[0].status === 'CONFIRMED') result.claimState = 'CONFIRMED_ROW';
      else if (['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(found[0].status)) result.claimState = 'NO_CLAIM_OBSERVED';
      else result.claimState = 'UNKNOWN_STATUS';
    }
  }
  if (input.calendarReadable === true && Number.isSafeInteger(input.matchingEventCount) && input.matchingEventCount >= 0) {
    result.calendarState = input.matchingEventCount === 0 ? 'NO_MATCH_OBSERVED' : 'MATCHES_OBSERVED';
  }
  // This is conservative: the nonce and request may not belong to each other.
  // A missing event may appear later. Neither condition proves a remote outcome.
  if ((result.nonceState === 'PRESENT' && result.claimState === 'NO_CLAIM_OBSERVED') ||
      (result.claimState === 'CLAIM_PRESENT' && result.calendarState !== 'MATCHES_OBSERVED')) {
    result.decision = 'RECONCILIATION_CRITICAL_AMBIGUITY';
    // No durable quarantine exists here. Without a trustworthy bound interval,
    // the actual implementation must fail closed globally or prove a safer scope.
    result.requiredQuarantine = 'GLOBAL_OR_PROVEN_NARROWER';
  }
  // TrialNonces(nonce_id, consumed_at) has no binding to request/claim identity.
  // Even both present cannot establish that they came from the same attempt.
  return result;
}
module.exports = { summarizeTrialEvidence };
