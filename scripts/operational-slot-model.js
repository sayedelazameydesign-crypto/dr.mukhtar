'use strict';

// Pure offline decision model. It does not acquire locks, write Sheets, authenticate,
// create events, retry or release holds. Its composite status is NOT compatible with
// the current GAS code without a separate, comprehensive migration and review.
// Intervals are resolved epoch milliseconds [startMs, endMs), not sheet cell values.
const ELIGIBLE = new Set(['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED']);
const NONBLOCKING = new Set(['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED', 'CANCELLED', 'COMPLETED', 'DELETED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREFIX = 'UNDER_CREATION::';

function statusClaim(status) {
  if (typeof status !== 'string' || !status.startsWith(PREFIX)) return null;
  const claim = status.slice(PREFIX.length);
  return UUID.test(claim) ? claim : null;
}
function isBlocking(status) { return status === 'CONFIRMED' || status === 'NEEDS_REVIEW' || statusClaim(status) !== null; }
function isKnown(status) { return NONBLOCKING.has(status) || isBlocking(status); }
function validInterval(value) {
  return value && Number.isSafeInteger(value.startMs) && Number.isSafeInteger(value.endMs) && value.startMs < value.endMs;
}
function overlaps(a, b) { return a.startMs < b.endMs && b.startMs < a.endMs; }
function validId(value) { return typeof value === 'string' && value.trim().length > 0; }
function result(code, detail) { return Object.assign({ code }, detail || {}); }
function validRows(records) {
  const references = new Set();
  const claims = new Set();
  for (const row of records) {
    if (!row || !validId(row.reference) || references.has(row.reference) || !isKnown(row.status)) return false;
    references.add(row.reference);
    const claim = statusClaim(row.status);
    if (claim && claims.has(claim)) return false;
    if (claim) claims.add(claim);
    if (isBlocking(row.status) && !validInterval(row)) return false;
  }
  return true;
}

// Proposal only. Even a successful result never permits a Calendar call unless a
// real caller proves reservation persistence and coordinates every relevant writer.
function acquireOperationalSlot(input) {
  if (!input || input.lockHeld !== true) return result('LOCK_TIMEOUT');
  if (input.snapshotComplete !== true || !Array.isArray(input.records) || !validRows(input.records)) return result('UNKNOWN');
  if (!validId(input.reference) || !UUID.test(input.claimId || '')) return result('INVALID_INPUT');
  const record = input.records.find((row) => row.reference === input.reference);
  if (!record) return result('NOT_FOUND');
  if (!ELIGIBLE.has(record.status)) return result('ALREADY_PROCESSED');
  if (!validInterval(record)) return result('UNKNOWN');
  if (input.records.some((row) => statusClaim(row.status) === input.claimId)) return result('CLAIM_ID_REUSED');
  if (input.records.some((row) => row.reference !== record.reference && isBlocking(row.status) && overlaps(row, record))) return result('CONFLICT');
  return result('RESERVATION_PROPOSED', {
    reservation: { reference: record.reference, startMs: record.startMs, endMs: record.endMs, status: PREFIX + input.claimId }
  });
}

// Snapshot completeness is assumed by this model and does not prevent an external
// Calendar edit after verification. No event is ever created or deleted here.
function verifyCalendarEvent(input) {
  const reservation = input && input.reservation;
  const claimId = reservation && statusClaim(reservation.status);
  if (!reservation || !claimId || !validId(reservation.reference) || !validInterval(reservation)) return result('INVALID_INPUT');
  if (input.snapshotComplete !== true || !Array.isArray(input.events)) return result('NEEDS_REVIEW');
  if (input.events.some((event) => !event || !validId(event.id) || !validInterval(event) || typeof event.description !== 'string')) return result('NEEDS_REVIEW');
  const marker = 'مرجع إداري: ' + reservation.reference;
  const matches = input.events.filter((event) => event.description.split(/\r?\n/).some((line) => line.trim() === marker));
  if (matches.length !== 1) return result('NEEDS_REVIEW');
  const event = matches[0];
  if (event.startMs !== reservation.startMs || event.endMs !== reservation.endMs ||
      input.events.some((other) => other !== event && overlaps(other, reservation))) return result('NEEDS_REVIEW');
  return result('EVENT_VERIFIED', {
    reference: reservation.reference, claimId, startMs: reservation.startMs, endMs: reservation.endMs, eventId: event.id
  });
}

// Proposes a transition only. Neither a durable write nor live reconciliation is done.
function finalizeSlotStatus(input) {
  if (!input || input.lockHeld !== true) return result('LOCK_TIMEOUT');
  if (input.snapshotComplete !== true || !Array.isArray(input.records) || !validRows(input.records)) return result('UNKNOWN');
  const proof = input.verification;
  if (!proof || proof.code !== 'EVENT_VERIFIED' || !validId(proof.reference) || !UUID.test(proof.claimId || '') || !validId(proof.eventId) || !validInterval(proof)) return result('NEEDS_REVIEW');
  const row = input.records.find((record) => record.reference === proof.reference);
  if (!row || statusClaim(row.status) !== proof.claimId || row.startMs !== proof.startMs || row.endMs !== proof.endMs) return result('NEEDS_REVIEW');
  if (input.records.some((other) => other.reference !== row.reference && isBlocking(other.status) && overlaps(other, row))) return result('NEEDS_REVIEW');
  return result('CONFIRMATION_PROPOSED', { reference: row.reference, claimId: proof.claimId, eventId: proof.eventId });
}

module.exports = { acquireOperationalSlot, verifyCalendarEvent, finalizeSlotStatus, statusClaim, isBlocking };
