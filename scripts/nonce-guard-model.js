'use strict';

// Deterministic in-memory scheduler, synthetic fixtures only. The lock models
// cooperating calls inside ONE process; neither it nor the uncertainty latch is
// durable. No GAS, authentication, Requests, Calendar, or distributed transaction.
const FIXTURE = /^fixture-[a-z0-9-]{1,80}$/;
function outcome(code) {
  return { code, originalResult: 'UNKNOWN', allowBooking: false, allowRetry: false,
    allowRelease: false, manualReviewRequired: true, quarantinePersisted: false };
}
function createNonceGuard(initialRows = []) {
  if (!Array.isArray(initialRows)) throw new TypeError('Expected synthetic fixture rows');
  const rows = initialRows.map((row) => row && typeof row === 'object' ? { ...row } : row);
  const attempts = new Map();
  let owner = null;
  let uncertain = false;
  function done(id, code, markUnknown = false) {
    if (markUnknown) uncertain = true; // volatile global latch, NOT a durable quarantine
    if (owner === id) owner = null; // only an assumption of this scheduler
    const attempt = attempts.get(id);
    attempt.phase = 'DONE'; attempt.result = outcome(code);
    return attempt.result;
  }
  function start(id, nonce) {
    if (typeof id !== 'string' || !FIXTURE.test(id) || typeof nonce !== 'string' || !FIXTURE.test(nonce) || attempts.has(id)) return outcome('INVALID_INPUT');
    attempts.set(id, { nonce, phase: 'WAIT_LOCK', result: null });
    return outcome('IN_PROGRESS');
  }
  function advance(id, fault = null) {
    const attempt = attempts.get(id);
    if (!attempt) return outcome('INVALID_INPUT');
    if (attempt.phase === 'DONE') return attempt.result;
    if (attempt.phase === 'WAIT_LOCK') {
      if (fault !== null) return outcome('INVALID_INJECTION');
      if (uncertain) return done(id, 'RECONCILIATION_REQUIRED');
      if (owner !== null) return outcome('WAITING_FOR_LOCK');
      owner = id; attempt.phase = 'READ';
      return outcome('LOCK_ACQUIRED');
    }
    if (owner !== id) throw new Error('Scheduler invariant failed');
    if (attempt.phase === 'READ') {
      if (fault === 'READ_FAILURE' || fault === 'CRASH_BEFORE_READ') return done(id, 'NONCE_STORAGE_UNKNOWN', true);
      if (fault !== null) return outcome('INVALID_INJECTION');
      const seen = new Set();
      for (const row of rows) {
        if (!row || typeof row.nonce_id !== 'string' || !FIXTURE.test(row.nonce_id) ||
            typeof row.consumed_at !== 'string' || !row.consumed_at || seen.has(row.nonce_id)) return done(id, 'NONCE_STORAGE_UNKNOWN', true);
        seen.add(row.nonce_id);
      }
      if (seen.has(attempt.nonce)) return done(id, 'REJECTED_DUPLICATE_NONCE');
      attempt.phase = 'WRITE';
      return outcome('READY_TO_WRITE');
    }
    if (attempt.phase === 'WRITE') {
      if (fault === 'CRASH_BEFORE_WRITE' || fault === 'WRITE_EXCEPTION_NOT_APPLIED') return done(id, 'NONCE_STORAGE_UNKNOWN', true);
      if (fault === 'WRITE_EXCEPTION_APPLIED' || fault === 'CRASH_AFTER_WRITE') {
        rows.push({ nonce_id: attempt.nonce, consumed_at: 'fixture-time' });
        return done(id, 'NONCE_STORAGE_UNKNOWN', true);
      }
      if (fault !== null) return outcome('INVALID_INJECTION');
      rows.push({ nonce_id: attempt.nonce, consumed_at: 'fixture-time' });
      return done(id, 'NONCE_CONSUMED'); // neither proof of persistence nor booking authorization
    }
    throw new Error('Scheduler invariant failed');
  }
  function timeout(id) {
    const attempt = attempts.get(id);
    if (!attempt || attempt.phase !== 'WAIT_LOCK' || owner === null || owner === id) return outcome('INVALID_INPUT');
    return done(id, 'LOCK_TIMEOUT');
  }
  function inspectFixture(nonce) {
    if (typeof nonce !== 'string' || !FIXTURE.test(nonce)) return null;
    return { matchingRows: rows.filter((row) => row && row.nonce_id === nonce).length,
      lockHeld: owner !== null, uncertain, quarantinePersisted: false };
  }
  return { start, advance, timeout, inspectFixture };
}
module.exports = { createNonceGuard };
