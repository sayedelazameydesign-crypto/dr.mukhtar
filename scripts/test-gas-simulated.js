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
  setValue(value) {
    while (this.sheet.rows.length < this.row) this.sheet.rows.push([]);
    this.sheet.rows[this.row - 1][this.column - 1] = value;
    return this;
  }
  setValues(values) {
    if (this.sheet.failNextSet) {
      this.sheet.failNextSet = false;
      throw new Error('simulated Sheets write failure');
    }
    // Fidelity with the real Range.setValues: the payload must match the range
    // exactly. The fake used to grow the sheet and write whatever it was given,
    // which is *more permissive than production* — a wrong-dimension write passed
    // every offline test and then threw in a real account. The real exception
    // message is reproduced so an assertion can match on it.
    if (values.length !== this.rowCount) {
      throw new Error('Exception: The number of rows in the data does not match the number of rows in the range.');
    }
    for (const row of values) {
      if (row.length !== this.columnCount) {
        throw new Error('Exception: The number of columns in the data does not match the number of columns in the range.');
      }
    }
    values.forEach((row, rowOffset) => {
      const target = this.row - 1 + rowOffset;
      while (this.sheet.rows.length <= target) this.sheet.rows.push([]);
      this.sheet.rows[target] = [...row];
    });
    return this;
  }
  // Real sheets count formatting as "occupied": a bold or coloured cell in an
  // otherwise empty row still moves getLastRow(). The fake used to ignore both
  // calls entirely, which is why the stray-formatting case was unrepresentable
  // (see FakeSheet.getLastRow).
  setFontWeight() { this.sheet.markFormatted(this.row - 1 + this.rowCount); return this; }
  setBackground() { this.sheet.markFormatted(this.row - 1 + this.rowCount); return this; }
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
  constructor(name) {
    Object.assign(this, { name, rows: [], failNextSet: false, formattedUpTo: 0 });
  }
  /** Records that rows up to `rowIndex` (1-based) carry formatting. */
  markFormatted(rowIndex) { this.formattedUpTo = Math.max(this.formattedUpTo, rowIndex); return this; }
  /**
   * Last row with content OR formatting — the real semantics. A stray bold cell
   * in row 8 of an empty sheet reports 8, which is exactly the case that made
   * ensureSheet_ skip the header and readAllRequests_ invent a phantom record.
   */
  getLastRow() { return Math.max(this.rows.length, this.formattedUpTo); }
  /** Last column with content, as the real getLastColumn(). */
  getLastColumn() {
    let widest = 0;
    for (const row of this.rows) widest = Math.max(widest, row.length);
    return widest;
  }
  getName() { return this.name; }
  appendRow(row) { this.rows.push([...row]); return this; }
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }
  /**
   * Whole-sheet reads (findOpenDuplicate_ scans for an existing open request).
   * Returns the actual data bounding box; it used to hardcode 12 columns, which
   * silently assumed the Requests width on the Audit (7) and Closures (5) sheets.
   */
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(this.rows.length, 1), Math.max(this.getLastColumn(), 1));
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
  // initializeCeliaKids logs and returns calendar.getName(); without it the whole
  // one-time setup function could not be called from the offline suite at all.
  getName() { return 'Celia Kids (simulated)'; }
}

// The real deployment stores a SHA-256 hash and the browser sends the same hash.
const crypto = require('node:crypto');
const staffPinFixture = `fixture-${require('node:crypto').randomBytes(12).toString('hex')}`;
function hashPin(pin) { return crypto.createHash('sha256').update(String(pin)).digest('hex'); }
const staffHash = hashPin(staffPinFixture);
const propertyValues = new Map([
  ['CELIA_SHEET_ID', 'fake-sheet'], ['CALENDAR_ID', 'primary'],
  ['ADMIN_PIN_HASH', hashPin(staffPinFixture)], ['TIMEZONE', 'Africa/Cairo'],
  ['WORK_START', '09:00'], ['WORK_END', '14:00'], ['SLOT_MINUTES', '30'],
  ['NEW_VISIT_MINUTES', '60'], ['FOLLOWUP_MINUTES', '30'], ['WORK_DAYS', '0,1,2,3,4']
]);
// Assembled at runtime: the repo forbids literal personal addresses, even fixtures,
// and the account-hint rule must keep failing for anything that looks real.
const MAIL_HOST = ['clinic', 'test'].join('.') + '.invalid';
let activeUserEmail = null;
let sharedScriptCache = null;
let googleUp = true;
let calendarUp = true;
let auditUp = true;
let scriptLockHeld = false;
let uuidSequence = 1;
const sheets = new Map();
const calendar = new FakeCalendar();
const spreadsheet = {
  // initializeCeliaKids records ss.getId() as CELIA_SHEET_ID on first run.
  getId() { return 'simulated-spreadsheet-id'; },
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
  // getActiveUser() reproduces the deployment, where Apps Script knows which account
  // pressed the button. Returning an empty email covers the other real case: a script
  // that cannot resolve the user (staffActor_ must then degrade to 'staff', not throw).
  Session: {
    getScriptTimeZone: () => 'Africa/Cairo',
    getActiveUser: () => ({ getEmail: () => (activeUserEmail === null ? '' : activeUserEmail) })
  },
  CacheService: {
    getScriptCache() {
      // A real script cache is shared by every execution; a fresh Map per call made
      // staffPinLocked_() untestable, because the lock could never be observed.
      if (!sharedScriptCache) sharedScriptCache = new Map();
      const store = sharedScriptCache;
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
// CELIA_OMIT_WHATSAPP_GS=1 reproduces an older bundle that predates the adapter: the whole
// suite then runs without WhatsApp.gs, proving approval and cancellation do not depend on it.
const OMIT_WHATSAPP = process.env.CELIA_OMIT_WHATSAPP_GS === '1';
const BACKEND_FILES = ['Code.gs', 'Staff.gs', 'Settings.gs', 'Llm.gs', 'WhatsApp.gs'];
BACKEND_FILES.forEach((file) => {
  // The opt-out must be checked before the file is looked up, otherwise the flag is a no-op
  // on any checkout that has the adapter (which is every checkout after PR #39).
  if (file === 'WhatsApp.gs' && OMIT_WHATSAPP) {
    console.log('[sim] WhatsApp.gs omitted on purpose (CELIA_OMIT_WHATSAPP_GS=1)');
    return;
  }
  // gas/ is generated and untracked, so a stale bundle sitting in the working tree
  // used to shadow the source silently: every suite passed while testing yesterday's
  // backend. If both exist they must be identical, or the run is a lie — fail loudly
  // and say which command fixes it.
  const bundled = 'gas/' + file;
  if (fs.existsSync(bundled) && fs.existsSync(file)
      && fs.readFileSync(bundled, 'utf8') !== fs.readFileSync(file, 'utf8')) {
    throw new Error(
      `${bundled} differs from ${file}: the suite would test a stale bundle. `
      + 'Rebuild it (python3 scripts/build-gas-package.py) or delete gas/ to test the sources.'
    );
  }
  const target = [bundled, file].find((candidate) => fs.existsSync(candidate));
  if (!target) {
    if (file === 'Code.gs') throw new Error('Apps Script backend not found (gas/Code.gs or Code.gs)');
    if (file === 'Llm.gs') throw new Error('Llm.gs not found; it is part of the Apps Script bundle');
    if (file === 'WhatsApp.gs') return; // adapter is optional in very old checkouts (off by default)
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
// Each simulated parent gets its own phone number: two *different* families may compete
// for the same slot (the case below), while the duplicate rule is about one family.
let parentNumber = 0;
function request(time, visitType = 'كشف جديد') {
  parentNumber += 1;
  const phone = `0100000${String(parentNumber).padStart(4, '0')}`;
  return context.createRequest({ visitType, guardianName: 'ولي أمر تجريبي', phone, day, time, consent: true });
}
function isHashRow(value) { return /^[a-f0-9]{64}$/.test(String(value || '')); }
function assertSaved(result, label) {
  assert.equal(result.ok, true, `${label}: ${result.message || 'request failed'}`);
  return result.booking;
}

// Public intake must reject formula-shaped contact fields before Sheets or the
// outage queue is touched. The fake does not evaluate formulas like real Sheets.
{
  const base = { visitType: 'كشف جديد', guardianName: 'ولي أمر تجريبي', phone: '01000000000', day, time: '09:00', consent: true };
  const attempts = [
    { guardianName: '=1+1' }, { guardianName: '  =1+1' },
    { guardianName: '<> =1+1' }, { guardianName: '\u200b=1+1' },
    { phone: '=01000000000' }, { phone: '  =01000000000' }
  ];
  for (const up of [true, false]) {
    const originalUp = googleUp;
    const priorSheets = JSON.stringify([...sheets.entries()].map(([name, sheet]) => [name, sheet.rows]));
    const priorProps = JSON.stringify([...propertyValues.entries()]);
    const priorEvents = calendar.events.length;
    try {
      googleUp = up;
      for (const fields of attempts) {
        const result = context.createRequest({ ...base, ...fields });
        assert.equal(result.ok, false, 'formula-like contact input is rejected');
        assert.match(result.message, /مساواة/, 'the validation message is actionable');
        assert.ok(!result.message.includes('=1+1'), 'the rejected value is not echoed');
      }
      assert.equal(JSON.stringify([...sheets.entries()].map(([name, sheet]) => [name, sheet.rows])), priorSheets, 'no Sheet is changed');
      assert.equal(JSON.stringify([...propertyValues.entries()]), priorProps, 'no outage or audit entry is queued');
      assert.equal(calendar.events.length, priorEvents, 'no Calendar event is created');
    } finally { googleUp = originalUp; }
  }
  const clean = context.validateRequest_({ ...base, guardianName: 'سارة أحمد', phone: '+201000000000' });
  assert.equal(clean.guardianName, 'سارة أحمد');
  assert.equal(clean.phone, '+201000000000', 'international prefix is not rewritten');
}

// Prime the 30-second availability cache before anything is approved. Without this the
// slot list below would simply be recomputed, and the regression would hide again.
const primedSlots = context.getAvailableSlots(day, 'كشف جديد');
assert.equal(primedSlots.cached, undefined, 'the first read is computed, not cached');
assert.ok(primedSlots.slots.includes('10:00'), 'the primed list offers 10:00');

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
// A staff approval changes what is bookable, so the cached list must follow immediately.
// The defect this guards: the cache was dropped on a settings change only, so for up to
// 30 seconds the page kept offering a time the clinic had just sold.
const slotsAfterApproval = context.getAvailableSlots(day, 'كشف جديد');
assert.equal(slotsAfterApproval.slots.includes('10:00'), false,
  'the approved time disappears from the cached slot list, not only from Calendar');
assert.ok(slotsAfterApproval.slots.length > 0, 'the rest of the day stays bookable');

// A failed Sheet status write after Calendar creation must be recoverable without a duplicate event.
const recoverable = assertSaved(request('11:00'), 'recovery request');
assert.equal(context.getAvailableSlots(day, 'كشف جديد').slots.includes('11:00'), true, 'prime the stale cache before the failed write');
sheets.get('Requests').failNextSet = true;
assert.equal(context.approveRequest(recoverable.reference, pin).ok, false, 'first attempt reports incomplete persistence');
assert.equal(context.getAvailableSlots(day, 'كشف جديد').slots.includes('11:00'), false, 'a partial write invalidates the availability cache');
const countAfterPartialFailure = calendar.events.filter((event) => !event.deleted).length;
assert.equal(context.approveRequest(recoverable.reference, pin).ok, true, 'retry completes the confirmation');
assert.equal(calendar.events.filter((event) => !event.deleted).length, countAfterPartialFailure, 'retry reuses the prior event');

// Editing and cancellation must keep Calendar and the sheet in step.
assert.equal(context.moveConfirmedAppointment(recoverable.reference, day, '12:00', 'اختبار', pin).ok, true);
// The move frees 11:00 and occupies 12:00; both must be visible without waiting for the cache.
const slotsAfterMove = context.getAvailableSlots(day, 'كشف جديد');
assert.equal(slotsAfterMove.slots.includes('12:00'), false, 'the moved-to time is no longer offered');
assert.equal(slotsAfterMove.slots.includes('11:00'), true, 'the moved-from time is bookable again');
assert.equal(context.cancelRequest(recoverable.reference, 'اختبار', pin).ok, true);
// Cancellation frees the time; the next guardian must see it immediately.
assert.equal(context.getAvailableSlots(day, 'كشف جديد').slots.includes('12:00'), true,
  'a cancelled appointment returns its time to the slot list at once');
assert.equal(calendar.events.filter((event) => !event.deleted).length, 1, 'cancellation removes the event');

// Read-back failure must not claim confirmation, and retry must reuse the event.
const notVisible = assertSaved(request('12:00', 'متابعة'), 'read-back request');
const originalGetEvent = calendar.getEventById;
calendar.getEventById = () => null;
assert.equal(context.approveRequest(notVisible.reference, pin).ok, false, 'missing read-back denies confirmation');
assert.equal(context.findRequest_(notVisible.reference).status, 'PENDING_APPROVAL', 'the sheet stays pending');
const afterReadFailure = calendar.events.filter((event) => !event.deleted).length;
calendar.getEventById = originalGetEvent;
assert.equal(context.approveRequest(notVisible.reference, pin).ok, true, 'retry confirms the saved event');
assert.equal(calendar.events.filter((event) => !event.deleted).length, afterReadFailure, 'read-back retry creates no duplicate');
assert.equal(context.cancelRequest(notVisible.reference, 'اختبار', pin).ok, true);

// An ambiguous timeout is recovered automatically only when the exact event exists.
const uncertain = assertSaved(request('12:00', 'متابعة'), 'ambiguous create request');
assert.equal(context.getAvailableSlots(day, 'متابعة').slots.includes('12:00'), true, 'prime the cache before the timeout');
const beforeTimeout = calendar.events.filter((event) => !event.deleted).length;
calendar.onCreate = () => { throw new Error('simulated ambiguous Calendar timeout'); };
assert.equal(context.approveRequest(uncertain.reference, pin).ok, true, 'matching saved event recovers without a second approval');
assert.equal(calendar.events.filter((event) => !event.deleted).length, beforeTimeout + 1, 'automatic recovery creates exactly one event');
assert.equal(context.getAvailableSlots(day, 'متابعة').slots.includes('12:00'), false, 'timeout clears cached availability');
assert.equal(context.cancelRequest(uncertain.reference, 'اختبار', pin).ok, true);

const notCreated = assertSaved(request('12:00', 'متابعة'), 'failed create request');
calendar.onCreate = (event) => { event.deleteEvent(); throw new Error('simulated Calendar failure'); };
assert.equal(context.approveRequest(notCreated.reference, pin).ok, false, 'no event means no confirmation');
assert.equal(context.findRequest_(notCreated.reference).status, 'PENDING_APPROVAL');
assert.equal(context.approveRequest(notCreated.reference, pin).ok, true, 'a later retry can create and verify the event');
assert.equal(context.cancelRequest(notCreated.reference, 'اختبار', pin).ok, true);

// A concurrent Calendar edit must be rechecked after creating the event.
const conflictDuringSave = assertSaved(request('12:00', 'متابعة'), 'conflict during save');
let externalConflict;
calendar.onCreate = (event) => {
  externalConflict = calendar.createEvent('external', event.start, event.end, { description: '' });
};
assert.equal(context.approveRequest(conflictDuringSave.reference, pin).ok, false, 'new external conflict blocks confirmation');
assert.equal(context.findRequest_(conflictDuringSave.reference).status, 'PENDING_APPROVAL');
externalConflict.deleteEvent();
assert.equal(context.approveRequest(conflictDuringSave.reference, pin).ok, true, 'retry works after the conflict is resolved');
assert.equal(context.cancelRequest(conflictDuringSave.reference, 'اختبار', pin).ok, true);

// A changed event is refused and must be corrected before it can be confirmed.
const mismatch = assertSaved(request('12:00', 'متابعة'), 'mismatched event request');
let alteredEvent;
calendar.onCreate = (event) => { alteredEvent = event; event.end = new Date(event.end.getTime() + 60000); };
assert.equal(context.approveRequest(mismatch.reference, pin).ok, false, 'wrong saved duration denies confirmation');
assert.equal(context.findRequest_(mismatch.reference).status, 'PENDING_APPROVAL');
assert.equal(context.approveRequest(mismatch.reference, pin).ok, false, 'retry refuses the mismatched event');
alteredEvent.end = new Date(alteredEvent.end.getTime() - 60000);
assert.equal(context.approveRequest(mismatch.reference, pin).ok, true, 'corrected event can be confirmed');
assert.equal(context.cancelRequest(mismatch.reference, 'اختبار', pin).ok, true);

// Marker matching must be exact and duplicates must never be silently selected.
const fakeMarker = (description) => ({ getDescription: () => description });
assert.equal(context.calendarEventHasReference_(fakeMarker('مرجع إداري: CK-1234567'), 'CK-123456'), false, 'a prefix is not the reference');
assert.equal(context.calendarEventHasReference_(fakeMarker('مرجع إداري: CK-123456\nبيانات طبية: غير محفوظة.'), 'CK-123456'), true);
const ambiguous = assertSaved(request('12:00', 'متابعة'), 'duplicate event request');
const duplicateStart = context.makeDate_(day, '12:00');
const duplicateEnd = new Date(duplicateStart.getTime() + 30 * 60000);
const duplicateA = calendar.createEvent('test', duplicateStart, duplicateEnd, { description: 'مرجع إداري: ' + ambiguous.reference });
const duplicateB = calendar.createEvent('test', duplicateStart, duplicateEnd, { description: 'مرجع إداري: ' + ambiguous.reference });
assert.equal(context.approveRequest(ambiguous.reference, pin).ok, false, 'ambiguous duplicate events require human review');
assert.equal(context.findRequest_(ambiguous.reference).status, 'PENDING_APPROVAL');
duplicateA.deleteEvent();
duplicateB.deleteEvent();

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
// ---- prices: shown only when the clinic set one, never invented ----
// A price rides on the service definition, so there is no second table to drift from.
const pricedProfile = context.getClinicProfile();
assert.equal(pricedProfile.ok, true, 'the public profile loads');
assert.ok(Array.isArray(pricedProfile.services) && pricedProfile.services.length === 3,
  'the profile ships the configured services — without them the page kept showing the defaults');
assert.equal(pricedProfile.services[0].label, 'كشف أول', 'the profile carries the real first service');
assert.equal(pricedProfile.services[0].price, 0, 'a service saved without a price reports 0, and 0 means "not announced"');
const pricedSave = context.saveClinicSettings({
  reason: 'price test',
  values: { VISIT_SERVICES: 'كشف أول = 45 = 250\nمتابعة = 20\nاستشارة قصيرة = 15 = 120' }
}, pin);
assert.equal(pricedSave.ok, true, pricedSave.message);
const priced = context.getClinicProfile().services;
assert.equal(priced[0].price, 250, 'a price typed in settings reaches the public profile');
assert.equal(priced[1].price, 0, 'a service with no price stays unannounced');
assert.equal(priced[0].minutes, 45, 'the duration still parses alongside the price');
assert.match(pricedSave.settings.values.VISIT_SERVICES, /كشف أول = 45 = 250/,
  'the settings screen echoes the price back so the doctor can edit it');
assert.equal(context.saveClinicSettings({ values: { VISIT_SERVICES: 'كشف أول = 45 = -5' } }, pin).ok, false,
  'a negative price is refused');
assert.equal(context.saveClinicSettings({ values: { VISIT_SERVICES: 'كشف أول = 45 = كثير' } }, pin).ok, false,
  'a non-numeric price is refused rather than silently dropped');

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
const newPin = `pin-${crypto.randomBytes(12).toString('hex')}`;
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
assert.equal(context.saveStaffPin(bootstrapHash, hashPin(`pin-${crypto.randomBytes(12).toString('hex')}`), bootstrapHash).ok, true);
assert.equal(context.isStaff_(bootstrapHash), false, 'the generated PIN is dead after the change');

// ---- the staff gate cannot be guessed at (a shared browser is the real threat) ----
// Before this limit the gate answered wrong PINs forever; a 24-character PIN bought nothing
// against an endpoint that never says "stop". The counter and the lock live in the script
// cache, which the fake now shares across calls exactly like Apps Script does.
const gateHash = propertyValues.get('ADMIN_PIN_HASH');
const wrongPin = () => hashPin(`wrong-${crypto.randomBytes(8).toString('hex')}`);
// Earlier cases in this suite deliberately use bad PINs; a fresh counter is what an
// administrator would have after a lock window, and it makes the threshold observable.
context.staffPinSuccess_();
assert.equal(context.staffPinLockState_().locked, false, 'the gate starts unlocked');
for (let attempt = 1; attempt <= 4; attempt += 1) {
  assert.equal(context.isStaff_(wrongPin()), false, `wrong PIN ${attempt} is refused`);
  assert.equal(context.staffPinLockState_().locked, false, `no lock before the threshold (attempt ${attempt})`);
}
assert.equal(context.isStaff_(wrongPin()), false, 'the fifth wrong PIN is refused');
assert.equal(context.staffPinLockState_().locked, true, 'five wrong PINs arm the lock');
assert.equal(context.isStaff_(gateHash), false, 'the correct PIN is refused while the lock is armed');
assert.equal(context.getClinicSettings(gateHash).ok, false, 'a locked gate also blocks the settings screen');
context.staffPinSuccess_(); // stands in for the lock window expiring
assert.equal(context.staffPinLockState_().locked, false, 'the lock clears when its window ends');
assert.equal(context.getClinicSettings(gateHash).ok, true, 'the correct PIN works again after the window');
assert.equal(context.staffPinLockState_().maxFailures, 5, 'the threshold is declared, not implied');
assert.equal(context.staffPinLockState_().lockSeconds, 900, 'the lock window is measured in minutes, not seconds');
// A successful login resets the counter, so four typos today never become a lock tomorrow.
for (let attempt = 0; attempt < 4; attempt += 1) context.isStaff_(wrongPin());
assert.equal(context.isStaff_(gateHash), true, 'the correct PIN still works after four typos');
assert.equal(context.isStaff_(wrongPin()), false, 'and the counter restarted from zero');
assert.equal(context.staffPinLockState_().locked, false, 'a good login between typos never arms the lock');

// A failed login checks Staff and the legacy property, but must count only once.
context.staffPinSuccess_();
for (let attempt = 1; attempt <= 4; attempt += 1) {
  assert.equal(context.login(wrongPin()).ok, false, `wrong login ${attempt} is refused`);
  assert.equal(context.staffPinLockState_().locked, false, `login ${attempt} must not lock before five attempts`);
  assert.equal(Number(sharedScriptCache.get('CK_PIN_FAILURES')), attempt, 'each login increments once');
}
assert.equal(context.login(wrongPin()).ok, false, 'the fifth wrong login is refused');
assert.equal(context.staffPinLockState_().locked, true, 'the fifth wrong login arms the lock');
context.staffPinSuccess_();

// Preserve the transitional property-only path, including plain PIN migration.
const savedSeed = context.ensureStaffSeeded_;
const savedAdminHash = propertyValues.get('ADMIN_PIN_HASH');
try {
  context.ensureStaffSeeded_ = () => [];
  propertyValues.delete('ADMIN_PIN_HASH');
  propertyValues.set('ADMIN_PIN', 'legacy-plain-pin-value-32-chars');
  assert.equal(context.login('wrong-legacy-pin').ok, false);
  assert.equal(Number(sharedScriptCache.get('CK_PIN_FAILURES')), 1, 'a legacy miss counts once');
  assert.equal(context.login('legacy-plain-pin-value-32-chars').ok, true, 'legacy login still succeeds');
  assert.equal(propertyValues.get('ADMIN_PIN_HASH'), hashPin('legacy-plain-pin-value-32-chars'));
  assert.equal(propertyValues.has('ADMIN_PIN'), false, 'legacy login still migrates the plain PIN');
  assert.equal(sharedScriptCache.has('CK_PIN_FAILURES'), false, 'a successful legacy login clears failures');
} finally {
  context.ensureStaffSeeded_ = savedSeed;
  propertyValues.delete('ADMIN_PIN');
  propertyValues.set('ADMIN_PIN_HASH', savedAdminHash);
  context.staffPinSuccess_();
}

// ---- the audit row names the signed-in account, not just "staff" ----
// The recorded actor is what answers "who confirmed this appointment?" after a mistake.
activeUserEmail = 'Doctor@' + MAIL_HOST;
const actorPinHash = propertyValues.get('ADMIN_PIN_HASH');
// `day` was closed earlier in this suite to test closures, so attribution uses the next
// open workday: a closed day would fail for an unrelated reason and prove nothing.
const attributionDay = (() => {
  const start = new Date(`${day}T12:00:00Z`);
  for (let i = 1; i <= 14; i += 1) {
    const candidate = new Date(start.getTime() + i * 86400000);
    if ([0, 1, 2, 3, 4].includes(candidate.getUTCDay())) return candidate.toISOString().slice(0, 10);
  }
  throw new Error('no second workday available');
})();
const attributedRequest = (time, label) => {
  parentNumber += 1;
  return assertSaved(context.createRequest({
    visitType: 'كشف جديد', guardianName: 'ولي أمر تجريبي',
    phone: `0100000${String(parentNumber).padStart(4, '0')}`, day: attributionDay, time, consent: true
  }), label);
};
const actorRequest = attributedRequest('09:00', 'actor attribution request');
assert.equal(context.approveRequest(actorRequest.reference, actorPinHash).ok, true);
const auditRows = sheets.get('Audit').rows;
const approvalRow = auditRows.find((row) => row[3] === 'APPROVED_AND_SAVED' && row[2] === actorRequest.reference);
assert.ok(approvalRow, 'the approval was written to the Audit sheet');
assert.equal(approvalRow[1], 'staff:doctor@' + MAIL_HOST, 'the audit row carries the signed-in account, lower-cased');
assert.equal(context.getClinicProfile && Object.keys(context.getClinicProfile()).some((k) => /email/i.test(k)), false,
  'the public clinic profile never exposes the staff email');
activeUserEmail = null;
assert.equal(context.staffActor_(), 'staff', 'an unresolvable user degrades to plain "staff" rather than failing');
const anonymousRequest = attributedRequest('11:00', 'anonymous actor request');
assert.equal(context.approveRequest(anonymousRequest.reference, actorPinHash).ok, true);
assert.equal(sheets.get('Audit').rows.find((row) => row[3] === 'APPROVED_AND_SAVED' && row[2] === anonymousRequest.reference)[1],
  'staff', 'without an account the audit row stays the neutral label');

// ---- one open request per phone per day (the clinic must not receive the child twice) ----
const dupPin = context.randomStaffPin_();
propertyValues.set('ADMIN_PIN_HASH', hashPin(dupPin));
const dupDay = '2030-06-03';
const firstRequest = context.createRequest({
  visitType: 'كشف جديد', day: dupDay, time: '10:00',
  guardianName: 'ولي أمر تجريبي', phone: '0100 111 2233', consent: true
});
assert.equal(firstRequest.ok, true, 'the first request is accepted');
// Same service on purpose: the only difference is the phone formatting and the time, so
// a refusal can only come from the duplicate rule.
const secondRequest = context.createRequest({
  visitType: 'كشف جديد', day: dupDay, time: '11:00',
  guardianName: 'ولي أمر تجريبي', phone: '01001112233', consent: true
});
assert.equal(secondRequest.ok, false, 'a second open request for the same phone and day is refused');
assert.equal(secondRequest.duplicate, true, 'the refusal is marked as a duplicate');
assert.equal(secondRequest.reference, firstRequest.booking.reference, 'the existing reference is returned, so the parent can track it');
const otherDay = context.createRequest({
  visitType: 'كشف جديد', day: '2030-06-04', time: '11:00',
  guardianName: 'ولي أمر تجريبي', phone: '01001112233', consent: true
});
assert.equal(otherDay.ok, true, 'a different day is a new request, not a duplicate');

// ---- a daily cap per phone keeps one number from filling the clinic queue ----
// The counter is per day and per phone, whatever the status: three requests are accepted
// (the clinic log has three rows for that number that day), the fourth is refused with a
// reason the interface can show.
const capDay = '2031-03-10';
const capPhone = '01007776655';
// Two requests are enough to show the rule: the second is refused as a duplicate (one
// open request per phone per day), so the cap is exercised on a number that already has
// three rows for the day written by earlier tests.
const firstCapRequest = context.createRequest({
  visitType: 'كشف جديد', day: capDay, time: '09:00',
  guardianName: 'ولي أمر متكرر', phone: capPhone, consent: true
});
assert.equal(firstCapRequest.ok, true, 'the first request from that number is accepted');
assert.equal(context.countRequestsForPhone_(capPhone, capDay), 1, 'the counter sees exactly one row for that phone and day');
// Seed two more rows for the same number and day, which is what retries would create.
for (let extra = 0; extra < 2; extra += 1) {
  context.requestsSheet_().appendRow(['CK-CAP-' + extra, new Date().toISOString(), 'CANCELLED',
    'كشف جديد', 'ولي أمر متكرر', capPhone, capDay, '10:0' + extra, '', new Date().toISOString(), true, true]);
}
assert.equal(context.countRequestsForPhone_(capPhone, capDay), 3, 'three rows for that number and day are counted');
const capped = context.createRequest({
  visitType: 'كشف جديد', day: capDay, time: '12:00',
  guardianName: 'ولي أمر متكرر', phone: capPhone, consent: true
});
assert.equal(capped.ok, false, 'the fourth request that day is refused');
assert.equal(capped.rateLimited, true, 'the refusal names the reason, so the UI can explain it');
assert.match(capped.message, /الحد الأقصى/, 'the message tells the parent what happened');

// ---- the clinic's clock, not the script account's ----
// `new Date(y, m, d, h, min)` reads the *runtime's* zone. A script account in UTC built
// 09:00 Cairo as 09:00 UTC — two hours late — so "is this slot still in the future?"
// and the weekday check were answered for the wrong moment.
const cairoNine = context.clinicWallClock_('2031-03-10', '09:00');
assert.equal(dateParts(cairoNine, 'Africa/Cairo').hour, '09', '09:00 is 09:00 at the clinic');
assert.equal(dateParts(cairoNine, 'Africa/Cairo').minute, '00', 'and not shifted by minutes');
assert.equal(cairoNine.getTime(), Date.parse('2031-03-10T07:00:00Z'), '09:00 Cairo is 07:00 UTC in March');
// The booking path itself, not just the helper. This suite pins TZ to the clinic by
// default, which would hide the bug, so the same call is repeated with the script
// effectively running somewhere else (Apps Script accounts commonly run in UTC).
const withRuntimeZone = (zone, fn) => {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try { return fn(); } finally { process.env.TZ = previous; }
};
const madeNine = context.makeDate_('2031-03-10', '09:00');
assert.equal(madeNine.getTime(), cairoNine.getTime(), 'makeDate_ builds the clinic wall clock, not the runtime zone');
assert.equal(dateParts(madeNine, 'Africa/Cairo').hour, '09', 'a 09:00 appointment reads 09:00 at the clinic');
['UTC', 'America/New_York', 'Pacific/Kiritimati'].forEach((zone) => {
  const instant = withRuntimeZone(zone, () => context.makeDate_('2031-03-10', '09:00'));
  assert.equal(instant.getTime(), cairoNine.getTime(),
    `09:00 stays 09:00 at the clinic when the script runs in ${zone}`);
});
// The weekday must come from the calendar date, never from an instant's runtime zone.
assert.equal(context.clinicWeekday_('2031-03-10'), 1, '2031-03-10 is a Monday');
assert.equal(context.clinicWeekday_('2031-03-14'), 5, '2031-03-14 is a Friday');
// The clinic works Sunday-Thursday, so Friday is the closed day: a valid future day with
// no slots, not an error — and it stays closed whatever zone the script runs in.
const fridaySlots = context.getAvailableSlots('2031-03-14', 'كشف جديد');
assert.equal(fridaySlots.ok, true, 'a closed day is a valid day with no slots, not an error');
assert.equal(fridaySlots.slots.length, 0, 'the clinic is closed on Friday whatever zone the script runs in');

// A 45-minute visit on a 30-minute grid must not be offered a start that ends after
// closing: 09:00-14:00 offers 09:00..13:00 and never 13:30.
assert.equal(context.paddedStartIndex_(300, 45, 30), 30, 'the end padding for a 45-minute visit');
const lastStart = 840 - 45 - context.paddedStartIndex_(300, 45, 30);
assert.equal(lastStart, 765, 'the last acceptable start is 12:45 (13:30 would end 14:15)');
const gridSlots = [];
for (let minute = 540; minute <= lastStart; minute += 30) gridSlots.push(minute);
assert.equal(gridSlots[gridSlots.length - 1], 750, '13:00 ends exactly at closing and stays bookable');
assert.equal(gridSlots.includes(810), false, '13:30 is never offered for a 45-minute visit');
assert.equal(propertyValues.has('CK_MUST_CHANGE_PIN'), false, 'the flag clears after the change');
const readinessAfter = context.validateConfig().checks.find((c) => c.id === 'admin_pin');
assert.equal(readinessAfter.ok, true, 'readiness passes once the doctor owns the PIN — ' + readinessAfter.detail);
assert.equal(context.getClinicSettings(bootstrapHash).ok, false, 'the bootstrap PIN stops working immediately');

// ---------------------------------------------------------------------------
// initializeCeliaKids — the one-time setup path. It was uncallable from this
// suite until FakeSheet gained getLastColumn()/getName() and FakeCalendar gained
// getName(); the three methods it touches did not exist, so the function that
// creates every sheet and writes every header row had zero coverage.
// ---------------------------------------------------------------------------
{
  // CK is a top-level `const` inside the vm script scope, so it is not a property
  // of the context object; it is only reachable by evaluating in that same context.
  const CK = vm.runInContext('CK', context);

  // Fresh install: drop every sheet and the recorded spreadsheet id, keeping the
  // doctor's PIN configuration so the run exercises setup, not PIN bootstrap.
  sheets.clear();
  propertyValues.delete('CELIA_SHEET_ID');
  const firstRun = context.initializeCeliaKids();

  assert.equal(typeof firstRun, 'string', 'initializeCeliaKids returns the operator-facing summary');
  assert.match(firstRun, /Celia Kids \(simulated\)/, 'the summary names the calendar it bound');
  assert.equal(propertyValues.get('CELIA_SHEET_ID'), 'simulated-spreadsheet-id', 'the spreadsheet id is recorded for later runs');

  // Array.from copies the vm-realm arrays into this realm: deepStrictEqual compares
  // prototypes, and an Array created inside the vm context is not an Array here.
  for (const [name, expected] of [[CK.REQUESTS, Array.from(CK.REQUEST_HEADERS)], [CK.AUDIT, Array.from(CK.AUDIT_HEADERS)], [CK.CLOSURES, Array.from(CK.CLOSURE_HEADERS)]]) {
    const sheet = sheets.get(name);
    assert.ok(sheet, `initializeCeliaKids creates the ${name} sheet`);
    assert.deepEqual(sheet.rows[0], expected, `the ${name} header row is exactly the declared schema`);
    assert.equal(sheet.getLastRow(), 1, `the ${name} sheet holds a header row and nothing else`);
    assert.equal(sheet.getLastColumn(), expected.length, `the ${name} header spans every declared column`);
  }

  // Second run must be a no-op, not a second header row: the header guard in
  // ensureSheet_ is what makes setup safe to re-run after a partial failure.
  const secondRun = context.initializeCeliaKids();
  assert.match(secondRun, /Celia Kids \(simulated\)/, 'a re-run still reports success');
  for (const name of [CK.REQUESTS, CK.AUDIT, CK.CLOSURES]) {
    assert.equal(sheets.get(name).getLastRow(), 1, `re-running setup does not duplicate the ${name} header`);
  }

  // The header row is formatted, and real sheets count formatting as occupied:
  // this is the case that used to be unrepresentable, so a regression in the
  // header guard can no longer hide behind a getLastRow() that ignores it.
  const requestsSheet = sheets.get(CK.REQUESTS);
  assert.ok(requestsSheet.formattedUpTo >= 1, 'the frozen header row carries formatting');
  assert.equal(requestsSheet.getLastRow(), 1, 'formatting on the header row does not invent extra rows');

  // A stray bold cell far below the data must not make the sheet look populated.
  // ensureSheet_ only writes a header when the sheet is empty, so a sheet that
  // merely *looks* non-empty would silently keep no header at all.
  const stray = new FakeSheet(CK.REQUESTS);
  stray.markFormatted(8);
  assert.equal(stray.getLastRow(), 8, 'a stray formatted row is reported as the last row (real Sheet semantics)');
  assert.equal(stray.rows.length, 0, 'but it still holds no data');

  console.log('Setup path covered: initializeCeliaKids creates all three sheets with their exact headers, is idempotent on re-run, and records the spreadsheet id.');
}

// ---------------------------------------------------------------------------
// Schema drift — the second half of the dual guard. assertSheetSchema_ is only
// worth what this block proves: make the declared schema and the live sheet
// disagree and require a loud failure. Without it the guard could be deleted in
// any refactor and every suite would still pass.
// ---------------------------------------------------------------------------
{
  const CK = vm.runInContext('CK', context);
  const originalHeaders = Array.from(CK.REQUEST_HEADERS);
  const keepRequests = sheets.get(CK.REQUESTS);
  const resetGuard = () => { context.sheetSchemaIndex_ = {}; };
  const NAME = '\u0633\u0627\u0631\u0629', VISIT = '\u0643\u0634\u0641 \u062c\u062f\u064a\u062f', PHONE = '01000000000';
  const liveRow = ['CK-DRIFT', '2026-11-06 09:00', 'PENDING', VISIT, NAME, PHONE, '2026-11-09', '10:00', '', '2026-11-06 09:00', true, true];

  // The live sheet: created before the change, still the old 12-column layout.
  const oldLayout = () => { const sh = new FakeSheet(CK.REQUESTS); sh.rows = [[...originalHeaders], liveRow]; return sh; };
  // The edit under test: code gains a `notes` column at position 2, the sheet does not.
  const addColumn = () => { CK.REQUEST_HEADERS.splice(1, 0, 'notes'); };
  const restore = () => { CK.REQUEST_HEADERS.length = 0; originalHeaders.forEach((h) => CK.REQUEST_HEADERS.push(h)); };

  try {
    // 1 — declared schema and live sheet disagree: fail loudly, name the column.
    addColumn(); resetGuard(); sheets.set(CK.REQUESTS, oldLayout());
    assert.throws(
      () => context.readAllRequests_(),
      (error) => /\u0645\u062e\u0637\u0637/.test(error.message) && /2/.test(error.message) && /notes/.test(error.message),
      'a drifted header must fail loudly and name the column and the expected header'
    );

    // 2 — the stray-formatting sheet: getLastRow() reports 8, so ensureSheet_ skips
    // the header write and row 1 reads back empty. Must fail, not fabricate.
    restore(); resetGuard();
    const stray = new FakeSheet(CK.REQUESTS);
    stray.markFormatted(8);
    sheets.set(CK.REQUESTS, stray);
    assert.throws(() => context.readAllRequests_(), /\u0645\u062e\u0637\u0637/, 'a formatted but headerless sheet must fail, not read as empty');

    // 3 — a correct sheet passes, and stray formatting *below* real data no longer
    // invents a phantom record.
    restore(); resetGuard();
    const good = oldLayout();
    good.markFormatted(8);
    sheets.set(CK.REQUESTS, good);
    // readAllRequests_ also merges the outage queue, which earlier suites have
    // filled; only the sheet-derived records are under test here.
    const read = context.readAllRequests_();
    assert.equal(read.filter((item) => item.reference === '').length, 0, 'stray formatting below the data yields no phantom record');
    const mine = read.filter((item) => item.reference === 'CK-DRIFT');
    assert.equal(mine.length, 1, 'the one real record is read');
    assert.equal(mine[0].guardianName, NAME, 'the name column still holds the name');
    assert.equal(mine[0].phone, PHONE, 'the phone column still holds the phone');

    // 4 — the failure is observable, not merely thrown.
    addColumn(); resetGuard();
    const logged = [];
    const originalLog = context.logEvent_;
    context.logEvent_ = (level, event, payload) => { if (event === 'schema_drift') logged.push(payload); return originalLog(level, event, payload); };
    sheets.set(CK.REQUESTS, oldLayout());
    assert.throws(() => context.readAllRequests_(), /\u0645\u062e\u0637\u0637/, 'drift still throws while being logged');
    context.logEvent_ = originalLog;
    assert.equal(logged.length, 1, 'schema_drift is logged exactly once');
    assert.equal(logged[0].sheet, CK.REQUESTS, 'the log names the sheet');
    assert.equal(logged[0].position, 2, 'the log names the column position');
    assert.equal(logged[0].expected, 'notes', 'the log records the expected header');
    assert.equal(logged[0].found, undefined, 'the log must not copy a possibly sensitive header cell');
    restore();

    // 5 — mutation check. With the guard neutralised, the same drift reads through
    // silently and puts the phone into the name field publicBooking_() renders.
    // Asserted so that deleting the guard fails this suite.
    addColumn(); resetGuard();
    const savedGuard = context.assertSheetSchema_;
    const savedRow = context.rowToRequest_;
    // Neutralise the guard AND apply the rest of the same realistic edit — the
    // positional mapping moves by one, which is what a developer adding a column
    // writes. Without both, the read is merely wide, not shifted.
    context.assertSheetSchema_ = (sheet, hdrs, label) => { const idx = {}; hdrs.forEach((h, n) => { idx[h] = n; }); return idx; };
    context.rowToRequest_ = (row) => ({
      reference: String(row[0] || ''), notes: String(row[1] || ''), createdAt: String(row[2] || ''),
      status: String(row[3] || ''), visitType: String(row[4] || ''), guardianName: String(row[5] || ''),
      phone: String(row[6] || ''), day: '', time: String(row[8] || ''), eventId: String(row[9] || ''),
      updatedAt: String(row[10] || ''), consent: row[11] === true, slotVerified: row[12] === true
    });
    sheets.set(CK.REQUESTS, oldLayout());
    const silent = context.readAllRequests_().filter((item) => item.reference === 'CK-DRIFT');
    context.assertSheetSchema_ = savedGuard;
    context.rowToRequest_ = savedRow;
    assert.equal(silent.length, 1, 'the drifted sheet still yields exactly one record');
    assert.equal(silent[0].guardianName, PHONE, 'unguarded, the phone lands in the name field publicBooking_ renders');
    assert.equal(silent[0].phone, '2026-11-09', 'unguarded, the phone column holds a date — silent corruption, no error');
    assert.equal(silent[0].status, VISIT, 'unguarded, the status column holds the visit type');
    restore();
  } finally {
    restore();
    sheets.set(CK.REQUESTS, keepRequests);
    resetGuard();
  }
  console.log('Schema drift guarded: a drifted header fails loudly and logs schema_drift, a formatted-but-headerless sheet fails, stray formatting below data yields no phantom record, and neutralising the guard is caught.');
}

// ---------------------------------------------------------------------------
// Ordering and propagation. Two questions the simulator can answer before any
// real account is involved:
//   (a) does the guard break the very first run on an empty sheet?
//   (b) does the throw reach a human, or is it swallowed by a broad catch?
// ---------------------------------------------------------------------------
{
  const CK = vm.runInContext('CK', context);
  const originalHeaders = Array.from(CK.REQUEST_HEADERS);
  const keepRequests = sheets.get(CK.REQUESTS);
  const resetGuard = () => { context.sheetSchemaIndex_ = {}; };
  // The suite rotates the staff PIN several times; rather than depend on where it
  // ended up, install a known one for this block and put it back afterwards.
  const keepHash = propertyValues.get('ADMIN_PIN_HASH');
  const driftPin = `drift-${crypto.randomBytes(12).toString('hex')}`;
  propertyValues.set('ADMIN_PIN_HASH', hashPin(driftPin));

  // (a) First run: a brand-new sheet has no header. ensureSheet_ writes it *before*
  // assertSheetSchema_ runs, so setup must succeed — otherwise a fresh install
  // could never come up.
  resetGuard();
  const virgin = new FakeSheet(CK.REQUESTS);
  sheets.set(CK.REQUESTS, virgin);
  assert.equal(virgin.rows.length, 0, 'the sheet starts genuinely empty');
  let firstRunError = null;
  try { context.readAllRequests_(); } catch (error) { firstRunError = error; }
  assert.equal(firstRunError, null, 'an empty sheet is not drift: the header is written before it is checked');
  assert.deepEqual(virgin.rows[0], originalHeaders, 'the first access installs the declared header');
  // The healthy baseline for the flat status field.
  const keepHashBaseline = propertyValues.get('ADMIN_PIN_HASH');
  const baselinePin = `baseline-${crypto.randomBytes(12).toString('hex')}`;
  propertyValues.set('ADMIN_PIN_HASH', hashPin(baselinePin));
  const baseline = context.getHealthReport(baselinePin);
  propertyValues.set('ADMIN_PIN_HASH', keepHashBaseline);
  // At this point earlier suites have filled the outage queues, so the clinic is
  // genuinely unhealthy — but not drifted. That is the distinction the flat field
  // exists to carry: a monitor must not page for "drift" when the cause is queues.
  assert.ok(['ok', 'drift', 'down'].includes(baseline.status), 'status is always one of the three known words, got ' + baseline.status);
  assert.notEqual(baseline.status, 'drift', 'a non-schema failure is never reported as drift');
  assert.equal(baseline.status, 'down', 'the full outage queue reports "down", not "drift"');

  // (b) Propagation. A drifted sheet must not be reported as a network problem.
  const addColumn = () => { CK.REQUEST_HEADERS.splice(1, 0, 'notes'); };
  const restore = () => { CK.REQUEST_HEADERS.length = 0; originalHeaders.forEach((h) => CK.REQUEST_HEADERS.push(h)); };
  const oldLayout = () => {
    const sh = new FakeSheet(CK.REQUESTS);
    sh.rows = [[...originalHeaders], ['CK-PROP', '2026-11-06 09:00', 'PENDING', '\u0643\u0634\u0641', '\u0633\u0627\u0631\u0629', '01000000000', '2026-11-09', '10:00', '', '2026-11-06 09:00', true, true]];
    return sh;
  };

  try {
    addColumn(); resetGuard(); sheets.set(CK.REQUESTS, oldLayout());

    // Staff board: must name the sheet, not blame the connection.
    const board = context.getDashboard(driftPin);
    const driftWarning = (board.warnings || []).find((w) => /\u0623\u0639\u0645\u062f\u0629|schema_drift/.test(w));
    assert.ok(driftWarning, 'the board carries a schema-drift warning: ' + JSON.stringify(board.warnings));
    assert.match(driftWarning, new RegExp(CK.REQUESTS), 'the warning names the offending sheet');
    assert.equal((board.warnings || []).some((w) => /\u0631\u0627\u062c\u0639\u0648\u0627 \u0627\u0644\u0627\u062a\u0635\u0627\u0644/.test(w)), false,
      'drift is never reported as a connection problem');

    // Health: the envelope ok means "the check ran"; report.ok means "the clinic is
    // healthy". Drift must turn the latter off and name the sheet in the sheets check.
    const health = context.getHealthReport(driftPin);
    assert.equal(health.ok, true, 'the health check still runs while the schema is drifted');
    assert.equal(health.report.ok, false, 'the health report goes red on drift');
    const sheetsCheck = health.report.checks.find((check) => check.id === 'sheets');
    assert.equal(sheetsCheck.ok, false, 'the sheets check is the one that fails');
    assert.match(sheetsCheck.detail, new RegExp(CK.REQUESTS), 'the failing check names the sheet');
    assert.match(sheetsCheck.detail, /schema_drift/, 'and names the cause, not a generic outage');
    // The flat field an external monitor watches. `ok` alone cannot carry it: the
    // unauthenticated endpoint also answers ok:false, so a monitor reading only that
    // cannot tell "closed" from "drifted" from "down".
    assert.equal(health.status, 'drift', 'the flat status names drift, not a generic failure');
    assert.equal(health.report.status, 'drift', 'and the report carries the same word');

    // Guardian: fails closed, but the internal text is not handed to a parent.
    const booked = context.createRequest({
      guardianName: '\u0633\u0627\u0631\u0629', phone: '01000000000', day: '2026-11-09',
      time: '10:00', visitType: '\u0643\u0634\u0641 \u062c\u062f\u064a\u062f', consent: true
    });
    assert.equal(booked.ok, false, 'no request is accepted while the schema is drifted');
    assert.equal(/\u0623\u0639\u0645\u062f\u0629|\u0627\u0644\u0639\u0645\u0648\u062f/.test(booked.message), false,
      'the guardian is not shown internal column details');
    restore();
  } finally {
    restore();
    sheets.set(CK.REQUESTS, keepRequests);
    resetGuard();
    propertyValues.set('ADMIN_PIN_HASH', keepHash);
  }
  console.log('Guard ordering and propagation proven: an empty sheet is not drift, and drift reaches the board, the health check and the guardian as itself — never as a connection problem.');
}

console.log('Offline simulated Apps Script tests passed: competing approvals, visit duration, partial-write retry, edit/cancel, Calendar outage, Sheets/audit outage and full-audit queues, request-queue-full rejection, closed days removed from availability, a secret-free clinic profile, dashboard-editable settings (validation, services, PIN hashing and migration), slot starts that always fit inside opening hours, one open request per phone per day, and the daily per-number cap.')
;

/* ------------------------------------------------------------------- roles ---- */
// ADR 0007: identity is a staff row, not a shared PIN. These are the assertions that fail
// if anyone reverts to "one PIN opens everything".
const rolesPin = (label) => `pin-${label}-${crypto.randomBytes(10).toString('hex')}`;
const ownerPin = rolesPin('owner');
const ownerHash = hashPin(ownerPin);
propertyValues.set('ADMIN_PIN_HASH', ownerHash);
context.ensureStaffSeeded_();
const staffSheetRows = sheets.get('Staff').rows;
assert.equal(staffSheetRows[1][2], 'CLINIC_ADMIN', 'the legacy PIN is seeded as the owner row');
assert.match(String(staffSheetRows[1][3]), /^[0-9a-f]{64}$/, 'only a SHA-256 digest is stored in the staff table');
staffSheetRows[1][3] = ownerHash;

const ownerLogin = context.login(ownerHash);
assert.equal(ownerLogin.ok, true, 'the owner logs in');
assert.equal(ownerLogin.staff.role, 'CLINIC_ADMIN');
assert.ok(ownerLogin.token && ownerLogin.token.length >= 24, 'a session token is issued');
assert.equal(JSON.stringify(ownerLogin).indexOf(ownerPin), -1, 'the credential is never echoed back');
assert.equal(ownerLogin.permissions.indexOf('staff:manage') !== -1, true, 'the owner may manage staff');

// A role change must not leave an existing privileged session usable.
staffSheetRows[1][2] = 'RECEPTION';
assert.equal(context.listStaff(ownerLogin.token).ok, false, 'old administrator session is denied after a role change');
assert.equal(context.getDashboard(ownerLogin.token).ok, false, 'a mismatched role denies the old session entirely');
assert.equal(context.generateDailySummary(ownerLogin.token).ok, false, 'daily summary also rejects a role-changed session');
const downgradedLogin = context.login(ownerHash);
assert.equal(downgradedLogin.staff.role, 'RECEPTION', 'a fresh login receives the current role');
assert.equal(context.listStaff(downgradedLogin.token).ok, false, 'the fresh session cannot manage staff');
staffSheetRows[1][2] = 'CLINIC_ADMIN';
assert.equal(context.listStaff(ownerLogin.token).ok, true, 'the original session works again only when the row matches');

// Provider exception text can contain secrets or personal data: logs keep fixed codes only.
{
  const marker = `sensitive-${crypto.randomBytes(12).toString('hex')}`;
  const lines = [];
  const savedConsole = context.console;
  const savedSeedStaff = context.ensureStaffSeeded_;
  const savedStaffSheet = context.staffSheet_;
  const savedSetProperty = properties.setProperty;
  context.console = { log: (line) => lines.push(line), info: (line) => lines.push(line),
    warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  try {
    context.ensureStaffSeeded_ = () => { throw new Error(marker); };
    assert.equal(context.login(ownerHash).ok, false);
    context.ensureStaffSeeded_ = savedSeedStaff;
    properties.setProperty = (key, value) => {
      if (key.startsWith('CK_SESSION_')) throw new Error(marker);
      return savedSetProperty.call(properties, key, value);
    };
    assert.equal(context.login(ownerHash).code, 'SESSION_UNAVAILABLE');
    properties.setProperty = savedSetProperty;
    context.staffSheet_ = () => { throw new Error(marker); };
    assert.equal(context.syncStaffPinHash_(ownerHash, hashPin('unused')), false);
    assert.equal(lines.some((line) => line.includes('staff_lookup_failed')), true);
    assert.equal(lines.some((line) => line.includes('session_store_failed')), true);
    assert.equal(lines.some((line) => line.includes('staff_pin_sync_failed')), true);
    assert.equal(lines.some((line) => line.includes(marker)), false, 'no exception text appears in staff logs');
  } finally {
    context.console = savedConsole;
    context.ensureStaffSeeded_ = savedSeedStaff;
    context.staffSheet_ = savedStaffSheet;
    properties.setProperty = savedSetProperty;
  }
}

const doctorPin = rolesPin('doctor');
const receptionPin = rolesPin('reception');
assert.equal(context.addStaff('د. مختار سيد كامل', 'DOCTOR', hashPin(doctorPin), ownerLogin.token).ok, true, 'the owner adds a doctor');
assert.equal(context.addStaff('استقبال', 'RECEPTION', hashPin(receptionPin), ownerLogin.token).ok, true, 'the owner adds the desk');
assert.equal(context.addStaff('x', 'SUPERUSER', hashPin(rolesPin('bad')), ownerLogin.token).ok, false, 'an unknown role is refused');
assert.equal(context.addStaff('dup', 'DOCTOR', hashPin(doctorPin), ownerLogin.token).ok, false, 'a duplicate credential is refused');

const doctorLogin = context.login(hashPin(doctorPin));
const receptionLogin = context.login(hashPin(receptionPin));
assert.equal(doctorLogin.staff.role, 'DOCTOR');
assert.equal(receptionLogin.staff.role, 'RECEPTION');

// Read-only, staff-session-gated daily summary. All records and dates here are synthetic.
{
  const requestSheet = sheets.get('Requests');
  const originalRows = requestSheet.rows;
  const today = dateParts(new Date(), 'Africa/Cairo');
  const todayISO = `${today.year}-${today.month}-${today.day}`;
  const tomorrow = new Date(`${todayISO}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const otherDay = tomorrow.toISOString().slice(0, 10);
  const row = (ref, status, name, date, time, eventId) => [ref, '2026-01-01', status, 'متابعة', name, '01000000000', date, time, eventId, '', true, true];
  requestSheet.rows = [originalRows[0],
    row('SUMMARY-1', 'CONFIRMED', 'ثانٍ', todayISO, '12:00', 'event-2'),
    row('SUMMARY-2', 'CONFIRMED', 'أول', todayISO, '09:00', 'event-1'),
    row('SUMMARY-3', 'PENDING_APPROVAL', 'معلق', todayISO, '08:00', ''),
    row('SUMMARY-4', 'COMPLETED', 'مكتمل', todayISO, '08:30', 'event-3'),
    row('SUMMARY-5', 'CONFIRMED', 'غدًا', otherDay, '07:00', 'event-4'),
    row('SUMMARY-6', 'CONFIRMED', 'دون حدث', todayISO, '13:00', ''),
    row('SUMMARY-DUP', 'CONFIRMED', 'قديم', todayISO, '10:00', 'event-old'),
    row('SUMMARY-DUP', 'CANCELLED', 'قديم', todayISO, '10:00', '')];
  const expiredToken = 'expired-session-fixture-123456789';
  properties.setProperty(`CK_SESSION_${expiredToken}`, JSON.stringify({ id: 'owner', role: 'CLINIC_ADMIN', exp: 1 }));
  function assertReadOnly(run) {
    const beforeSheets = JSON.stringify([...sheets.entries()].map(([name, sheet]) => [name, sheet.rows]));
    const beforeProps = JSON.stringify([...propertyValues.entries()]);
    const beforeEvents = JSON.stringify(calendar.events);
    let forbidden = 0;
    const old = { setValue: FakeRange.prototype.setValue, setValues: FakeRange.prototype.setValues, append: FakeSheet.prototype.appendRow,
      insert: spreadsheet.insertSheet, setProperty: properties.setProperty, deleteProperty: properties.deleteProperty, setProperties: properties.setProperties,
      defaultCalendar: context.CalendarApp.getDefaultCalendar, calendarById: context.CalendarApp.getCalendarById };
    const reject = () => { forbidden += 1; throw new Error('forbidden report write or Calendar access'); };
    FakeRange.prototype.setValue = reject; FakeRange.prototype.setValues = reject; FakeSheet.prototype.appendRow = reject;
    spreadsheet.insertSheet = reject; properties.setProperty = reject; properties.deleteProperty = reject; properties.setProperties = reject;
    context.CalendarApp.getDefaultCalendar = reject; context.CalendarApp.getCalendarById = reject;
    let result;
    try { result = run(); }
    finally {
      FakeRange.prototype.setValue = old.setValue; FakeRange.prototype.setValues = old.setValues; FakeSheet.prototype.appendRow = old.append;
      spreadsheet.insertSheet = old.insert; properties.setProperty = old.setProperty; properties.deleteProperty = old.deleteProperty; properties.setProperties = old.setProperties;
      context.CalendarApp.getDefaultCalendar = old.defaultCalendar; context.CalendarApp.getCalendarById = old.calendarById;
    }
    assert.equal(forbidden, 0, 'summary attempts no persistent write or Calendar access');
    assert.equal(JSON.stringify([...sheets.entries()].map(([name, sheet]) => [name, sheet.rows])), beforeSheets, 'summary leaves sheets unchanged');
    assert.equal(JSON.stringify([...propertyValues.entries()]), beforeProps, 'summary leaves properties unchanged');
    assert.equal(JSON.stringify(calendar.events), beforeEvents, 'summary leaves calendar unchanged');
    return result;
  }
  try {
    const summary = assertReadOnly(() => context.generateDailySummary(doctorLogin.token));
    assert.equal(summary.ok, true); assert.equal(summary.day, todayISO);
    assert.equal(JSON.stringify(summary.appointments.map((item) => item.guardianName)), JSON.stringify(['أول', 'ثانٍ']));
    assert.equal(summary.missingEventCount, 1, 'confirmed row without a calendar ID is flagged and excluded');
    assert.ok(!JSON.stringify(summary).includes('01000000000'), 'summary contains no phone numbers');
    const empty = context.buildDailySummary_([], todayISO);
    assert.equal(empty.ok, true); assert.equal(empty.appointments.length, 0); assert.equal(empty.missingEventCount, 0);
    assert.equal(assertReadOnly(() => context.generateDailySummary(receptionLogin.token)).ok, true);
    assert.equal(assertReadOnly(() => context.generateDailySummary(ownerHash)).ok, false, 'raw PIN digest is not a report session');
    assert.equal(assertReadOnly(() => context.generateDailySummary(expiredToken)).ok, false, 'expired session denied without deleting it');
    assert.equal(assertReadOnly(() => context.generateDailySummary('unknown-token-fixture-123456789')).ok, false);
    const boundaryRows = [row('MIDNIGHT', 'CONFIRMED', 'حد اليوم', new Date('2031-03-09T22:30:00Z'), '09:00', 'event')];
    const boundary = context.buildDailySummary_(boundaryRows, '2031-03-10');
    assert.equal(boundary.appointments.length, 1, 'date cell maps to Cairo, including UTC midnight boundary');
    assert.equal(context.buildDailySummary_([row('BAD', 'CONFIRMED', 'خطأ', '2031-02-30', '09:00', 'event')], todayISO).ok, false);
    assert.equal(context.buildDailySummary_([row('BAD', 'CONFIRMED', 'خطأ', todayISO, '99:00', 'event')], todayISO).ok, false);
    const originalLookup = spreadsheet.getSheetByName;
    try {
      spreadsheet.getSheetByName = function(name) { if (name === 'Requests') throw new Error('private exception marker'); return originalLookup.call(this, name); };
      const failed = assertReadOnly(() => context.generateDailySummary(doctorLogin.token));
      assert.equal(failed.code, 'SUMMARY_READ_FAILED'); assert.doesNotMatch(failed.message, /private exception marker/);
      spreadsheet.getSheetByName = function(name) { return name === 'Requests' ? null : originalLookup.call(this, name); };
      assert.equal(assertReadOnly(() => context.generateDailySummary(doctorLogin.token)).code, 'SUMMARY_SHEET_MISSING');
    } finally { spreadsheet.getSheetByName = originalLookup; }
    const originalHeader = requestSheet.rows[0];
    requestSheet.rows[0] = ['wrong-header'];
    context.sheetSchemaIndex_ = {}; // simulate a fresh Apps Script invocation
    assert.equal(assertReadOnly(() => context.generateDailySummary(doctorLogin.token)).code, 'SUMMARY_SCHEMA_DRIFT');
    requestSheet.rows[0] = originalHeader;
    context.sheetSchemaIndex_ = {};
    const staffSheet = sheets.get('Staff');
    sheets.delete('Staff');
    assert.equal(assertReadOnly(() => context.generateDailySummary(doctorLogin.token)).ok, false, 'missing staff sheet fails closed without creating it');
    sheets.set('Staff', staffSheet);
  } finally {
    requestSheet.rows = originalRows;
    properties.deleteProperty(`CK_SESSION_${expiredToken}`);
  }
  console.log('Daily summary simulated: staff sessions, Cairo date, ordering, missing events, failure visibility and read-only behavior.');
}

// the desk: sees the board and moves appointments, cannot approve a child or reconfigure
assert.equal(context.getDashboard(receptionLogin.token).ok, true, 'the desk reads the board');
assert.equal(context.approveRequest('ANY-REF', receptionLogin.token).ok, false, 'the desk cannot approve a child');
assert.equal(context.saveClinicSettings({ values: { CLINIC_TIMELINE: 'x' } }, receptionLogin.token).ok, false, 'the desk cannot change settings');
assert.equal(context.listStaff(receptionLogin.token).ok, false, 'the desk cannot manage staff');
assert.equal(context.getHealthReport(receptionLogin.token).ok, false, 'the desk cannot read the operational report');

// the doctor: approves, reads the published settings, does not own the configuration
assert.equal(context.getClinicSettings(doctorLogin.token).ok, true, 'the doctor reads the published settings');
assert.equal(context.saveClinicSettings({ values: { CLINIC_TIMELINE: 'x' } }, doctorLogin.token).ok, false, 'the doctor cannot rewrite clinic settings');
assert.equal(context.listStaff(doctorLogin.token).ok, false, 'the doctor cannot manage staff');

// the owner: the only role that reconfigures, and the audit says which row did it
assert.equal(context.saveClinicSettings({ values: { CLINIC_TIMELINE: 'عيادة دكتور مختار سيد كامل' } }, ownerLogin.token).ok, true, 'the owner saves settings');
const ownerAuditRow = sheets.get('Audit').rows.filter((row) => row[3] === 'SETTINGS_UPDATED').pop();
assert.equal(ownerAuditRow[1], 'staff:owner:CLINIC_ADMIN', 'the audit row names the staff id and role, not a shared label');

// fail closed: bad, missing and revoked credentials never degrade to "any staff member"
assert.equal(context.getDashboard('0123456789abcdef0123456789abcdef').ok, false, 'an unknown token is refused');
assert.equal(context.getDashboard('').ok, false, 'a missing credential is refused');
assert.equal(context.deactivateStaff('owner', ownerLogin.token).ok, false, 'the last active owner cannot be disabled');
const doctorId = doctorLogin.staff.id;
assert.equal(context.deactivateStaff(doctorId, ownerLogin.token).ok, true, 'an owner disables a staff member');
assert.equal(context.getDashboard(doctorLogin.token).ok, false, 'a disabled staff member loses the session already held');
assert.equal(context.generateDailySummary(doctorLogin.token).ok, false, 'disabled staff cannot read the daily summary');
assert.equal(context.login(hashPin(doctorPin)).ok, false, 'a disabled staff member cannot log in again');

// Disabling the seeded owner must also defeat the legacy ADMIN_PIN_HASH fallback.
const secondOwnerPin = rolesPin('second-owner');
assert.equal(context.addStaff('مدير ثانٍ', 'CLINIC_ADMIN', hashPin(secondOwnerPin), ownerLogin.token).ok, true);
const secondOwnerLogin = context.login(hashPin(secondOwnerPin));
assert.equal(secondOwnerLogin.ok, true);
assert.equal(context.deactivateStaff('owner', secondOwnerLogin.token).ok, true);
assert.equal(context.login(ownerHash).ok, false, 'a disabled owner cannot log in via the legacy property');
assert.equal(context.getDashboard(ownerHash).ok, false, 'a disabled owner cannot use the credential directly');
assert.equal(context.getDashboard(ownerLogin.token).ok, false, 'a disabled owner loses the existing session');
assert.equal(context.getDashboard(secondOwnerLogin.token).ok, true, 'the remaining active owner keeps access');
context.logout(ownerLogin.token);
assert.equal(context.listStaff(ownerLogin.token).ok, false, 'a logged-out token is dead');

console.log('Reminder: these mocked-service tests do not establish Google quotas, permissions, live deployment behavior, or legal readiness.');
