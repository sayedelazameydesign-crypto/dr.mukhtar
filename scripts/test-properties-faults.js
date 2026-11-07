#!/usr/bin/env node
'use strict';

// In-memory fault specification only. This does not call Google, exercise current
// Settings.gs, verify a PIN, invalidate sessions, or prove a durable kill switch.
const assert = require('node:assert/strict');
const { inspectProperties, inspectCredential } = require('./properties-fault-model');
const clean = { readable: true, markerReadable: true, marker: 'COMMITTED', requiredKeysPresent: true,
  configIntegrityVerified: true, pinStateReadable: true, pinChangeState: 'COMMITTED' };
function verify(snapshot, code) {
  const state = inspectProperties(snapshot);
  assert.equal(state.code, code); assert.equal(state.allowBooking, false); assert.equal(state.allowAuthentication, false);
  assert.equal(state.settingsMode, 'ISOLATED_NO_BOOKING');
  assert.equal(state.staffMessage, 'تعذر التحقق من إعدادات النظام؛ راجعوا مسؤول العيادة.');
  for (const candidate of ['fixture-old', 'fixture-new']) assert.equal(inspectCredential(snapshot, candidate).allowAuthentication, false);
}
verify({ ...clean, marker: 'IN_PROGRESS', configIntegrityVerified: false }, 'CORRUPTED_CONFIG');
verify({ ...clean, configIntegrityVerified: false }, 'CORRUPTED_CONFIG');
verify({ ...clean, pinChangeState: 'IN_PROGRESS' }, 'PIN_CHANGE_UNKNOWN');
verify({ ...clean, pinChangeState: 'UNKNOWN' }, 'PIN_CHANGE_UNKNOWN');
for (const patch of [{ readable: false }, { markerReadable: false }, { marker: 'UNKNOWN' },
  { requiredKeysPresent: false }, { pinStateReadable: false }]) verify({ ...clean, ...patch }, 'SYS_PROP_READ_FAILURE');
verify(clean, 'SHAPE_OBSERVED_ONLY');
assert.deepEqual(inspectCredential(clean, 'not-a-fixture'), { code: 'NOT_EVALUATED', allowAuthentication: false });

// Exercise each hypothetical interruption point with values that are strictly
// synthetic. A failed write can survive or not; no result is used as proof of the
// actual Google behavior. The model assumes flags are provided, it does not prove
// that a marker can be durably installed or observed by every execution.
for (const survivingKeys of [0, 1, 2]) {
  const fake = { ...clean, marker: 'IN_PROGRESS', configIntegrityVerified: survivingKeys === 2 };
  verify(fake, 'CORRUPTED_CONFIG');
}
for (const markerPersisted of [false, true]) {
  const fake = { ...clean, marker: markerPersisted ? 'IN_PROGRESS' : 'UNKNOWN', markerReadable: markerPersisted };
  verify(fake, markerPersisted ? 'CORRUPTED_CONFIG' : 'SYS_PROP_READ_FAILURE');
}
// A reader that incorrectly assumes a lost marker is clean cannot be certified by
// shape alone: the model still denies both operations.
verify({ ...clean, marker: 'COMMITTED' }, 'SHAPE_OBSERVED_ONLY');
console.log('Properties fault model passed (offline only; actual fail-closed PIN and persistence are unproven).');
