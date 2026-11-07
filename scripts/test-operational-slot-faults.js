#!/usr/bin/env node
'use strict';

// Executable fault specification, NOT the GAS backend. In-memory, sequential fakes
// deliberately explore both possible outcomes of an ambiguous write/flush. This test
// cannot establish actual Apps Script atomicity, lock behavior, delivery or durability.
const assert = require('node:assert/strict');
const { acquireOperationalSlot, verifyCalendarEvent, finalizeSlotStatus } = require('./operational-slot-model');
const CLAIM_A = '123e4567-e89b-42d3-a456-426614174000';
const CLAIM_B = '123e4567-e89b-42d3-a456-426614174001';

class FakeWorld {
  constructor(fault = '') {
    this.fault = fault;
    this.locked = false;
    this.nonces = new Set();
    this.records = [
      { reference: 'A', status: 'PENDING_APPROVAL', startMs: 60000, endMs: 3660000 },
      { reference: 'B', status: 'PENDING_APPROVAL', startMs: 1860000, endMs: 5460000 }
    ];
    this.events = [];
    this.calendarCalls = 0;
    this.pending = null;
  }
  fail(point) { if (this.fault === point) throw new Error('injected:' + point); }
  lock(point) {
    this.fail(point);
    assert.equal(this.locked, false, 'fake lock cannot be nested');
    this.locked = true;
  }
  unlock() { this.locked = false; }
  persist() {
    assert.ok(this.pending, 'fixture must have a pending write');
    this.pending();
    this.pending = null;
  }
  // before/after model a failure where no write survived vs where it did.
  write(point, apply) {
    assert.equal(this.locked, true, 'fixture writes under its fake lock');
    this.fail(point + ':before');
    this.pending = apply;
    if (this.fault === point + ':after') { this.persist(); throw new Error('injected:' + point + ':after'); }
  }
  flush(point) {
    assert.equal(this.locked, true, 'fixture flushes under its fake lock');
    this.fail(point + ':before');
    this.persist();
    this.fail(point + ':after');
  }
  createEvent(reference, row) {
    assert.equal(this.locked, false, 'Calendar creation must be outside fake lock');
    this.calendarCalls += 1;
    this.fail('calendar-create:before');
    const event = { id: 'event-' + reference, startMs: row.startMs, endMs: row.endMs, description: 'مرجع إداري: ' + reference };
    this.events.push(event);
    this.fail('calendar-create:after');
    return event;
  }
  readEvents() {
    assert.equal(this.locked, false, 'Calendar read must be outside fake lock');
    this.calendarCalls += 1;
    this.fail('calendar-read');
    return this.events.map((event) => ({ ...event }));
  }
  restart() {
    // Unknown unflushed state is explored via before/after fault variants; do not
    // silently treat the pending fake operation as committed after an interruption.
    this.pending = null;
    this.locked = false;
    this.fault = '';
  }
  row(reference) { return this.records.find((record) => record.reference === reference); }
}

// Independent nonce-storage decision. This fake has no authentication logic; an
// I/O error is never classified as an authorization rejection or as a duplicate.
function consumeTrialNonce(world, nonce) {
  assert.equal(world.locked, true);
  try {
    world.fail('nonce-read');
    if (world.nonces.has(nonce)) return 'REJECTED_DUPLICATE_NONCE';
    world.write('nonce-write', () => world.nonces.add(nonce));
    world.flush('nonce-flush');
    return 'CONSUMED';
  } catch (error) {
    if (!error.message.startsWith('injected:nonce-')) throw error;
    return 'NONCE_STORAGE_UNKNOWN';
  }
}

// A deliberately limited in-memory experiment. It uses the decision model, NOT a
// real implementation of authentication, durable nonces, Calendar preflight,
// Sheets schema, manual review, concurrent execution or crash recovery.
function attempt(world, reference, nonce) {
  let lockPhase = 'lock1';
  try {
    world.lock('lock1');
    const nonceOutcome = consumeTrialNonce(world, nonce);
    if (nonceOutcome !== 'CONSUMED') return { outcome: nonceOutcome };
    const proposed = acquireOperationalSlot({ lockHeld: world.locked, snapshotComplete: true, records: world.records, reference, claimId: reference === 'A' ? CLAIM_A : CLAIM_B });
    if (proposed.code !== 'RESERVATION_PROPOSED') return { outcome: proposed.code };
    world.write('claim-write', () => { world.records = world.records.map((row) => row.reference === reference ? { ...proposed.reservation } : row); });
    world.flush('claim-flush');
    world.unlock();
    world.fail('after-claim');
    world.createEvent(reference, proposed.reservation);
    const verification = verifyCalendarEvent({ reservation: proposed.reservation, snapshotComplete: true, events: world.readEvents() });
    if (verification.code !== 'EVENT_VERIFIED') return { outcome: 'NEEDS_REVIEW' };
    lockPhase = 'lock2';
    world.lock('lock2');
    const decision = finalizeSlotStatus({ lockHeld: world.locked, snapshotComplete: true, records: world.records, verification });
    if (decision.code !== 'CONFIRMATION_PROPOSED') return { outcome: decision.code };
    world.write('final-write', () => {
      world.records = world.records.map((row) => row.reference === reference ? { ...row, status: 'CONFIRMED', eventId: decision.eventId } : row);
    });
    world.flush('final-flush');
    return { outcome: 'CONFIRMED' };
  } catch (error) {
    if (!error || typeof error.message !== 'string' || !error.message.startsWith('injected:')) throw error;
    if (error.message === 'injected:lock1') return { outcome: 'LOCK_TIMEOUT' };
    // An unavailable second lock follows possible Calendar creation: do not call it
    // an ordinary retryable timeout. The previous persisted claim remains blocking.
    return { outcome: 'UNKNOWN', phase: lockPhase };
  } finally {
    if (world.locked) world.unlock();
  }
}

function fresh(fault) { return new FakeWorld(fault); }
function assertBlocking(world) {
  world.restart();
  const a = attempt(world, 'A', 'other-nonce-A');
  const b = attempt(world, 'B', 'other-nonce-B');
  assert.equal(a.outcome, 'ALREADY_PROCESSED', 'original claim blocks same-reference re-entry');
  assert.equal(b.outcome, 'CONFLICT', 'claim/confirmed interval blocks a competing reference');
}

{
  const world = fresh();
  assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'CONFIRMED');
  assert.equal(world.row('A').status, 'CONFIRMED');
  assert.equal(world.events.length, 1);
  assert.equal(attempt(world, 'B', 'nonce-B').outcome, 'CONFLICT');
  assert.equal(world.events.length, 1);
}
{
  const world = fresh('lock1');
  assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'LOCK_TIMEOUT');
  assert.equal(world.nonces.size, 0); assert.equal(world.calendarCalls, 0);
  assert.equal(world.row('A').status, 'PENDING_APPROVAL');
}

{
  const world = fresh('nonce-read');
  assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'NONCE_STORAGE_UNKNOWN');
  assert.equal(world.nonces.size, 0);
  assert.equal(world.calendarCalls, 0);
  assert.equal(world.row('A').status, 'PENDING_APPROVAL');
}

for (const operation of ['nonce-write', 'nonce-flush']) {
  for (const effect of ['before', 'after']) {
    const world = fresh(`${operation}:${effect}`);
    const original = attempt(world, 'A', 'nonce-A');
    assert.equal(original.outcome, 'NONCE_STORAGE_UNKNOWN');
    assert.equal(world.calendarCalls, 0, 'nonce ambiguity never reaches Calendar');
    assert.equal(world.row('A').status, 'PENDING_APPROVAL');
    world.restart();
    assert.equal(world.nonces.has('nonce-A'), effect === 'after', 'both persistence outcomes are represented');
    const replay = attempt(world, 'A', 'nonce-A');
    assert.equal(replay.outcome, effect === 'after' ? 'REJECTED_DUPLICATE_NONCE' : 'CONFIRMED');
    assert.equal(original.outcome, 'NONCE_STORAGE_UNKNOWN', 'replay result does not rewrite original result');
  }
}

for (const operation of ['claim-write', 'claim-flush']) {
  for (const effect of ['before', 'after']) {
    const world = fresh(`${operation}:${effect}`);
    assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'UNKNOWN');
    assert.equal(world.calendarCalls, 0, 'ambiguous claim write cannot call Calendar');
    assert.equal(world.nonces.has('nonce-A'), true, 'nonce and claim are separate writes');
    assert.equal(world.row('A').status, effect === 'after' ? `UNDER_CREATION::${CLAIM_A}::60` : 'PENDING_APPROVAL');
    world.restart();
    assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'REJECTED_DUPLICATE_NONCE');
    if (effect === 'after') {
      assertBlocking(world);
      assert.equal(world.calendarCalls, 0);
    }
  }
}

for (const fault of ['after-claim', 'calendar-create:before', 'calendar-create:after', 'calendar-read', 'lock2']) {
  const world = fresh(fault);
  const original = attempt(world, 'A', 'nonce-A');
  assert.equal(original.outcome, 'UNKNOWN', fault);
  assert.equal(world.row('A').status, `UNDER_CREATION::${CLAIM_A}::60`, fault);
  assert.equal(world.events.length, ['calendar-create:after', 'calendar-read', 'lock2'].includes(fault) ? 1 : 0);
  const calls = world.calendarCalls;
  assertBlocking(world);
  assert.equal(world.calendarCalls, calls, 'no automatic retry, Calendar call or deletion on blocked attempts');
  assert.equal(original.outcome, 'UNKNOWN');
}

{
  const world = fresh('calendar-create:after');
  const original = attempt(world, 'A', 'nonce-A');
  assert.equal(original.outcome, 'UNKNOWN');
  assert.equal(world.events.length, 1);
  const calls = world.calendarCalls;
  world.restart();
  assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'REJECTED_DUPLICATE_NONCE');
  assert.equal(original.outcome, 'UNKNOWN', 'rejecting replay does not settle the original operation');
  assert.equal(world.calendarCalls, calls);
  assert.equal(world.events.length, 1);
}

for (const operation of ['final-write', 'final-flush']) {
  for (const effect of ['before', 'after']) {
    const world = fresh(`${operation}:${effect}`);
    assert.equal(attempt(world, 'A', 'nonce-A').outcome, 'UNKNOWN');
    assert.equal(world.row('A').status, effect === 'after' ? 'CONFIRMED' : `UNDER_CREATION::${CLAIM_A}::60`);
    assert.equal(world.events.length, 1, 'event remains even when confirmation result is ambiguous');
    const calls = world.calendarCalls;
    assertBlocking(world);
    assert.equal(world.events.length, 1);
    assert.equal(world.calendarCalls, calls, 'blocked retries do not touch Calendar');
  }
}

console.log('Fault specification passed: in-memory before/after writes, flushes, interruption and blocking (not GAS evidence).');
