'use strict';

// Pure offline experiment. Neither snapshot persistence nor trust, atomicity,
// authentication, authorization, availability, or Calendar behavior is provided.
// The caller's "complete" flags are hypothetical facts in an in-memory test.
// Do not serialize metadata into the real time, timestamp or status columns.
const { cairoInterval } = require('./cairo-slot-model');
const { statusClaim, statusMinutes } = require('./operational-slot-model');
const ELIGIBLE = new Set(['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED']);
function validText(value) { return typeof value === 'string' && value.trim() === value && value.length > 0; }
function settingsDuration(settings, visitType) {
  if (!settings || settings.readable !== true || settings.complete !== true || settings.stable !== true ||
      !validText(settings.revision) || !settings.durations || typeof settings.durations !== 'object' ||
      Array.isArray(settings.durations) || !Object.prototype.hasOwnProperty.call(settings.durations, visitType)) return null;
  const minutes = settings.durations[visitType];
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440 ? minutes : null;
}
function validRequest(request) {
  return request && validText(request.reference) && validText(request.visitType) &&
    typeof request.day === 'string' && typeof request.time === 'string';
}
function captureSubmissionSnapshot(request, settings) {
  if (!validRequest(request)) return { code: 'INPUT_UNKNOWN', write: false };
  const minutes = settingsDuration(settings, request.visitType);
  if (minutes === null) return { code: 'CONFIG_UNKNOWN', write: false };
  const interval = cairoInterval(request.day, request.time, request.visitType, settings.durations);
  if (interval.code !== 'OK') return { code: 'TIME_UNKNOWN', write: false };
  return { code: 'SNAPSHOT_PROPOSED', write: false, snapshot: {
    reference: request.reference, day: request.day, time: request.time, visitType: request.visitType,
    submittedDuration: minutes, settingsRevision: settings.revision
  } };
}
function compareSubmissionAndClaim(input) {
  const denied = (code) => ({ code, proceed: false, write: false });
  if (!input || input.snapshotReadable !== true || !input.snapshot || !validRequest(input.request)) return denied('SUBMISSION_SNAPSHOT_UNKNOWN');
  const snapshot = input.snapshot; const request = input.request;
  if (!validText(snapshot.reference) || !validText(snapshot.visitType) || !validText(snapshot.settingsRevision) ||
      !Number.isInteger(snapshot.submittedDuration) || snapshot.submittedDuration < 1 || snapshot.submittedDuration > 1440) return denied('SUBMISSION_SNAPSHOT_UNKNOWN');
  if (!ELIGIBLE.has(request.status) && !statusClaim(request.status)) return denied('STATUS_REVIEW_REQUIRED');
  if (snapshot.reference !== request.reference || snapshot.visitType !== request.visitType || snapshot.day !== request.day || snapshot.time !== request.time) return denied('SUBMISSION_MISMATCH_REVIEW');
  const claimDuration = settingsDuration(input.settings, request.visitType);
  if (claimDuration === null) return denied('CONFIG_UNKNOWN');
  const interval = cairoInterval(request.day, request.time, request.visitType, input.settings.durations);
  if (interval.code !== 'OK') return denied('TIME_UNKNOWN');
  if (statusClaim(request.status) && statusMinutes(request.status) !== snapshot.submittedDuration) return denied('CLAIM_DURATION_DRIFT_REVIEW');
  if (snapshot.submittedDuration !== claimDuration) return denied('DURATION_DRIFT_REVIEW');
  // Matching durations is only an observation, not permission to approve, save or
  // contact Calendar. A changed revision can affect other booking constraints.
  return { code: 'DURATION_MATCH_OBSERVED', proceed: false, write: false,
    submittedDuration: snapshot.submittedDuration, claimDuration,
    settingsRevisionChanged: snapshot.settingsRevision !== input.settings.revision };
}
module.exports = { captureSubmissionSnapshot, compareSubmissionAndClaim };
