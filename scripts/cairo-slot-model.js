'use strict';

// Node/ICU-only simulation, not the current GAS time converter. Do not use as
// production code or proof of Google Calendar/Sheets timezone behavior.
const { acquireOperationalSlot, isBlocking, statusMinutes } = require('./operational-slot-model');
const formatter = new Intl.DateTimeFormat('en-GB-u-ca-gregory-nu-latn', {
  timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function partsAt(ms) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(ms)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return [parts.year, parts.month, parts.day, parts.hour, parts.minute];
}
function wallTimeToInstant(day, time) {
  if (typeof day !== 'string' || typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return { code: 'INVALID_WALL_TIME' };
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  // Keep the prototype within a bounded, modern timezone dataset range.
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || hour > 23 || minute > 59) return { code: 'INVALID_WALL_TIME' };
  const target = Date.UTC(year, month - 1, date, hour, minute);
  const check = new Date(target);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return { code: 'INVALID_WALL_TIME' };
  const offsets = new Set();
  // Capture offsets on both sides of nearby DST transitions; verify each proposed
  // instant by round-tripping it through the platform's Cairo timezone database.
  for (let delta = -48; delta <= 48; delta += 1) {
    const probe = target + delta * 3600000;
    const p = partsAt(probe);
    offsets.add(Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]) - probe);
  }
  const matches = [...offsets].map((offset) => target - offset).filter((instant) => {
    const p = partsAt(instant);
    return p[0] === year && p[1] === month && p[2] === date && p[3] === hour && p[4] === minute;
  });
  const unique = [...new Set(matches)];
  if (unique.length === 0) return { code: 'NONEXISTENT_WALL_TIME' };
  if (unique.length !== 1) return { code: 'AMBIGUOUS_WALL_TIME' };
  return { code: 'OK', startMs: unique[0] };
}
function cairoInterval(day, time, visitType, durations) {
  if (!durations || typeof durations !== 'object' || !Object.prototype.hasOwnProperty.call(durations, visitType)) return { code: 'UNKNOWN_VISIT_TYPE' };
  const minutes = durations[visitType];
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return { code: 'INVALID_DURATION' };
  const start = wallTimeToInstant(day, time);
  if (start.code !== 'OK') return start;
  return { code: 'OK', startMs: start.startMs, endMs: start.startMs + minutes * 60000 };
}
function acquireCairoOperationalSlot(input) {
  if (!input || input.lockHeld !== true) return { code: 'LOCK_TIMEOUT' };
  if (input.snapshotComplete !== true || !Array.isArray(input.records)) return { code: 'UNKNOWN' };
  const rows = [];
  for (const row of input.records) {
    if (!row || typeof row !== 'object') return { code: 'UNKNOWN' };
    const current = { ...row };
    if (row.reference === input.reference || isBlocking(row.status)) {
      let durations = input.durations;
      if (isBlocking(row.status)) {
        if (typeof row.visitType !== 'string' || !row.visitType) return { code: 'UNKNOWN', reason: 'RESERVATION_DURATION_UNKNOWN' };
        let minutes = statusMinutes(row.status);
        if (minutes === null) {
          // CONFIRMED/NEEDS_REVIEW do not carry minutes in their status; never
          // infer their reserved duration from a mutable service catalogue.
          const snapshots = input.reservationDurations;
          if (input.reservationDurationsReadable !== true || !snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots) ||
              !Object.prototype.hasOwnProperty.call(snapshots, row.reference)) return { code: 'UNKNOWN', reason: 'RESERVATION_DURATION_UNKNOWN' };
          const captured = snapshots[row.reference];
          if (!captured || typeof captured !== 'object' || captured.status !== row.status || captured.day !== row.day ||
              captured.time !== row.time || captured.visitType !== row.visitType) return { code: 'UNKNOWN', reason: 'RESERVATION_DURATION_UNKNOWN' };
          minutes = captured.minutes;
        }
        durations = Object.create(null);
        durations[row.visitType] = minutes;
      }
      const interval = cairoInterval(row.day, row.time, row.visitType, durations);
      if (interval.code !== 'OK') return { code: 'UNKNOWN', reason: interval.code };
      current.startMs = interval.startMs;
      current.endMs = interval.endMs;
    }
    rows.push(current);
  }
  return acquireOperationalSlot({ ...input, records: rows });
}
module.exports = { wallTimeToInstant, cairoInterval, acquireCairoOperationalSlot };
