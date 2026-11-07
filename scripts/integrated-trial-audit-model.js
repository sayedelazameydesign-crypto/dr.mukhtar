'use strict';

// A read-only in-memory staff-startup thought experiment. No real startup hook,
// Google read, transaction, authorization, repair or durable quarantine exists.
const { summarizeTrialEvidence } = require('./trial-reconciliation-model');
const { inspectProperties } = require('./properties-fault-model');
const { compareSubmissionAndClaim } = require('./submission-snapshot-model');
const { statusMinutes } = require('./operational-slot-model');

// The timestamp and clock are caller-supplied fixtures, not a proven claim-write
// timestamp or a synchronized clock. No timeout releases or expires a claim.
function inspectTiming(input, evidence, properties, row) {
  if (evidence.claimState !== 'CLAIM_PRESENT') return { state: 'NOT_APPLICABLE', suspect: false };
  const time = input && input.timing;
  if (!row || !time || time.clockAssumedSynchronized !== true ||
      !Number.isSafeInteger(time.observationNowMs) || time.observationNowMs < 0 ||
      !Number.isSafeInteger(time.staleAfterMs) || time.staleAfterMs <= 0 ||
      !Number.isSafeInteger(row.claimObservedAtMs) || row.claimObservedAtMs < 0 ||
      row.claimObservedAtMs > time.observationNowMs) return { state: 'UNKNOWN', suspect: false };
  if (time.observationNowMs - row.claimObservedAtMs <= time.staleAfterMs) return { state: 'WITHIN_ASSUMED_WINDOW', suspect: false };
  const settings = input.durationSettings;
  const catalogue = settings && settings.durations;
  const minutes = catalogue && typeof catalogue === 'object' && !Array.isArray(catalogue) &&
    typeof row.visitType === 'string' && row.visitType.trim() && Object.prototype.hasOwnProperty.call(catalogue, row.visitType)
    ? catalogue[row.visitType] : null;
  const settingsComparable = properties.code === 'SHAPE_OBSERVED_ONLY' && settings &&
    settings.readable === true && settings.complete === true && settings.stable === true &&
    typeof settings.revision === 'string' && settings.revision.trim() &&
    Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440;
  // A changed value relative to the claim's embedded duration does not prove a
  // config write, causal order, or that this nonce belongs to this request.
  return { state: 'STALE_OBSERVED', suspect: Boolean(settingsComparable &&
    evidence.nonceState === 'PRESENT' && minutes !== statusMinutes(row.status)) };
}

function inspectIntegratedTrial(input) {
  const evidence = summarizeTrialEvidence(input);
  const properties = inspectProperties(input && input.properties);
  const reasons = [];
  if (!['PRESENT', 'NOT_FOUND'].includes(evidence.nonceState)) reasons.push('NONCE_OBSERVATION_UNKNOWN');
  if (!['CLAIM_PRESENT', 'CONFIRMED_ROW', 'NO_CLAIM_OBSERVED'].includes(evidence.claimState)) reasons.push('REQUEST_OBSERVATION_UNKNOWN');
  if ((evidence.claimState === 'CLAIM_PRESENT' || evidence.claimState === 'CONFIRMED_ROW') && evidence.nonceState === 'NOT_FOUND') reasons.push('CLAIM_WITHOUT_NONCE_OBSERVED');
  if (evidence.claimState === 'NO_CLAIM_OBSERVED' && evidence.nonceState === 'PRESENT') reasons.push('NONCE_WITHOUT_CLAIM_OBSERVED');
  if (evidence.decision === 'RECONCILIATION_CRITICAL_AMBIGUITY') reasons.push('CALENDAR_OR_CROSS_SOURCE_AMBIGUITY');
  if (properties.code !== 'SHAPE_OBSERVED_ONLY') reasons.push('PROPERTIES_NOT_VERIFIABLE');

  let durationState = 'SUBMISSION_SNAPSHOT_UNKNOWN';
  let request = null;
  if (input && input.requestsReadable === true && Array.isArray(input.requests)) {
    const rows = input.requests.filter((row) => row && row.reference === input.reference);
    if (rows.length === 1) {
      request = rows[0];
      durationState = compareSubmissionAndClaim({ request, snapshot: input.submissionSnapshot,
        snapshotReadable: input.submissionSnapshotReadable, settings: input.durationSettings }).code;
    }
  }
  if (durationState !== 'DURATION_MATCH_OBSERVED') reasons.push('DURATION_EVIDENCE_REVIEW');
  const timing = inspectTiming(input, evidence, properties, request);
  if (timing.state === 'UNKNOWN') reasons.push('TIMING_OBSERVATION_UNKNOWN');
  if (timing.state === 'STALE_OBSERVED') reasons.push('STALE_CLAIM_OBSERVED');
  if (timing.suspect) reasons.push('TIMING_DRIFT_SUSPECT');
  return {
    decision: timing.suspect ? 'LEDGER_TIMING_DRIFT_SUSPECT' : reasons.length ? 'RECONCILIATION_CRITICAL_AMBIGUITY' : 'HUMAN_REVIEW_REQUIRED', reasons,
    nonceState: evidence.nonceState, claimState: evidence.claimState, calendarState: evidence.calendarState,
    propertiesState: properties.code, durationState, timingState: timing.state,
    relationship: 'UNPROVEN', actorIntent: 'NOT_DETERMINABLE', manualReviewRequired: true,
    allowAvailability: false, allowBooking: false, allowRepair: false, allowRelease: false, allowRetry: false,
    requiredQuarantine: reasons.length ? 'GLOBAL_OR_PROVEN_NARROWER' : null,
    quarantinePersisted: false
  };
}
module.exports = { inspectIntegratedTrial };
