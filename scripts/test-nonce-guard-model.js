#!/usr/bin/env node
'use strict';
// Explicit interleavings and injected faults in ONE fake process, not threads or GAS.
const assert = require('node:assert/strict');
const { createNonceGuard } = require('./nonce-guard-model');
const { warningForNonce } = require('./staff-warning-model');
const nonce = 'fixture-nonce-1';
function result(r, code) {
  assert.equal(r.code, code); assert.equal(r.originalResult, 'UNKNOWN');
  assert.equal(r.allowBooking, false); assert.equal(r.allowRetry, false); assert.equal(r.allowRelease, false);
  assert.equal(r.manualReviewRequired, true); assert.equal(r.quarantinePersisted, false);
  return r;
}
function warning(r, kind) {
  const w = warningForNonce({ snapshotReadable: true, result: r });
  assert.equal(w.kind, kind); assert.equal(w.manualReviewRequired, true); assert.equal(w.allowAvailability, false);
  assert.equal(w.allowBooking, false); assert.equal(w.allowRetry, false); assert.equal(w.allowRelease, false);
  assert.equal(w.allowRepair, false); assert.equal(w.persisted, false); assert.deepEqual(w.actions, []);
  assert.ok(!w.message.includes(nonce)); assert.ok(!w.message.includes('fixture-secret')); assert.ok(!w.message.includes('<script>'));
  return w;
}
function start(guard, id) { result(guard.start(id, nonce), 'IN_PROGRESS'); }
function acquire(guard, id) { result(guard.advance(id), 'LOCK_ACQUIRED'); }
function read(guard, id) { result(guard.advance(id), 'READY_TO_WRITE'); }

// Exercise both possible first owners without assuming fairness or actual parallelism.
for (const [first, second] of [['fixture-a', 'fixture-b'], ['fixture-b', 'fixture-a']]) {
  const g = createNonceGuard(); start(g, first); start(g, second); acquire(g, first);
  result(g.advance(second), 'WAITING_FOR_LOCK'); read(g, first);
  result(g.advance(second), 'WAITING_FOR_LOCK');
  warning(result(g.advance(first), 'NONCE_CONSUMED'), 'NONCE_CONSUMED');
  acquire(g, second); const duplicate = result(g.advance(second), 'REJECTED_DUPLICATE_NONCE');
  warning(duplicate, 'NONCE_DUPLICATE');
  assert.equal(g.inspectFixture(nonce).matchingRows, 1);
  assert.equal(g.advance(first).code, 'NONCE_CONSUMED', 'a completed local step does not write twice');
}
// Ten synthetic entrants, one scheduled owner at a time; not a fetchAll trial.
const g = createNonceGuard();
for (let i = 0; i < 10; i += 1) start(g, `fixture-attempt-${i}`);
acquire(g, 'fixture-attempt-0');
for (let i = 1; i < 10; i += 1) result(g.advance(`fixture-attempt-${i}`), 'WAITING_FOR_LOCK');
read(g, 'fixture-attempt-0'); result(g.advance('fixture-attempt-0'), 'NONCE_CONSUMED');
for (let i = 1; i < 10; i += 1) { acquire(g, `fixture-attempt-${i}`); result(g.advance(`fixture-attempt-${i}`), 'REJECTED_DUPLICATE_NONCE'); }
assert.equal(g.inspectFixture(nonce).matchingRows, 1);
// Separate fixture nonces can each be consumed after serializing the two operations.
const distinct = createNonceGuard(); start(distinct, 'fixture-a');
result(distinct.start('fixture-b', 'fixture-nonce-2'), 'IN_PROGRESS'); acquire(distinct, 'fixture-a');
result(distinct.advance('fixture-b'), 'WAITING_FOR_LOCK'); read(distinct, 'fixture-a');
result(distinct.advance('fixture-a'), 'NONCE_CONSUMED'); acquire(distinct, 'fixture-b');
read(distinct, 'fixture-b'); result(distinct.advance('fixture-b'), 'NONCE_CONSUMED');
assert.equal(distinct.inspectFixture(nonce).matchingRows, 1);
assert.equal(distinct.inspectFixture('fixture-nonce-2').matchingRows, 1);

// Timeout never releases somebody else's lock or changes their pending read/write.
const timeout = createNonceGuard(); start(timeout, 'fixture-a'); start(timeout, 'fixture-b'); acquire(timeout, 'fixture-a');
result(timeout.timeout('fixture-b'), 'LOCK_TIMEOUT'); assert.equal(timeout.inspectFixture(nonce).lockHeld, true);
read(timeout, 'fixture-a'); result(timeout.advance('fixture-a'), 'NONCE_CONSUMED');

const uncertainOutcomes = [];
for (const [fault, applied] of [['CRASH_BEFORE_WRITE', false], ['WRITE_EXCEPTION_NOT_APPLIED', false],
  ['WRITE_EXCEPTION_APPLIED', true], ['CRASH_AFTER_WRITE', true]]) {
  const guard = createNonceGuard(); start(guard, 'fixture-a'); start(guard, 'fixture-b'); acquire(guard, 'fixture-a');
  result(guard.advance('fixture-b'), 'WAITING_FOR_LOCK'); read(guard, 'fixture-a');
  const outcome = result(guard.advance('fixture-a', fault), 'NONCE_STORAGE_UNKNOWN'); uncertainOutcomes.push(outcome);
  const snapshot = guard.inspectFixture(nonce);
  assert.equal(snapshot.matchingRows, applied ? 1 : 0); assert.equal(snapshot.uncertain, true);
  assert.equal(snapshot.lockHeld, false); assert.equal(snapshot.quarantinePersisted, false);
  const w = warning(outcome, 'UNKNOWN'); assert.equal(w.severity, 'critical');
  assert.deepEqual(warningForNonce({ snapshotReadable: false }), w, 'a lost reply must show the same blind warning');
  result(guard.advance('fixture-b'), 'RECONCILIATION_REQUIRED');
  start(guard, 'fixture-c'); result(guard.advance('fixture-c'), 'RECONCILIATION_REQUIRED');
}
for (const outcome of uncertainOutcomes) assert.deepEqual(outcome, uncertainOutcomes[0], 'the response cannot reveal whether the write happened');
for (const fault of ['READ_FAILURE', 'CRASH_BEFORE_READ']) {
  const guard = createNonceGuard(); start(guard, 'fixture-a'); acquire(guard, 'fixture-a');
  warning(result(guard.advance('fixture-a', fault), 'NONCE_STORAGE_UNKNOWN'), 'UNKNOWN');
  assert.equal(guard.inspectFixture(nonce).uncertain, true);
}
for (const rows of [[{ nonce_id: nonce }], [{ nonce_id: nonce, consumed_at: 'fixture-time' }, { nonce_id: nonce, consumed_at: 'fixture-time' }]]) {
  const guard = createNonceGuard(rows); start(guard, 'fixture-a'); acquire(guard, 'fixture-a');
  result(guard.advance('fixture-a'), 'NONCE_STORAGE_UNKNOWN');
}
assert.equal(createNonceGuard().start('real-id', 'actual-secret').code, 'INVALID_INPUT');
const malformed = warningForNonce({ snapshotReadable: true, result: { ...uncertainOutcomes[0], code: '<script>fixture-secret</script>' } });
assert.equal(malformed.kind, 'UNKNOWN'); assert.ok(!malformed.message.includes('fixture-secret'));
assert.equal(warningForNonce({ snapshotReadable: false, result: uncertainOutcomes[0] }).kind, 'UNKNOWN');

// Restart loses this model's latch; this is a limitation, not a recovery mechanism.
const restarted = createNonceGuard(); start(restarted, 'fixture-restart'); acquire(restarted, 'fixture-restart');
read(restarted, 'fixture-restart'); result(restarted.advance('fixture-restart'), 'NONCE_CONSUMED');
assert.equal(restarted.inspectFixture(nonce).quarantinePersisted, false);
const restartedWithAppliedWrite = createNonceGuard([{ nonce_id: nonce, consumed_at: 'fixture-time' }]);
start(restartedWithAppliedWrite, 'fixture-restart'); acquire(restartedWithAppliedWrite, 'fixture-restart');
warning(result(restartedWithAppliedWrite.advance('fixture-restart'), 'REJECTED_DUPLICATE_NONCE'), 'NONCE_DUPLICATE');
console.log('Nonce guard model passed (cooperative in-memory scheduler only; no real atomicity or durable quarantine).');
