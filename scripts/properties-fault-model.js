'use strict';

// A conservative in-memory decision prototype, not PropertiesService, a real PIN
// gate, a persistence layer, or a recovery mechanism. It never authorizes booking
// or authentication, even if a supplied fixture appears structurally complete.
// A durable, independently observable transaction marker is NOT implemented.
function inspectProperties(snapshot) {
  const result = { code: 'SYS_PROP_READ_FAILURE', allowBooking: false, allowAuthentication: false,
    settingsMode: 'ISOLATED_NO_BOOKING', staffMessage: 'تعذر التحقق من إعدادات النظام؛ راجعوا مسؤول العيادة.' };
  if (!snapshot || snapshot.readable !== true || snapshot.markerReadable !== true ||
      !['COMMITTED', 'IN_PROGRESS', 'UNKNOWN'].includes(snapshot.marker) || snapshot.marker === 'UNKNOWN') return result;
  if (snapshot.marker === 'IN_PROGRESS') return { ...result, code: 'CORRUPTED_CONFIG' };
  if (snapshot.requiredKeysPresent !== true || snapshot.pinStateReadable !== true) return result;
  if (snapshot.configIntegrityVerified !== true) return { ...result, code: 'CORRUPTED_CONFIG' };
  if (snapshot.pinChangeState !== 'COMMITTED') return { ...result, code: 'PIN_CHANGE_UNKNOWN' };
  // This is only the shape of caller-supplied flags, not proof of integrity. No
  // candidate credential is evaluated and existing sessions are not modified.
  return { ...result, code: 'SHAPE_OBSERVED_ONLY' };
}
function inspectCredential(snapshot, candidateTag) {
  const state = inspectProperties(snapshot);
  if (!['fixture-old', 'fixture-new'].includes(candidateTag)) return { code: 'NOT_EVALUATED', allowAuthentication: false };
  return { code: state.code, allowAuthentication: false };
}
module.exports = { inspectProperties, inspectCredential };
