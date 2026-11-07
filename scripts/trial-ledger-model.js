'use strict';

// Structural model for synthetic contention-ledger fixtures only. It neither logs
// nor stores records, proves simultaneity, authorizes requests, nor deploys GAS.
const FIELDS = ['suite', 'runId', 'roundId', 'attemptId', 'testReference', 'deploymentVersion', 'timestamps', 'outcome', 'finalSheetStatus', 'matchingEventCount', 'errorCode'];
const TIMES = ['startedAt', 'lock1Acquired', 'reservationPersisted', 'calendarCallStarted', 'calendarCallFinished', 'lock2Acquired', 'finishedAt'];
const OUTCOMES = new Set(['CONFIRMED', 'CONFLICT', 'LOCK_TIMEOUT', 'NEEDS_REVIEW', 'UNKNOWN', 'NONCE_STORAGE_UNKNOWN', 'REJECTED_DUPLICATE_NONCE']);
const STATES = new Set(['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED', 'UNDER_CREATION', 'CONFIRMED', 'NEEDS_REVIEW', 'UNKNOWN']);
function exactKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object) &&
    Object.keys(object).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(object, key));
}
function validateContentionLedger(rows) {
  if (!Array.isArray(rows) || rows.length !== 30) return { ok: false, code: 'EXPECTED_30_RECORDS' };
  const attempts = new Set();
  const refs = new Set();
  let runId; let deploymentVersion;
  for (const row of rows) {
    if (!exactKeys(row, FIELDS) || row.suite !== 'contention' ||
        typeof row.runId !== 'string' || !/^TST-RUN-[A-Z0-9-]{1,40}$/.test(row.runId) ||
        !Number.isInteger(row.roundId) || row.roundId < 1 || row.roundId > 3 ||
        !Number.isInteger(row.attemptId) || row.attemptId < 0 || row.attemptId > 9 ||
        typeof row.testReference !== 'string' || !/^TST-[A-Z0-9-]{1,40}$/.test(row.testReference) ||
        !Number.isSafeInteger(row.deploymentVersion) || row.deploymentVersion < 0 ||
        !OUTCOMES.has(row.outcome) || !STATES.has(row.finalSheetStatus) ||
        !(row.matchingEventCount === null || (Number.isSafeInteger(row.matchingEventCount) && row.matchingEventCount >= 0)) ||
        !(row.errorCode === null || (typeof row.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(row.errorCode))) ||
        !exactKeys(row.timestamps, TIMES) ||
        !TIMES.every((key) => row.timestamps[key] === null || (Number.isSafeInteger(row.timestamps[key]) && row.timestamps[key] >= 0))) return { ok: false, code: 'INVALID_RECORD' };
    if (runId === undefined) { runId = row.runId; deploymentVersion = row.deploymentVersion; }
    if (row.runId !== runId || row.deploymentVersion !== deploymentVersion) return { ok: false, code: 'MIXED_RUN' };
    const attempt = `${row.roundId}:${row.attemptId}`;
    if (attempts.has(attempt) || refs.has(row.testReference)) return { ok: false, code: 'DUPLICATE_FIXTURE' };
    attempts.add(attempt); refs.add(row.testReference);
  }
  // 30 unique round/attempt pairs within the declared 3x10 range form a complete fixture.
  return { ok: true, code: 'STRUCTURALLY_VALID_ONLY', count: rows.length };
}
module.exports = { validateContentionLedger };
