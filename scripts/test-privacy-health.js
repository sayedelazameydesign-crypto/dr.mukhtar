#!/usr/bin/env node
'use strict';

/**
 * Privacy, retention and health — the parts a guardian and a clinic owner rely on
 * when something has already gone wrong.
 *
 * Offline only: fake Sheets/Calendar/Cache. What is *proved* here:
 *   1. A reference number alone never reveals a request (the phone is the credential).
 *   2. "Delete my data" blanks the name and phone, keeps the administrative trail, and
 *      refuses while a live calendar event or a queued (un-synced) row still exists.
 *   3. Automatic retention defaults off; legacy enabled-path behavior is tested only in
 *      isolated mocks, not approved for deployment or real patient data.
 *   4. healthCheck_ answers honestly when a dependency is down, and its payload carries
 *      no name and no phone number.
 *
 * The suite fails (never skips) when a piece it depends on is missing.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

process.env.TZ = 'Africa/Cairo';

/* --------------------------------------------------------------- fake Google ---- */

class FakeRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) {
    Object.assign(this, { sheet, row, column, rowCount, columnCount });
  }
  getValues() {
    return Array.from({ length: this.rowCount }, (_, r) =>
      Array.from({ length: this.columnCount }, (_, c) =>
        this.sheet.rows[this.row - 1 + r]?.[this.column - 1 + c] ?? ''));
  }
  setValues(values) {
    values.forEach((row, offset) => {
      const target = this.row - 1 + offset;
      while (this.sheet.rows.length <= target) this.sheet.rows.push([]);
      this.sheet.rows[target] = [...row];
    });
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
  setValue(value) { this.setValues([[value]]); return this; }
  createTextFinder(value) {
    const range = this;
    return {
      matchEntireCell() { return this; },
      findNext() {
        for (let r = range.row - 1; r < range.row - 1 + range.rowCount; r += 1) {
          if (String(range.sheet.rows[r]?.[range.column - 1] ?? '') === String(value)) return { getRow: () => r + 1 };
        }
        return null;
      }
    };
  }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows[0]?.length || 1; }
  appendRow(row) { this.rows.push([...row]); return this; }
  getRange(row, column, rowCount = 1, columnCount = 1) { return new FakeRange(this, row, column, rowCount, columnCount); }
  getDataRange() { return new FakeRange(this, 1, 1, Math.max(this.rows.length, 1), 12); }
  setFrozenRows() { return this; }
}

class FakeEvent {
  constructor(id, start, end, description) { Object.assign(this, { id, start, end, description, deleted: false }); }
  getId() { return this.id; }
  getStartTime() { return this.start; }
  getEndTime() { return this.end; }
  getDescription() { return this.description; }
  setTime(start, end) { this.start = start; this.end = end; }
  deleteEvent() { this.deleted = true; }
}

class FakeCalendar {
  constructor() { this.events = []; this.sequence = 1; }
  getEvents(start, end) { return this.events.filter((event) => !event.deleted && event.start < end && event.end > start); }
  createEvent(title, start, end, options) {
    const event = new FakeEvent(`evt-${this.sequence++}`, start, end, options?.description || '');
    this.events.push(event);
    return event;
  }
  getEventById(id) { return this.events.find((event) => event.id === id && !event.deleted) || null; }
}

const pin = `suite-${crypto.randomBytes(9).toString('hex')}`;
const pinHash = crypto.createHash('sha256').update(pin).digest('hex');
const properties = new Map([
  ['CELIA_SHEET_ID', 'fake-sheet'], ['CALENDAR_ID', 'primary'],
  ['ADMIN_PIN_HASH', pinHash], ['TIMEZONE', 'Africa/Cairo'],
  // The old enabled path is exercised in mocks only; production defaults to off.
  ['RETENTION', 'on'],
  ['WORK_START', '09:00'], ['WORK_END', '14:00'], ['SLOT_MINUTES', '30'],
  ['WORK_DAYS', '0,1,2,3,4']
]);
const sheets = new Map();
const calendar = new FakeCalendar();
let sheetsUp = true;
const spreadsheet = {
  getSheetByName(name) { if (!sheetsUp) throw new Error('simulated Sheets outage'); return sheets.get(name) || null; },
  insertSheet(name) { const sheet = new FakeSheet(name); sheets.set(name, sheet); return sheet; }
};
const propsApi = {
  getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
  setProperty: (key, value) => { properties.set(key, String(value)); return propsApi; },
  deleteProperty: (key) => { properties.delete(key); return propsApi; },
  getProperties: () => Object.fromEntries(properties)
};
const parts = (date, zone) => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));

let uuid = 1;
const context = {
  console: { log() {}, warn() {}, error() {}, info() {} },
  PropertiesService: { getScriptProperties: () => propsApi },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  SpreadsheetApp: {
    openById() { if (!sheetsUp) throw new Error('simulated Sheets outage'); return spreadsheet; },
    getActiveSpreadsheet() { return spreadsheet; }
  },
  CalendarApp: { getDefaultCalendar: () => calendar, getCalendarById: () => calendar },
  Session: { getScriptTimeZone: () => 'Africa/Cairo', getActiveUser: () => ({ getEmail: () => '' }) },
  CacheService: {
    getScriptCache: () => {
      const store = new Map();
      return { get: (k) => (store.has(k) ? store.get(k) : null), put: (k, v) => store.set(k, v), remove: (k) => store.delete(k), removeAll: (keys) => (keys || []).forEach((k) => store.delete(k)) };
    }
  },
  Utilities: {
    computeDigest: (algorithm, text) => Array.from(crypto.createHash('sha256').update(String(text), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    getUuid: () => `00000000-0000-4000-8000-${String(uuid++).padStart(12, '0')}`,
    formatDate(date, zone, pattern) {
      const p = parts(date, zone);
      if (pattern === 'yyyy-MM-dd') return `${p.year}-${p.month}-${p.day}`;
      if (pattern === 'yyyy-MM-dd HH:mm') return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      throw new Error(`unsupported pattern ${pattern}`);
    }
  },
  UrlFetchApp: { fetch() { throw new Error('no network in this suite'); } },
  ContentService: {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({ text, setMimeType() { return this; } })
  }
};
vm.createContext(context);
['Code.gs', 'Staff.gs', 'Settings.gs', 'Llm.gs', 'WhatsApp.gs'].forEach((file) => {
  assert.ok(fs.existsSync(file), `${file} must exist at the repository root`);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
});

/* ------------------------------------------------------------------- helpers ---- */

// `const` declarations in a vm script stay lexical: unlike function declarations they do
// not become properties of the context object, so the shared constants are read once.
const CK = vm.runInContext('CK', context);
const CATALOG = vm.runInContext('CK_SETTINGS_CATALOG', context);

let failures = 0;
const pass = [];
function check(label, fn) {
  try { fn(); pass.push(label); }
  catch (error) { failures += 1; console.error(` ✗ ${label} — ${error.message}`); }
}

function seedSheets() {
  sheets.clear();
  const requests = new FakeSheet('Requests');
  requests.rows.push([...CK.REQUEST_HEADERS]);
  sheets.set('Requests', requests);
  const audit = new FakeSheet('Audit');
  audit.rows.push([...CK.AUDIT_HEADERS]);
  sheets.set('Audit', audit);
  const closures = new FakeSheet('Closures');
  closures.rows.push([...CK.CLOSURE_HEADERS]);
  sheets.set('Closures', closures);
  return { requests, audit };
}

const day = '2031-03-10'; // a Monday
function row(overrides) {
  const base = {
    reference: 'CK-TEST0001', createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL',
    visitType: 'كشف جديد', guardianName: 'ولي أمر تجريبي', phone: '01000000001',
    day, time: '10:00', eventId: '', updatedAt: new Date().toISOString(), consent: true, slotVerified: true
  };
  return context.requestToRow_(Object.assign(base, overrides));
}
function appendRow(overrides) {
  const { requests } = seedSheetsIfNeeded();
  requests.appendRow(row(overrides));
  return (overrides || {}).reference || 'CK-TEST0001';
}
let seeded = null;
function seedSheetsIfNeeded() {
  if (!seeded) seeded = seedSheets();
  return seeded;
}
function auditRows() { return sheets.get('Audit').rows.slice(1); }
function findRow(reference) {
  return sheets.get('Requests').rows.find((r) => String(r[0]) === reference) || null;
}

/* ------------------------------------------------------- 1. the notice itself ---- */

check('the privacy notice states the configured retention window', () => {
  seedSheetsIfNeeded();
  const notice = context.getPrivacyNotice();
  assert.equal(notice.ok, true);
  assert.equal(notice.retentionMonths, 12, 'default retention is 12 months');
  properties.set('RETENTION_MONTHS', '24');
  assert.equal(context.getPrivacyNotice().retentionMonths, 24, 'the notice follows the setting');
  properties.delete('RETENTION_MONTHS');
});

check('an out-of-range retention value never becomes policy', () => {
  ['0', '-3', '999', 'twelve'].forEach((value) => {
    properties.set('RETENTION_MONTHS', value);
    assert.equal(context.readRetentionMonths_(propsApi), 12, `${value} must fall back to 12`);
  });
  properties.delete('RETENTION_MONTHS');
});

check('no published phone means no promised deletion channel', () => {
  // The arrays come from the vm realm, so compare values rather than prototypes.
  assert.equal(context.getPrivacyNotice().deletionChannels.length, 0);
  properties.set('CLINIC_PHONE', '0233334444');
  assert.equal(context.getPrivacyNotice().deletionChannels.join(','), 'phone');
  properties.delete('CLINIC_PHONE');
});

check('the notice carries no secret and no phone-shaped value', () => {
  const serialised = JSON.stringify(context.getPrivacyNotice());
  assert.ok(!/ADMIN_PIN|CALENDAR_ID|SHEET_ID/.test(serialised));
  assert.ok(!/01\d{9}/.test(serialised), 'no phone number leaks into the public notice');
});

/* -------------------------------------------------- 2. reference is not identity -- */

check('a reference alone does not reveal a request', () => {
  seedSheets();
  seeded = null; appendRow({ reference: 'CK-OWN00001' });
  assert.equal(context.lookupOwnRequest('CK-OWN00001', '').ok, false);
  const wrong = context.lookupOwnRequest('CK-OWN00001', '01099999999');
  assert.equal(wrong.ok, false, 'the wrong phone is refused');
  assert.match(wrong.message, /لا يوجد طلب مطابق/);
  const right = context.lookupOwnRequest('CK-OWN00001', '01000000001');
  assert.equal(right.ok, true);
  assert.equal(right.booking.status, 'PENDING_APPROVAL');
  assert.equal(right.booking.phone, undefined, 'the guardian view never echoes the stored phone');
});

check('a deleted row cannot be claimed a second time', () => {
  seedSheets();
  seeded = null; appendRow({ reference: 'CK-GONE0001', status: 'DELETED', guardianName: '', phone: '' });
  assert.equal(context.lookupOwnRequest('CK-GONE0001', '01000000001').ok, false);
});

/* ---------------------------------------------------------------- 3. deletion ---- */

check('deletion blanks name and phone but keeps the administrative trail', () => {
  seedSheets();
  seeded = null;
  appendRow({ reference: 'CK-DEL00001', status: 'CANCELLED' });
  const result = context.deleteOwnRequestData('CK-DEL00001', '01000000001', 'طلب ولي الأمر');
  assert.equal(result.ok, true, result.message);
  const stored = findRow('CK-DEL00001');
  assert.equal(stored[3 + 1], '', 'guardian name is erased');
  assert.equal(stored[5], '', 'phone is erased');
  assert.equal(stored[2], 'DELETED', 'status records that the data was deleted');
  assert.equal(stored[0], 'CK-DEL00001', 'the reference survives');
  const audit = auditRows().find((r) => r[3] === 'GUARDIAN_DATA_DELETED');
  assert.ok(audit, 'the deletion is audited');
  assert.equal(audit[1], 'guardian', 'the actor is recorded as the guardian, not staff');
});

check('deletion needs the phone, and refuses the wrong one', () => {
  seedSheets();
  seeded = null; appendRow({ reference: 'CK-DEL00002', status: 'CANCELLED' });
  assert.equal(context.deleteOwnRequestData('CK-DEL00002', '', '').ok, false);
  assert.equal(context.deleteOwnRequestData('CK-DEL00002', '01555555555', '').ok, false);
  assert.equal(findRow('CK-DEL00002')[5], '01000000001', 'the row is untouched after a refused attempt');
});

check('a live calendar appointment blocks deletion until it is cancelled', () => {
  seedSheets();
  seeded = null;
  appendRow({ reference: 'CK-LIVE0001', status: 'CONFIRMED' });
  calendar.events.length = 0;
  const start = context.makeDate_(day, '10:00');
  calendar.createEvent('visit', start, new Date(start.getTime() + 60 * 60000), { description: 'مرجع إداري: CK-LIVE0001' });
  const refused = context.deleteOwnRequestData('CK-LIVE0001', '01000000001', '');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /تقويم العيادة/);
  assert.equal(findRow('CK-LIVE0001')[5], '01000000001', 'nothing erased while the appointment exists');
  calendar.events[0].deleteEvent();
  const allowed = context.deleteOwnRequestData('CK-LIVE0001', '01000000001', '');
  assert.equal(allowed.ok, true, allowed.message);
});

check('a request stranded in the outage queue is never edited from the public app', () => {
  seedSheets();
  seeded = null;
  const queued = {
    reference: 'CK-QUE00001', createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL',
    visitType: 'كشف جديد', guardianName: 'ولي أمر', phone: '01000000001', day, time: '09:00',
    eventId: '', updatedAt: new Date().toISOString(), consent: true, slotVerified: true
  };
  const key = CK.QUEUE_PREFIX + queued.reference;
  properties.set(key, JSON.stringify(queued));
  const refused = context.deleteOwnRequestData('CK-QUE00001', '01000000001', '');
  assert.equal(refused.ok, false);
  assert.match(refused.message, /محفوظ مؤقتًا/);
  assert.equal(JSON.parse(properties.get(key)).phone, '01000000001', 'the queued row is untouched');
  assert.equal(JSON.parse(properties.get(key)).guardianName, 'ولي أمر');
  properties.delete(key);
});

check('a deleted reference is reported as deleted when tracking', () => {
  seedSheets();
  seeded = null; appendRow({ reference: 'CK-TRK00001', status: 'DELETED' });
  const tracked = context.lookupBooking('CK-TRK00001');
  assert.equal(tracked.ok, false);
  assert.equal(tracked.deleted, true);
  assert.match(tracked.message, /حُذفت بيانات/);
});

/* --------------------------------------------------------------- 4. retention ---- */

check('retention defaults off and dashboard warns without erasing contact data', () => {
  seedSheets(); seeded = null;
  const old = new Date(); old.setMonth(old.getMonth() - 30);
  appendRow({ reference: 'CK-OFF00001', status: 'CANCELLED', createdAt: old.toISOString() });
  properties.delete('CK_LAST_PURGE');
  try {
    for (const value of [null, '', 'off', 'ON', 'true']) {
      if (value === null) properties.delete('RETENTION'); else properties.set('RETENTION', value);
      const before = JSON.stringify([...sheets.values()].map((sheet) => sheet.rows));
      const result = context.purgeExpiredRequests_();
      assert.equal(result.reason, 'disabled');
      assert.equal(result.purged, 0);
      assert.equal(JSON.stringify([...sheets.values()].map((sheet) => sheet.rows)), before);
      assert.equal(properties.has('CK_LAST_PURGE'), false, 'the stop does not mark a purge as run');
    }
    const dashboard = context.getDashboard(pinHash);
    assert.equal(dashboard.ok, true);
    assert.ok(dashboard.warnings.some((w) => /المحو التلقائي.*متوقف/.test(w)));
    assert.equal(findRow('CK-OFF00001')[5], '01000000001');
    assert.equal(context.healthCheck_().checks.find((item) => item.id === 'retention').ok, false);
  } finally { properties.set('RETENTION', 'on'); }
});

check('retention trims old settled rows and leaves everything else alone', () => {
  seedSheets();
  seeded = null;
  const old = new Date();
  old.setMonth(old.getMonth() - 18);
  appendRow({ reference: 'CK-OLD00001', status: 'CANCELLED', createdAt: old.toISOString() });
  appendRow({ reference: 'CK-OLD00002', status: 'CONFIRMED', createdAt: old.toISOString() });
  appendRow({ reference: 'CK-NEW00001', status: 'CANCELLED', createdAt: new Date().toISOString() });
  calendar.events.length = 0;
  const result = context.purgeExpiredRequests_();
  assert.equal(result.failed, 0);
  assert.equal(result.purged, 1, 'only the old cancelled row is purged');
  assert.equal(findRow('CK-OLD00001')[5], '', 'old settled row lost its phone');
  assert.equal(findRow('CK-OLD00001')[2], 'DELETED');
  assert.equal(findRow('CK-OLD00002')[5], '01000000001', 'a confirmed visit keeps its data');
  assert.equal(findRow('CK-NEW00001')[5], '01000000001', 'a recent request keeps its data');
  assert.ok(auditRows().some((r) => r[3] === 'RETENTION_PURGE'), 'the purge is audited');
});

check('retention respects the retention window and its own throttle', () => {
  seedSheets();
  seeded = null;
  const nineMonthsAgo = new Date();
  nineMonthsAgo.setMonth(nineMonthsAgo.getMonth() - 9);
  appendRow({ reference: 'CK-OLD00003', status: 'COMPLETED', createdAt: nineMonthsAgo.toISOString() });
  properties.set('RETENTION_MONTHS', '24');
  properties.delete('CK_LAST_PURGE');
  assert.equal(context.purgeExpiredRequests_().purged, 0, '9 months is inside a 24-month window');
  properties.set('RETENTION_MONTHS', '6');
  properties.delete('CK_LAST_PURGE');
  calendar.events.length = 0;
  assert.equal(context.purgeExpiredRequests_().purged, 1, '6 months reaches it');
  const again = context.purgeExpiredRequests_();
  assert.equal(again.skipped, true, 'a second run inside 22 hours does nothing');
  assert.equal(again.purged, 0);
  properties.delete('RETENTION_MONTHS');
  properties.delete('CK_LAST_PURGE');
});

/* ------------------------------------------------------------------ 5. health ---- */

check('health flags the unsafe legacy retention path and carries no personal data', () => {
  seedSheets();
  seeded = null; appendRow({ reference: 'CK-HLT00001' });
  properties.delete('CK_MUST_CHANGE_PIN');
  const report = context.healthCheck_();
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((c) => c.id === 'retention').ok, false, 'the flag does not certify the old purge as safe');
  assert.equal(report.counters.requests, 1);
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes('01000000001'), 'no phone number in the health payload');
  assert.ok(!serialised.includes('ولي أمر تجريبي'), 'no guardian name in the health payload');
  assert.ok(!/CK-HLT00001/.test(serialised), 'no reference numbers in the health payload');
});

check('health turns red when the request sheet is unreachable', () => {
  seedSheetsIfNeeded();
  sheetsUp = false;
  const report = context.healthCheck_();
  sheetsUp = true;
  assert.equal(report.ok, false);
  const sheet = report.checks.find((c) => c.id === 'sheets');
  assert.equal(sheet.ok, false, 'the Sheets failure is reported, not swallowed');
});

check('health hides raw config, Sheets and Calendar error text from all report surfaces', () => {
  seedSheetsIfNeeded();
  const originals = [context.getConfig_, context.getSpreadsheet_, context.getCalendar_, context.requirePermission_];
  const marker = 'private-marker-' + crypto.randomBytes(6).toString('hex');
  const healthToken = ['health', 'fixture', crypto.randomBytes(6).toString('hex')].join('-');
  try {
    context.getConfig_ = () => { throw new Error(marker); };
    context.getSpreadsheet_ = () => { throw new Error(marker); };
    context.getCalendar_ = () => { throw new Error(marker); };
    // Isolate report rendering; permission checks are covered separately below.
    context.requirePermission_ = () => ({ ok: true });
    properties.set('HEALTH_TOKEN', healthToken);
    const report = context.healthCheck_();
    for (const id of ['config', 'sheets', 'calendar']) {
      assert.equal(report.checks.find((item) => item.id === id).ok, false, `${id} stays red`);
    }
    assert.equal(report.status, 'down');
    const staff = context.getHealthReport(pinHash);
    const helper = context.doGetHealth({ parameter: { token: healthToken } });
    assert.equal(staff.ok, true, 'staff still receive the red report');
    assert.equal(JSON.parse(helper.text).status, 'down');
    for (const result of [report, staff, helper]) {
      assert.ok(!JSON.stringify(result).includes(marker), 'raw exception text is not exposed');
    }
  } finally {
    [context.getConfig_, context.getSpreadsheet_, context.getCalendar_, context.requirePermission_] = originals;
    properties.delete('HEALTH_TOKEN');
  }
});

check('health names the expected sheet on drift without echoing an exception field', () => {
  const original = context.getSpreadsheet_;
  const marker = 'private-marker-' + crypto.randomBytes(6).toString('hex');
  try {
    context.getSpreadsheet_ = () => { throw Object.assign(new Error(marker), { code: 'SCHEMA_DRIFT', sheet: marker }); };
    const report = context.healthCheck_();
    assert.equal(report.status, 'drift');
    assert.match(report.checks.find((item) => item.id === 'sheets').detail, /Requests.*schema_drift/);
    assert.ok(!JSON.stringify(report).includes(marker));
  } finally { context.getSpreadsheet_ = original; }
});

check('schema drift does not leak a sensitive header through errors or logs', () => {
  seedSheets(); seeded = null;
  const requests = sheets.get('Requests');
  const originalLog = context.logEvent_;
  const marker = 'private-marker-' + crypto.randomBytes(6).toString('hex');
  const events = [];
  try {
    requests.rows[0][0] = marker;
    context.sheetSchemaIndex_ = {};
    context.logEvent_ = (...args) => events.push(args);
    let message = '';
    try { context.assertSheetSchema_(requests, CK.REQUEST_HEADERS, CK.REQUESTS); }
    catch (error) { message = error.message; }
    assert.match(message, /Requests/);
    assert.ok(!JSON.stringify([message, events]).includes(marker));
    const report = context.healthCheck_();
    assert.equal(report.status, 'drift');
    assert.ok(!JSON.stringify([report, events]).includes(marker));
  } finally {
    context.logEvent_ = originalLog;
    requests.rows[0][0] = CK.REQUEST_HEADERS[0];
    context.sheetSchemaIndex_ = {};
  }
});

check('health report failure logs and messages never echo exception fields', () => {
  const originals = [context.healthCheck_, context.requirePermission_, context.logEvent_];
  const marker = 'private-marker-' + crypto.randomBytes(6).toString('hex');
  const entries = [];
  try {
    context.requirePermission_ = () => ({ ok: true });
    context.healthCheck_ = () => { throw Object.assign(new Error(marker), { code: 'SCHEMA_DRIFT', sheet: marker }); };
    context.logEvent_ = (...args) => entries.push(args);
    const report = context.getHealthReport(pinHash);
    assert.equal(report.ok, false);
    assert.equal(entries[0][2].code, 'SCHEMA_DRIFT');
    assert.ok(!JSON.stringify([report, entries]).includes(marker));
  } finally { [context.healthCheck_, context.requirePermission_, context.logEvent_] = originals; }
});

check('doGet exposes only a static liveness probe, not a health report', () => {
  const originals = [context.HtmlService, context.healthCheck_, context.PropertiesService];
  const html = { setTitle() { return this; }, setXFrameOptionsMode() { return this; } };
  try {
    context.HtmlService = { createHtmlOutputFromFile: () => html, XFrameOptionsMode: { ALLOWALL: 'allow' } };
    context.healthCheck_ = () => { throw new Error('health must not be called'); };
    context.PropertiesService = { getScriptProperties: () => { throw new Error('properties must not be read'); } };
    const probe = context.doGet({ parameter: { health: 'liveness', token: 'ignored' } });
    assert.deepEqual(JSON.parse(probe.text), { status: 'alive' });
    assert.equal(context.doGet({ parameter: { health: '1' } }), html, 'other requests keep the normal site');
    assert.equal(context.doGet(), html, 'ordinary doGet still serves the site');
  } finally { [context.HtmlService, context.healthCheck_, context.PropertiesService] = originals; }
});

// The evaluation is deliberately disconnected: it does not poll, alert or mutate data.
function snapshotFixture() {
  return {
    started: '2030-01-01T00:00:00.000Z', ok: true, status: 'ok',
    checks: ['config', 'sheets', 'calendar', 'queues', 'staff_pin', 'retention', 'last_purge']
      .map((id) => ({ id, ok: true, detail: 'private-fixture-marker' }))
  };
}
const snapshotStart = Date.parse('2030-01-01T00:00:00.000Z');

check('snapshot evaluator classifies only the existing checks, with no raw detail', () => {
  const report = snapshotFixture();
  const result = context.evaluateHealthSnapshot_(report, snapshotStart + 1000, 1000);
  assert.equal(result.state, 'checks-passed');
  assert.equal(result.reason, 'reported-ok');
  assert.equal(result.failedChecks.length, 0);
  assert.ok(!JSON.stringify(result).includes('private-fixture-marker'));
  assert.equal(report.checks[0].detail, 'private-fixture-marker', 'input is not modified');
});

check('snapshot evaluator preserves explicit failures and schema drift', () => {
  const report = snapshotFixture();
  report.ok = false; report.status = 'down';
  report.checks.find((c) => c.id === 'calendar').ok = false;
  const failure = context.evaluateHealthSnapshot_(report, snapshotStart, 1000);
  assert.equal(failure.state, 'checks-failed');
  assert.equal(failure.reason, 'reported-failure');
  assert.equal(failure.failedChecks.join(','), 'calendar');
  report.status = 'drift';
  report.checks.find((c) => c.id === 'sheets').ok = false;
  const drift = context.evaluateHealthSnapshot_(report, snapshotStart, 1000);
  assert.equal(drift.state, 'checks-failed');
  assert.equal(drift.reason, 'schema-drift');
  assert.equal(drift.failedChecks.join(','), 'sheets,calendar');
  assert.ok(!JSON.stringify(drift).includes('private-fixture-marker'));
});

check('snapshot evaluator treats stale and future data as unknown, never healthy', () => {
  const report = snapshotFixture();
  assert.equal(context.evaluateHealthSnapshot_(report, snapshotStart + 1001, 1000).reason, 'stale-report');
  assert.equal(context.evaluateHealthSnapshot_(report, snapshotStart - 1, 1000).reason, 'future-report');
  report.ok = false; report.status = 'down'; report.checks[0].ok = false;
  assert.equal(context.evaluateHealthSnapshot_(report, snapshotStart + 1001, 1000).state, 'unknown');
});

check('snapshot evaluator rejects invalid clocks, dates, and incomplete or contradictory reports', () => {
  for (const [now, max] of [[NaN, 1], [Infinity, 1], [snapshotStart, 0], [snapshotStart, -1], [snapshotStart, 1.5]]) {
    assert.equal(context.evaluateHealthSnapshot_(snapshotFixture(), now, max).state, 'unknown');
  }
  const cases = [null, {}, { ...snapshotFixture(), started: '2030-02-30T00:00:00.000Z' },
    { ...snapshotFixture(), checks: [] },
    { ...snapshotFixture(), checks: snapshotFixture().checks.map((c) => ({ ...c, id: 'config' })) },
    { ...snapshotFixture(), status: 'down' },
    { ...snapshotFixture(), ok: false, status: 'drift' },
    { ...snapshotFixture(), ok: false, status: 'closed' }];
  for (const report of cases) assert.equal(context.evaluateHealthSnapshot_(report, snapshotStart, 1000).state, 'unknown');
  const badBoolean = snapshotFixture(); badBoolean.checks[0].ok = 'true';
  assert.equal(context.evaluateHealthSnapshot_(badBoolean, snapshotStart, 1000).state, 'unknown');
  const contradictory = snapshotFixture(); contradictory.checks[0].ok = false;
  assert.equal(context.evaluateHealthSnapshot_(contradictory, snapshotStart, 1000).reason, 'inconsistent-report');
  // The staff envelope says its call ran; it is not itself a health report.
  assert.equal(context.evaluateHealthSnapshot_({ ok: true, report: snapshotFixture() }, snapshotStart, 1000).state, 'unknown');
});

check('snapshot evaluator never touches services, network, settings or logs', () => {
  const originals = [context.PropertiesService, context.CalendarApp, context.SpreadsheetApp, context.UrlFetchApp, context.logEvent_];
  const forbidden = () => { throw new Error('service access forbidden'); };
  try {
    context.PropertiesService = { getScriptProperties: forbidden };
    context.CalendarApp = { getDefaultCalendar: forbidden, getCalendarById: forbidden };
    context.SpreadsheetApp = { openById: forbidden, getActiveSpreadsheet: forbidden };
    context.UrlFetchApp = { fetch: forbidden };
    context.logEvent_ = forbidden;
    assert.equal(context.evaluateHealthSnapshot_(snapshotFixture(), snapshotStart, 1000).state, 'checks-passed');
    assert.equal(context.evaluateHealthSnapshot_({}, snapshotStart, 1000).state, 'unknown');
  } finally {
    [context.PropertiesService, context.CalendarApp, context.SpreadsheetApp, context.UrlFetchApp, context.logEvent_] = originals;
  }
});

check('snapshot evaluator agrees with actual mocked healthCheck_ reports', () => {
  seedSheetsIfNeeded();
  properties.delete('CK_MUST_CHANGE_PIN');
  const report = context.healthCheck_();
  const now = Date.parse(report.started);
  assert.equal(context.evaluateHealthSnapshot_(report, now, 1000).state, report.ok ? 'checks-passed' : 'checks-failed');
});

check('one monitoring pass writes only fixed codes to a preconfigured sheet', () => {
  const originals = [context.healthCheck_, context.logEvent_, context.MailApp, context.ScriptApp];
  const oldSheet = sheets.get('Monitoring');
  const monitor = new FakeSheet('Monitoring');
  monitor.rows.push(['checkedAt', 'state', 'reason', 'failedChecks']);
  const events = [];
  try {
    sheets.set('Monitoring', monitor);
    const report = snapshotFixture(); report.started = new Date().toISOString();
    report.ok = false; report.status = 'down'; report.checks.find((c) => c.id === 'calendar').ok = false;
    context.healthCheck_ = () => report;
    context.logEvent_ = (...args) => events.push(args);
    context.MailApp = { sendEmail() { throw new Error('mail must not be sent'); } };
    context.ScriptApp = { newTrigger() { throw new Error('no trigger should be created'); } };
    const result = context.runHealthMonitorOnce_(60000);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'checks-failed');
    assert.equal(monitor.rows.length, 2);
    assert.equal(monitor.rows[1][1], 'checks-failed');
    assert.equal(monitor.rows[1][3], 'calendar');
    assert.ok(!JSON.stringify([result, monitor.rows, events]).includes('private-fixture-marker'));
  } finally {
    [context.healthCheck_, context.logEvent_, context.MailApp, context.ScriptApp] = originals;
    if (oldSheet) sheets.set('Monitoring', oldSheet); else sheets.delete('Monitoring');
  }
});

check('monitor records an unknown status when health throws without leaking the error', () => {
  const originals = [context.healthCheck_, context.logEvent_];
  const oldSheet = sheets.get('Monitoring');
  const monitor = new FakeSheet('Monitoring');
  const marker = 'private-marker-' + crypto.randomBytes(6).toString('hex');
  const events = [];
  monitor.rows.push(['checkedAt', 'state', 'reason', 'failedChecks']);
  try {
    sheets.set('Monitoring', monitor);
    context.healthCheck_ = () => { throw new Error(marker); };
    context.logEvent_ = (...args) => events.push(args);
    const result = context.runHealthMonitorOnce_(60000);
    assert.equal(result.ok, true);
    assert.equal(result.state, 'unknown');
    assert.equal(monitor.rows[1][2], 'health-check-error');
    assert.ok(!JSON.stringify([result, monitor.rows, events]).includes(marker));
  } finally {
    [context.healthCheck_, context.logEvent_] = originals;
    if (oldSheet) sheets.set('Monitoring', oldSheet); else sheets.delete('Monitoring');
  }
});

check('monitor refuses absent, malformed or unwritable sheets without repairing them', () => {
  const originals = [context.healthCheck_, context.logEvent_];
  const oldSheet = sheets.get('Monitoring');
  const events = [];
  try {
    const report = snapshotFixture(); report.started = new Date().toISOString();
    context.healthCheck_ = () => report;
    context.logEvent_ = (...args) => events.push(args);
    sheets.delete('Monitoring');
    assert.equal(context.runHealthMonitorOnce_(60000).code, 'MONITOR_WRITE_FAILED');
    assert.equal(sheets.has('Monitoring'), false);
    const monitor = new FakeSheet('Monitoring'); monitor.rows.push(['wrong', 'state', 'reason', 'failedChecks']);
    sheets.set('Monitoring', monitor);
    assert.equal(context.runHealthMonitorOnce_(60000).code, 'MONITOR_WRITE_FAILED');
    assert.equal(monitor.rows.length, 1);
    monitor.rows[0][0] = 'checkedAt';
    monitor.appendRow = () => { throw new Error('private-fixture-marker'); };
    assert.equal(context.runHealthMonitorOnce_(60000).code, 'MONITOR_WRITE_FAILED');
    assert.ok(!JSON.stringify(events).includes('private-fixture-marker'));
    assert.equal(context.runHealthMonitorOnce_(0).code, 'INVALID_MONITOR_LIMIT');
  } finally {
    [context.healthCheck_, context.logEvent_] = originals;
    if (oldSheet) sheets.set('Monitoring', oldSheet); else sheets.delete('Monitoring');
  }
});

check('monitor skips busy locks and reports release failure without raw errors', () => {
  const originals = [context.LockService, context.healthCheck_, context.logEvent_];
  try {
    context.logEvent_ = () => {};
    context.healthCheck_ = () => { throw new Error('simulated health failure'); };
    context.LockService = { getScriptLock: () => ({ tryLock: () => false }) };
    assert.equal(context.runHealthMonitorOnce_(1000).code, 'LOCK_BUSY');
    context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { throw new Error('private-fixture-marker'); } }) };
    assert.throws(() => context.runHealthMonitorOnce_(1000), (error) => error.message === 'MONITOR_LOCK_RELEASE_FAILED');
  } finally { [context.LockService, context.healthCheck_, context.logEvent_] = originals; }
});

check('health reports a temporary staff PIN as not ready', () => {
  properties.set('CK_MUST_CHANGE_PIN', '1');
  const report = context.healthCheck_();
  assert.equal(report.checks.find((c) => c.id === 'staff_pin').ok, false);
  properties.delete('CK_MUST_CHANGE_PIN');
});

check('health counts the outage queues and flags a full one', () => {
  seedSheetsIfNeeded();
  const queued = [];
  for (let i = 0; i < CK.MAX_OUTAGE_REQUESTS; i += 1) {
    const key = `${CK.QUEUE_PREFIX}CK-FAKE${String(i).padStart(4, '0')}`;
    properties.set(key, JSON.stringify({ reference: `CK-FAKE${i}`, phone: '', guardianName: '', status: 'REQUESTED' }));
    queued.push(key);
  }
  const report = context.healthCheck_();
  const queue = report.checks.find((c) => c.id === 'queues');
  assert.equal(queue.ok, false, 'a full request queue is not healthy');
  assert.equal(report.counters.queued_requests, CK.MAX_OUTAGE_REQUESTS);
  queued.forEach((key) => properties.delete(key));
});

check('the staff health endpoint refuses a bad PIN', () => {
  assert.equal(context.getHealthReport('not-the-pin').ok, false);
  assert.equal(context.getHealthReport(pinHash).ok, true);
});

check('the public uptime endpoint stays closed until a token is configured', () => {
  properties.delete('HEALTH_TOKEN');
  const closed = context.doGetHealth({ parameter: { token: 'anything' } });
  assert.equal(JSON.parse(closed.text).ok, false, 'no token configured means no public data');
  // Assembled at runtime on purpose: the secret scanner (correctly) refuses a literal
  // `token: "…"` assignment anywhere in the repository, even in a test fixture.
  const healthToken = ['uptime', 'probe', crypto.randomBytes(6).toString('hex')].join('-');
  properties.set('HEALTH_TOKEN', healthToken);
  const wrong = context.doGetHealth({ parameter: { token: 'guess' } });
  assert.equal(JSON.parse(wrong.text).ok, false);
  const right = context.doGetHealth({ parameter: { token: healthToken } });
  const payload = JSON.parse(right.text);
  assert.equal(typeof payload.ok, 'boolean');
  assert.ok(Array.isArray(payload.checks));
  properties.delete('HEALTH_TOKEN');
});

/**
 * The secret comparison must reject a prefix.
 *
 * The original loop iterated over the length of the CANDIDATE only, so a correct prefix of
 * the stored secret compared equal. That is silent: nothing printed, nothing failed. It
 * mattered twice — the staff PIN is compared as a 64-character digest (so a prefix of the
 * digest was accepted), and HEALTH_TOKEN is compared to whatever the caller sent.
 */
check('a prefix of the secret is not accepted', () => {
  // Assembled at runtime: a literal of this shape trips the secret scanner, and a test
  // fixture should never look like a credential.
  const secret = ['prefix', 'fixture', crypto.randomBytes(8).toString('hex')].join('-');
  assert.equal(context.constantTimeEquals_(secret, secret), true, 'the exact secret is accepted');
  assert.equal(context.constantTimeEquals_(secret.slice(0, 12), secret), false, 'a prefix is not the secret');
  assert.equal(context.constantTimeEquals_(secret + 'x', secret), false, 'a longer value is not the secret');
  assert.equal(context.constantTimeEquals_('', secret), false, 'empty is not the secret');
});

check('a prefix of the health token does not open the uptime endpoint', () => {
  const healthToken = ['prefix', 'probe', crypto.randomBytes(6).toString('hex')].join('-');
  properties.set('HEALTH_TOKEN', healthToken);
  const prefixed = context.doGetHealth({ parameter: { token: healthToken.slice(0, 9) } });
  assert.equal(JSON.parse(prefixed.text).ok, false, 'a prefix must not unlock the counters');
  properties.delete('HEALTH_TOKEN');
});

check('a prefix of the staff PIN digest does not unlock the dashboard', () => {
  const gateHash = context.constantTimeEquals_ ? null : null;
  void gateHash;
  const digest = crypto.createHash('sha256').update('a-long-enough-staff-pin-2026').digest('hex');
  const saved = { hash: properties.get('ADMIN_PIN_HASH'), pin: properties.get('ADMIN_PIN') };
  properties.set('ADMIN_PIN_HASH', digest);
  properties.delete('ADMIN_PIN');
  properties.delete('CK_PIN_FAILURES');
  properties.delete('CK_PIN_LOCKED');
  try {
    assert.equal(context.verifyStaffPin_(digest.slice(0, 32)), false, 'half a digest is not the digest');
    assert.equal(context.verifyStaffPin_(digest), true, 'the whole digest still works');
  } finally {
    // The suite shares one property store: restore it, or every later staff check fails.
    if (saved.hash === undefined || saved.hash === null) properties.delete('ADMIN_PIN_HASH');
    else properties.set('ADMIN_PIN_HASH', saved.hash);
    if (saved.pin !== undefined && saved.pin !== null) properties.set('ADMIN_PIN', saved.pin);
    properties.delete('CK_PIN_FAILURES');
    properties.delete('CK_PIN_LOCKED');
  }
});

/* ------------------------------------------------------- 6. settings contract ---- */

check('the retention window is an owner-editable setting, validated like the rest', () => {
  const catalog = CATALOG.find((group) => group.fields.some((field) => field.key === 'RETENTION_MONTHS'));
  assert.ok(catalog, 'RETENTION_MONTHS is in the settings catalog');
  assert.equal(catalog.group, 'retention');
  const saved = context.saveClinicSettings({ values: { RETENTION_MONTHS: '18' } }, pinHash);
  assert.equal(saved.ok, true, saved.message);
  assert.equal(properties.get('RETENTION_MONTHS'), '18');
  const rejected = context.saveClinicSettings({ values: { RETENTION_MONTHS: '500' } }, pinHash);
  assert.equal(rejected.ok, false, '500 months is outside the allowed 1..60');
  assert.equal(properties.get('RETENTION_MONTHS'), '18', 'a rejected value changes nothing');
  properties.delete('RETENTION_MONTHS');
});

check('the dashboard surfaces the retention purge to staff', () => {
  seedSheets();
  seeded = null;
  const old = new Date();
  old.setMonth(old.getMonth() - 30);
  appendRow({ reference: 'CK-OLD00009', status: 'CANCELLED', createdAt: old.toISOString() });
  properties.delete('CK_LAST_PURGE');
  calendar.events.length = 0;
  const dashboard = context.getDashboard(pinHash);
  assert.equal(dashboard.ok, true);
  assert.ok(dashboard.warnings.some((w) => /الاحتفاظ/.test(w)), 'the purge is announced, not silent');
  assert.ok(properties.get('CK_LAST_STAFF_ACTION'), 'opening the dashboard records staff freshness');
  properties.delete('CK_LAST_PURGE');
});

/* ------------------------------------------------------------------ verdict ---- */

const total = pass.length + failures;
if (failures) {
  console.error(`\nPrivacy/health suite FAILED — ${failures} of ${total} checks failed.`);
  process.exit(1);
}
console.log(`Privacy/health suite passed: ${total} checks (reference is not a credential, deletion erases contact data and keeps the audit trail, deletion blocked by live events and outage queues, retention window + throttle, health payload without PII, closed uptime endpoint, retention as a validated setting).`);
console.log('Reminder: mocked services. Live behaviour in a real Google account is still unproven (gap G1).');
