'use strict';

// Local, read-only prototype. No authentication, lock, storage, Calendar, Sheets,
// working-hours validation or mutations. Returned decisions are NOT authorization.
const { statusClaim, statusMinutes, isBlocking } = require('./operational-slot-model');
const { cairoInterval } = require('./cairo-slot-model');
const KNOWN = new Set(['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'DELETED', 'NEEDS_REVIEW']);
function known(status) { return typeof status === 'string' && (KNOWN.has(status) || !!statusClaim(status)); }
function hasInterval(record) { return record && Number.isSafeInteger(record.startMs) && Number.isSafeInteger(record.endMs) && record.startMs < record.endMs; }
function overlaps(a, b) { return a.startMs < b.endMs && b.startMs < a.endMs; }

// Never changes the record. Further domain/permission/Calendar checks are required
// even on ordinary statuses; in particular this does NOT authorize guardian erasure.
function inspectMutation(record, operation) {
  if (!['cancel', 'erase'].includes(operation) || !record || !known(record.status)) return { code: 'UNKNOWN', mutate: false };
  if (statusClaim(record.status) || record.status === 'NEEDS_REVIEW') return { code: 'CLAIM_BLOCKED', mutate: false };
  return { code: 'FURTHER_CHECKS_REQUIRED', mutate: false };
}

// Takes complete, independent, already-read fake snapshots: this function does not
// read external services or prove their freshness. Quarantines are required input;
// they are not created or persisted by this model. Every read failure fails closed.
function inspectAvailability(input) {
  if (!input || input.requestsReadable !== true || input.calendarReadable !== true ||
      input.closuresReadable !== true || input.quarantinesReadable !== true || input.ambiguityScanComplete !== true ||
      typeof input.criticalAmbiguity !== 'boolean' || !Array.isArray(input.requests) || !Array.isArray(input.events) ||
      !Array.isArray(input.closures) || !Array.isArray(input.quarantines)) return { code: 'UNKNOWN', available: false };
  // Without a proven correlation/scope and durable hold, deny all slots rather than
  // falsely asserting that an interval was quarantined.
  if (input.criticalAmbiguity) return { code: 'UNKNOWN', available: false };
  const candidate = cairoInterval(input.day, input.time, input.visitType, input.durations);
  if (candidate.code !== 'OK') return { code: 'UNKNOWN', available: false };
  const refs = new Set();
  const claims = new Set();
  let blocked = false;
  for (const row of input.requests) {
    if (!row || typeof row.reference !== 'string' || !row.reference.trim() || refs.has(row.reference) || !known(row.status)) return { code: 'UNKNOWN', available: false };
    refs.add(row.reference);
    const claimId = statusClaim(row.status);
    if (claimId && claims.has(claimId)) return { code: 'UNKNOWN', available: false };
    if (claimId) claims.add(claimId);
    if (!isBlocking(row.status)) continue;
    // The current service catalogue can change after a claim. Claims carry their
    // captured minutes in the status; other blocking states still need an external
    // verified snapshot. Neither mechanism exists in the actual GAS backend.
    if (typeof row.visitType !== 'string' || !row.visitType) return { code: 'UNKNOWN', available: false };
    let minutes = statusMinutes(row.status);
    if (minutes === null) {
      if (input.reservationDurationsReadable !== true || !input.reservationDurations ||
          typeof input.reservationDurations !== 'object' || Array.isArray(input.reservationDurations) ||
          !Object.prototype.hasOwnProperty.call(input.reservationDurations, row.reference)) return { code: 'UNKNOWN', available: false };
      const captured = input.reservationDurations[row.reference];
      if (!captured || typeof captured !== 'object' || captured.status !== row.status ||
          captured.day !== row.day || captured.time !== row.time || captured.visitType !== row.visitType) return { code: 'UNKNOWN', available: false };
      minutes = captured.minutes;
    }
    const capturedCatalogue = Object.create(null);
    capturedCatalogue[row.visitType] = minutes;
    const interval = cairoInterval(row.day, row.time, row.visitType, capturedCatalogue);
    if (interval.code !== 'OK') return { code: 'UNKNOWN', available: false };
    if (overlaps(candidate, interval)) blocked = true;
  }
  for (const interval of [...input.events, ...input.closures]) {
    if (!hasInterval(interval)) return { code: 'UNKNOWN', available: false };
    if (overlaps(candidate, interval)) blocked = true;
  }
  for (const hold of input.quarantines) {
    if (!hold || !['GLOBAL', 'INTERVAL'].includes(hold.scope)) return { code: 'UNKNOWN', available: false };
    if (hold.scope === 'GLOBAL') blocked = true;
    else if (!hasInterval(hold)) return { code: 'UNKNOWN', available: false };
    else if (overlaps(candidate, hold)) blocked = true;
  }
  if (blocked) return { code: 'BLOCKED', available: false };
  // No positive availability claim: hours, complete external participation, race
  // prevention and provider state are outside this model.
  return { code: 'NO_CONFLICT_OBSERVED', available: null };
}
module.exports = { inspectMutation, inspectAvailability };
