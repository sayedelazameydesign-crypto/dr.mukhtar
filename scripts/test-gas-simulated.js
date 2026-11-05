#!/usr/bin/env node
'use strict';

// Offline simulation only. This does not replace testing in a real Google account.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.TZ = 'Africa/Cairo';

class FakeRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    Object.assign(this, { sheet, row, column, rowCount, columnCount });
  }
  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }
  setValues(values) {
    if (this.sheet.failNextSet) {
      this.sheet.failNextSet = false;
      throw new Error('simulated Sheets write failure');
    }
    values.forEach((row, rowOffset) => {
      const target = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= target) this.sheet.rows.push([]);
      this.sheet.rows[target] = [...row];
    });
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  createTextFinder(value) {
    const range = this;
    return {
      matchEntireCell() { return this; },
      findNext() {
        for (let r = range.row - 1; r < range.row - 1 + range.rowCount; r += 1) {
          if (String(range.sheet.rows[r]?.[range.column - 1] ?? '') === String(value)) {
            return { getRow: () => r + 1 };
          }
        }
        return null;
      }
    };
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.failNextSet = false; }
  getLastRow() { return this.rows.length; }
  appendRow(row) { this.rows.push([...row]); return this; }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }
  setFrozenRows() { return this; }
}

class FakeEvent {
  constructor(id, title, start, end, options) {
    Object.assign(this, { id, title, start, end, description: options?.description || '', deleted: false });
  }
  getId() { return this.id; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  getDescription() { return this.description; }
  setTime(start, end) { this.start = start; this.end = end; }
  deleteEvent() { this.deleted = true; }
}

class FakeCalendar {
  constructor() { this.events = []; this.sequence = 1; }
  getEvents(start, end) {
    return this.events.filter((event) => !event.deleted && event.start < end && event.end > start);
  }
  createEvent(title, start, end, options) {
    const event = new FakeEvent(`fake-event-${this.sequence++}`, title, start, end, options);
    this.events.push(event);
    if (this.onCreate) { const callback = this.onCreate; this.onCreate = null; callback(event); }
    return event;
  }
  getEventById(id) { return this.events.find((event) => event.id === id && !event.deleted) || null; }
}

// The real deployment stores a SHA-256 hash and the browser sends the same hash.
const crypto = require('node:crypto');
const staffPinFixture = 'fake-admin-secret-32-characters-long';
function hashPin(pin) { return crypto.createHash('sha256').update(String(pin)).digest('hex'); }
const staffHash = hashPin(staffPinFixture);
const propertyValues = new Map([
  ['CELIA_SHEET_ID', 'fake-sheet'], ['CALENDAR_ID', 'primary'],
  ['ADMIN_PIN_HASH', hashPin(staffPinFixture)], ['TIMEZONE', 'Africa/Cairo'],
  ['WORK_START', '09:00'], ['WORK_END', '14:00'], ['SLOT_MINUTES', '30'],
  ['NEW_VISIT_MINUTES', '60'], ['FOLLOWUP_MINUTES', '30'], ['WORK_DAYS', '0,1,2,3,4']
]);
let googleUp = true;
let calendarUp = true;
let auditUp = true;
let scriptLockHeld = false;
let uuidSequence = 1;
const sheets = new Map();
const calendar = new FakeCalendar();
const spreadsheet = {
  getSheetByName(name) { if (!googleUp) throw new Error('simulated Sheets outage'); if (name === 'Audit' && !auditUp) throw new Error('simulated Audit outage'); return sheets.get(name) || null; },
  insertSheet(name) {
    if (!googleUp) throw new Error('simulated Sheets outage');
    const sheet = new FakeSheet(name); sheets.set(name, sheet); return sheet;
  }
};
const properties = {
  getProperty(key) { return propertyValues.has(key) ? propertyValues.get(key) : null; },
  setProperty(key, value) { propertyValues.set(key, String(value)); return this; },
  deleteProperty(key) { propertyValues.delete(key); return this; },
  getProperties() { return Object.fromEntries(propertyValues); },
  setProperties(values) { Object.entries(values).forEach(([key, value]) => propertyValues.set(key, String(value))); }
};
const dateParts = (date, timezone) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
);
const context = {
  console,
  PropertiesService: { getScriptProperties: () => properties },
  LockService: { getScriptLock: () => ({ tryLock: () => { if (scriptLockHeld) return false; scriptLockHeld = true; return true; }, releaseLock: () => { scriptLockHeld = false; } }) },
  SpreadsheetApp: {
    openById() { if (!googleUp) throw new Error('simulated Sheets outage'); return spreadsheet; },
    getActiveSpreadsheet() { if (!googleUp) throw new Error('simulated Sheets outage'); return spreadsheet; }
  },
  CalendarApp: {
    getDefaultCalendar() { return calendarUp ? calendar : null; },
    getCalendarById() { return calendarUp ? calendar : null; }
  },
  Session: { getScriptTimeZone: () => 'Africa/Cairo' },
  CacheService: {
    getScriptCache() {
      const store = new Map();
      return {
        get: (key) => (store.has(key) ? store.get(key) : null),
        put: (key, value) => { store.set(key, value); },
        remove: (key) => { store.delete(key); },
        removeAll: (keys) => { (keys || []).forEach((key) => store.delete(key)); }
      };
    }
  },
  Utilities: {
    computeDigest(algorithm, text) {
      const name = algorithm === 'SHA_256' || algorithm === 1 || algorithm === 'SHA-256' ? 'sha256' : 'sha256';
      return Array.from(crypto.createHash(name).update(String(text), 'utf8').digest())
        .map((byte) => (byte > 127 ? byte - 256 : byte));
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    getUuid() { return `00000000-0000-4000-8000-${String(uuidSequence++).padStart(12, '0')}`; },
    formatDate(date, timezone, pattern) {
      const p = dateParts(date, timezone);
      if (pattern === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
      if (pattern === 'yyyy-MM-dd HH:mm') return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      throw new Error(`Unsupported simulated date format: ${pattern}`);
    }
  },
  UrlFetchApp: { fetch() { throw new Error('Unexpected network call in offline test'); } }
};

vm.createContext(context);
// Apps Script concatenates every .gs file into one global scope; the offline test
// must reproduce that, including Settings.gs and Llm.gs.
const BACKEND_FILES = ['Code.gs', 'Settings.gs', 'Llm.gs'];
BACKEND_FILES.forEach((file) => {
  const target = ['gas/' + file, file].find((candidate) => fs.existsSync(candidate));
  if (!target) {
    if (file === 'Code.gs') throw new Error('Apps Script backend not found (gas/Code.gs or Code.gs)');
    if (file === 'Llm.gs') throw new Error('Llm.gs not found; it is part of the Apps Script bundle');
    return; // Settings.gs is optional in very old checkouts
  }
  vm.runInContext(fs.readFileSync(target, 'utf8'), context, { filename: target });
});

function nextWorkday() {
  const date = new Date(); date.setHours(12, 0, 0, 0);
  for (let i = 1; i <= 14; i += 1) {
    const candidate = new Date(date); candidate.setDate(date.getDate() + i);
    if ([0, 1, 2, 3, 4].includes(candidate.getDay())) return candidate.toISOString().slice(0, 10);
  }
  throw new Error('Could not find a future workday');
}
const day = nextWorkday();
// Every staff call now sends the hash, exactly as the browser does.
const pin = staffHash;
function request(time, visitType = 'كشف جديد') {
  return context.createRequest({ visitType, guardianName: 'ولي أمر تجريبي', phone: '0000000000', day, time, consent: true });
}
function isHashRow(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
function assertSaved(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.message || 'request failed'}`);
  return result.booking;
}

// Two requests may ask for the same time, but only one may be approved into Calendar.
const first = assertSaved(request('10:00'), 'first request');
const second = assertSaved(request('10:00'), 'competing request');
assert.equal(first.status, 'PENDING_APPROVAL');
let simultaneousAttempt = null;
calendar.onCreate = () => { simultaneousAttempt = context.approveRequest(second.reference, pin); };
assert.equal(context.approveRequest(first.reference, pin).ok, true);
assert.equal(simultaneousAttempt.ok, false, 'overlapping approval is rejected while the script lock is held');
assert.equal(context.approveRequest(second.reference, pin).ok, false, 'the subsequent availability recheck also blocks the conflict');
assert.equal(calendar.events.filter((event) => !event.deleted).length, 1, 'only one confirmed event for overlapping requests');
const firstEvent = calendar.events.find((event) => !event.deleted);
assert.equal((firstEvent.end - firstEvent.start) / 60000, 60, 'new visit duration is respected');

// A failed Sheet status write after Calendar creation must be recoverable without a duplicate event.
const recoverable = assertSaved(request('11:00'), 'recovery request');
sheets.get('Requests').failNextSet = true;
assert.equal(context.approveRequest(recoverable.reference, pin).ok, false, 'first attempt reports incomplete persistence');
const countAfterPartialFailure = calendar.events.filter((event) => !event.deleted).length;
assert.equal(context.approveRequest(recoverable.reference, pin).ok, true, 'retry completes the confirmation');
assert.equal(calendar.events.filter((event) => !event.deleted).length, countAfterPartialFailure, 'retry reuses the prior event');

// Editing and cancellation must keep Calendar and the sheet in step.
assert.equal(context.moveConfirmedAppointment(recoverable.reference, day, '12:00', 'اختبار', pin).ok, true);
assert.equal(context.cancelRequest(recoverable.reference, 'اختبار', pin).ok, true);
assert.equal(calendar.events.filter((event) => !event.deleted).length, 1, 'cancellation removes the event');

// Calendar outage leaves a REQUESTED record, not a false confirmation.
calendarUp = false;
const withoutCalendar = assertSaved(request('13:00', 'متابعة'), 'calendar outage request');
assert.equal(withoutCalendar.status, 'REQUESTED');
assert.equal(withoutCalendar.slotVerified, false);
calendarUp = true;

// Sheets outage uses the bounded property queue; queued requests cannot be confirmed until synced.
googleUp = false;
const queued = assertSaved(request('13:30', 'متابعة'), 'Sheets outage request');
assert.equal(queued.status, 'REQUESTED');
assert.equal(context.approveRequest(queued.reference, pin).ok, false, 'queued request cannot be confirmed');
googleUp = true;
context.syncOutageQueue_();
assert.equal(context.lookupBooking(queued.reference).ok, true, 'queued request is synchronized when Sheets returns');

// Audit writes are queued and later synchronized if the request itself has already been saved.
const auditRecovery = assertSaved(request('13:00', 'متابعة'), 'audit recovery request');
assert.equal(context.approveRequest(auditRecovery.reference, pin).ok, true);
auditUp = false;
const completedDuringAuditOutage = context.completeRequest(auditRecovery.reference, pin);
assert.equal(completedDuringAuditOutage.ok, true, 'saved status remains successful while audit is queued');
assert.equal([...propertyValues.keys()].some((key) => key.startsWith('CKA_')), true, 'audit failure creates an offline audit record');
auditUp = true;
context.syncAuditQueue_();
assert.ok(sheets.get('Audit').rows.some((row) => row[3] === 'VISIT_COMPLETED'), 'queued audit is written when Sheets returns');

// If both the Audit sheet and the bounded audit queue are unavailable, report that exception.
for (let i = 0; i < 100; i += 1) properties.setProperty(`CKA_TEST_${i}`, JSON.stringify(['test']));
const noAuditCapacity = assertSaved(request('13:30', 'متابعة'), 'full audit queue request');
assert.equal(context.approveRequest(noAuditCapacity.reference, pin).ok, true);
auditUp = false;
const auditCapacityWarning = context.completeRequest(noAuditCapacity.reference, pin);
assert.equal(auditCapacityWarning.ok, true, 'appointment state write is not misreported as failed');
assert.match(auditCapacityWarning.warning, /تعذر حفظ سجل التدقيق/, 'unrecorded audit is explicitly reported');
auditUp = true;

// Public clinic profile: display-only, and an unset licence stays explicitly unverified.
const defaultProfile = context.getClinicProfile();
assert.equal(defaultProfile.ok, true);
assert.equal(defaultProfile.licenseVerified, false, 'no licence number is invented');
assert.equal(defaultProfile.license, '', 'an empty licence is reported as empty');
assert.match(defaultProfile.hours, /٩:٠٠ ص/, 'hours are rendered from WORK_START, not hardcoded');
// A non-consecutive working week must be listed by name, never claimed as a range.
assert.equal(context.formatClinicHours_({ workDays: [6, 0, 1], weekendDays: [2, 3], start: '10:30', end: '18:00' }),
  'الأحد، الاثنين، السبت · ١٠:٣٠ ص – ٦:٠٠ م · الثلاثاء والأربعاء مغلقان');
assert.equal(context.formatClinicHours_({ workDays: [1], weekendDays: [], start: '09:00', end: '12:00' }),
  'الاثنين · ٩:٠٠ ص – ١٢:٠٠ م');
assert.equal(context.formatClinicHours_({ workDays: [0, 1, 2, 3, 4], weekendDays: [5, 6], start: '09:00', end: '14:00' }),
  'الأحد – الخميس · ٩:٠٠ ص – ٢:٠٠ م · الجمعة والسبت مغلقان');
assert.equal(properties.getProperty('DOCTOR_LICENSE'), null, 'the fixture never seeds a licence');
properties.setProperty('DOCTOR_NAME', 'د. اسم تجريبي');
properties.setProperty('DOCTOR_LICENSE', 'EG-TEST-0001');
properties.setProperty('CLINIC_ADDRESS', 'عنوان تجريبي');
const filledProfile = context.getClinicProfile();
assert.equal(filledProfile.doctorName, 'د. اسم تجريبي');
assert.equal(filledProfile.licenseVerified, true);
assert.equal(filledProfile.address, 'عنوان تجريبي');
assert.equal(Object.keys(filledProfile).some((key) => /pin|key|token/i.test(key)), false, 'the public profile carries no secrets');
properties.setProperty('DOCTOR_NAME', '');
properties.setProperty('DOCTOR_LICENSE', '');
properties.setProperty('CLINIC_ADDRESS', '');

// A closed day must disappear from the guardian's availability, not just from the dashboard.
const closureDay = nextWorkday();
const beforeClosure = context.getAvailableSlots(closureDay, 'متابعة');
assert.equal(beforeClosure.ok, true);
assert.ok(beforeClosure.slots.length > 0, 'a workday has slots before it is closed');
assert.equal(context.closeDay(closureDay, 'إجازة اختبار', pin).ok, true);
const afterClosure = context.getAvailableSlots(closureDay, 'متابعة');
assert.equal(afterClosure.ok, true);
assert.equal(afterClosure.slots.length, 0, 'a closed day offers no slots');
const closedIntake = context.createRequest({ visitType: 'متابعة', guardianName: 'ولي أمر تجريبي', phone: '0000000000', day: closureDay, time: '09:00', consent: true });
assert.equal(closedIntake.ok, false, 'a closed day is refused at intake instead of accepting an impossible request');
assert.match(closedIntake.message, /لم يعد متاحاً/, 'the refusal names the reason');


// The queue limit fails closed: never claim a request was stored after capacity is exhausted.
for (let i = 0; i < 25; i += 1) properties.setProperty(`CKQ_TEST_${i}`, JSON.stringify({ reference: `TEST-${i}` }));
googleUp = false;
const fullQueue = request('09:30', 'متابعة');
assert.equal(fullQueue.ok, false, 'full queue rejects rather than falsely accepting');
googleUp = true;
// Settings: the catalog is the allowlist, a legacy plain PIN is migrated, and the
// page follows the saved values (scenario L: settings edited from the dashboard).
const settings = context.getClinicSettings(pin);
assert.equal(settings.ok, true, 'settings load with a staff session');
assert.ok(settings.catalog.length >= 4, 'the catalog drives the dashboard form');
assert.equal(settings.values.STAFF_PIN, '', 'the PIN is never returned to the browser');
assert.equal(settings.values.CLINIC_NAME || '', '', 'unset clinic name reports empty, not invented');
assert.equal(settings.meta.staffPinHashed, true, 'the fixture uses a hashed PIN');
assert.equal(Object.keys(settings.values).some((key) => /KEY|TOKEN|CALENDAR_ID|SHEET_ID/.test(key)), false, 'no secret or internal id is exposed');

const savedSettings = context.saveClinicSettings({
  reason: 'offline test',
  values: {
    CLINIC_NAME: 'عيادة اختبار', CLINIC_PHONE: '0100 000 0000', DOCTOR_NAME: 'د. اختبار',
    DOCTOR_LICENSE: 'EG-0000', WORK_START: '10:00', WORK_END: '16:00',
    VISIT_SERVICES: 'كشف أول = 45\nمتابعة = 20\nاستشارة قصيرة = 15'
  }
}, pin);
assert.equal(savedSettings.ok, true, savedSettings.message);
assert.equal(savedSettings.settings.values.CLINIC_PHONE, '01000000000', 'a phone number is normalised');
assert.match(savedSettings.settings.values.VISIT_SERVICES, /كشف أول = 45/, 'services round-trip through the UI');
assert.equal(context.visitDuration_('استشارة قصيرة'), 15, 'a new service becomes bookable without code');
// Calendar availability for the new hours is asserted on a fresh day: `day` is
// already fully booked by the approval scenarios above.
const settingsDay = (() => {
  const probe = new Date(); probe.setHours(12, 0, 0, 0);
  for (let offset = 2; offset < 20; offset += 1) {
    const candidate = new Date(probe); candidate.setDate(probe.getDate() + offset);
    if (![0, 1, 2, 3, 4].includes(candidate.getDay())) continue;
    const iso = candidate.toISOString().slice(0, 10);
    if (!calendar.events.some((event) => !event.deleted && event.start.getDate() === candidate.getDate())) return iso;
  }
  return day;
})();
const savedSlots = context.getAvailableSlots(settingsDay, 'كشف أول');
assert.equal(savedSlots.ok, true);
assert.equal(savedSlots.slots[0], '10:00', 'availability follows the saved hours: ' + JSON.stringify(savedSlots.slots));
assert.match(context.getClinicProfile().hours, /١٠:٠٠ ص/, 'the public page follows the saved hours');
// A 60-minute visit must still be offered at an off-grid half hour when slots are
// spaced 30 minutes apart (the old modulo test hid 09:30 for 60-minute visits).
assert.equal(context.saveClinicSettings({ values: { WORK_START: '09:00', WORK_END: '14:00', SLOT_MINUTES: '30', VISIT_SERVICES: 'كشف جديد = 60' } }, pin).ok, true);
assert.equal(context.isSlotAvailable_(settingsDay, '09:30', 60, ''), true, 'a 60-minute visit is offered at 09:30, not only on the hour');
assert.equal(context.isSlotAvailable_(settingsDay, '09:15', 60, ''), false, 'off-grid times stay unavailable');

// Validation is the server's job, not the form's.
assert.equal(context.saveClinicSettings({ values: { WORK_START: '18:00', WORK_END: '09:00' } }, pin).ok, false, 'inverted hours are refused');
assert.equal(context.saveClinicSettings({ values: { WEEKEND_DAYS: '0,1' } }, pin).ok, false, 'overlapping weekend is refused');
assert.equal(context.saveClinicSettings({ values: { VISIT_SERVICES: 'زيارة بلا مدة' } }, pin).ok, false, 'malformed services are refused');
assert.equal(context.saveClinicSettings({ values: { GEMINI_API_KEY: 'x' } }, pin).ok, false, 'unknown/secret keys are refused');
assert.equal(context.saveClinicSettings({ values: { CLINIC_NAME: 'x' } }, 'not-the-pin-000000').ok, false, 'settings need a valid session');

// The PIN itself is only ever stored as a hash, and a change needs the current one.
const newPin = 'another-long-staff-passphrase-2026';
assert.equal(context.saveStaffPin('wrong-current-pin-0000', hashPin(newPin), pin).ok, false, 'a wrong current PIN is refused');
assert.equal(context.saveStaffPin(staffPinFixture, hashPin(newPin), pin).ok, true, 'the PIN can be rotated');
assert.equal(propertyValues.get('ADMIN_PIN_HASH'), hashPin(newPin), 'only the hash is stored');
assert.equal(propertyValues.has('ADMIN_PIN'), false, 'no plain PIN remains');
assert.equal(context.getClinicSettings(pin).ok, false, 'the old PIN stops working');
assert.equal(context.getClinicSettings(hashPin(newPin)).ok, true, 'the new PIN works');

// A legacy plain ADMIN_PIN is upgraded to a hash on first successful login.
propertyValues.delete('ADMIN_PIN_HASH');
propertyValues.set('ADMIN_PIN', 'legacy-plain-pin-value-32-chars');
assert.equal(context.getClinicSettings('legacy-plain-pin-value-32-chars').ok, true, 'a legacy PIN still logs in');
assert.equal(isHashRow(propertyValues.get('ADMIN_PIN_HASH')), true, 'the legacy PIN was hashed');
assert.equal(propertyValues.has('ADMIN_PIN'), false, 'the plain PIN was deleted after migration');

// First install plants a temporary PIN (stored as a hash) until the doctor replaces it.
propertyValues.delete('ADMIN_PIN_HASH');
assert.equal(context.staffPinState_().configured, false);
// A generated PIN (never a literal in the repo) is installed as a hash only.
const generatedPin = context.randomStaffPin_();
assert.equal(generatedPin.length, 24, 'the bootstrap PIN is generated, not typed');
assert.equal(/[Il1O0o]/.test(generatedPin), false, 'the alphabet avoids look-alike characters');
assert.notEqual(context.randomStaffPin_(), generatedPin, 'each deployment gets its own PIN');
propertyValues.set('ADMIN_PIN_HASH', hashPin(generatedPin));
propertyValues.set('CK_MUST_CHANGE_PIN', '1');
const bootstrapHash = hashPin(generatedPin);
assert.equal(context.getClinicSettings(bootstrapHash).meta.mustChangePin, true, 'the dashboard is told to ask for a new PIN');
assert.equal(context.validateConfig().checks.find((c) => c.id === 'admin_pin').ok, false, 'readiness stays blocked until it is changed');
assert.equal(context.saveStaffPin(bootstrapHash, hashPin('doctor-chosen-passphrase-2026'), bootstrapHash).ok, true);
assert.equal(context.isStaff_(bootstrapHash), false, 'the generated PIN is dead after the change');
assert.equal(propertyValues.has('CK_MUST_CHANGE_PIN'), false, 'the flag clears after the change');
const readinessAfter = context.validateConfig().checks.find((c) => c.id === 'admin_pin');
assert.equal(readinessAfter.ok, true, 'readiness passes once the doctor owns the PIN — ' + readinessAfter.detail);
assert.equal(context.getClinicSettings(bootstrapHash).ok, false, 'the bootstrap PIN stops working immediately');

console.log('Offline simulated Apps Script tests passed: competing approvals, visit duration, partial-write retry, edit/cancel, Calendar outage, Sheets/audit outage and full-audit queues, request-queue-full rejection, closed days removed from availability, a secret-free clinic profile, and dashboard-editable settings (validation, services, PIN hashing and migration).')
;
console.log('Reminder: these mocked-service tests do not establish Google quotas, permissions, live deployment behavior, or legal readiness.');
