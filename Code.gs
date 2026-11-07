/**
 * Celia Kids — Google Apps Script backend (2026 edition).
 * Data handled here is administrative contact data only. Never add medical notes.
 */
const CK = {
  REQUESTS: 'Requests',
  AUDIT: 'Audit',
  CLOSURES: 'Closures',
  REQUEST_HEADERS: ['reference','createdAt','status','visitType','guardianName','phone','day','time','eventId','updatedAt','consent','slotVerified'],
  AUDIT_HEADERS: ['timestamp','actor','reference','action','fromStatus','toStatus','details'],
  CLOSURE_HEADERS: ['day','start','end','label','createdAt'],
  QUEUE_PREFIX: 'CKQ_',
  AUDIT_QUEUE_PREFIX: 'CKA_',
  DEFAULT_START: '09:00',
  DEFAULT_END: '14:00',
  DEFAULT_MINUTES: 30,
  DEFAULT_WORK_DAYS: '0,1,2,3,4',
  DEFAULT_WEEKEND_DAYS: '5,6',
  // Never ship a literal staff credential: the first run generates a random PIN,
  // prints it once, and the dashboard insists it is replaced (see Settings.gs).
  MUST_CHANGE_FLAG: 'CK_MUST_CHANGE_PIN',
  MAX_REQUESTS_PER_PHONE_DAY: 3,
  MAX_OUTAGE_REQUESTS: 25,
  MAX_OUTAGE_AUDITS: 100
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Celia Kids | حجز مواعيد الأطفال')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Public read-only availability, cached briefly to protect Calendar read quota. */
function getAvailableSlotsCached_(day, visitType) {
  if (typeof CacheService === 'undefined') return null;
  try {
    const key = 'CK_SLOTS_' + String(day) + '_' + String(visitType || '');
    const hit = CacheService.getScriptCache().get(key);
    return hit ? JSON.parse(hit) : null;
  } catch (error) { return null; }
}

function putAvailableSlotsCached_(day, visitType, slots) {
  if (typeof CacheService === 'undefined') return;
  try {
    CacheService.getScriptCache().put(
      'CK_SLOTS_' + String(day) + '_' + String(visitType || ''),
      JSON.stringify(slots),
      30 // seconds: short enough that approvals always re-check the calendar
    );
  } catch (error) { /* cache is best-effort; availability is re-verified on write */ }
}

/**
 * Drop the cached availability for a single clinic day.
 *
 * Every staff action that changes what is bookable (approve, move, cancel, close a day)
 * invalidates only the days it touched. The 30-second cache exists to spare the Calendar
 * read quota, never to keep selling a time that has just been taken: the previous code
 * invalidated the cache on a settings change only, so a guardian could be shown, and
 * could pick, a slot that a staff approval had consumed seconds earlier.
 */
function invalidateSlotCacheFor_(day) {
  if (typeof CacheService === 'undefined') return;
  const value = String(day || '');
  // Only a real clinic day narrows the list; an unknown value falls back to everything.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) { invalidateSlotCache_(); return; }
  try {
    const cache = CacheService.getScriptCache();
    const keys = [];
    clinicServices_().forEach(function (service) { keys.push('CK_SLOTS_' + value + '_' + service.label); });
    // The label a guardian actually requested may differ in whitespace from the catalog;
    // the default service is always cached under its catalogue label, and unknown labels
    // were never cached, so the catalog list is the complete set of keys for one day.
    if (typeof cache.removeAll === 'function') cache.removeAll(keys);
    else keys.forEach(function (key) { cache.remove(key); });
  } catch (error) { /* cache is best effort; every write re-verifies availability */ }
}

/** Drop every cached availability entry (the key prefix embeds the day + service). */
function invalidateSlotCache_() {
  if (typeof CacheService === 'undefined') return;
  try {
    const cache = CacheService.getScriptCache();
    if (typeof cache.removeAll !== 'function') return;
    // Cache keys are per day+service; a settings change must not leave a stale answer.
    const properties = PropertiesService.getScriptProperties();
    const days = [];
    const today = new Date();
    for (let offset = 0; offset < 45; offset += 1) {
      const day = new Date(today.getTime() + offset * 86400000);
      days.push(Utilities.formatDate(day, properties.getProperty('TIMEZONE') || 'Africa/Cairo', 'yyyy-MM-dd'));
    }
    const keys = [];
    days.forEach(function (day) {
      clinicServices_().forEach(function (service) { keys.push('CK_SLOTS_' + day + '_' + service.label); });
    });
    // removeAll takes at most 200 keys per call: remove day by day.
    for (let index = 0; index < days.length; index += 1) {
      const dayKeys = keys.filter(function (key) { return key.indexOf('CK_SLOTS_' + days[index] + '_') === 0; });
      if (dayKeys.length) cache.removeAll(dayKeys);
    }
  } catch (error) { /* cache is best effort; every write re-verifies availability */ }
}

/**
 * Conservative screen for medical content. Long unambiguous stems are matched
 * anywhere; short ambiguous words (ألم، وجع، مغص) need real word boundaries —
 * without them the core booking word «الموعد» would be misread as «الم» (pain).
 */
const CK_MEDICAL_PATTERN = new RegExp(
  'أعراض|اعراض|حرارة|سخونية|حمى|دواء|أدوية|علاج|جرعة|تشخيص|طفح|سعال|كحة|قيء|إسهال|اسهال|نزيف|' +
  'طوارئ|تنفس|حساسية|عدوى|التهاب|عملية جراحية|' +
  '(?<![\u0621-\u064A])ألم(?![\u0621-\u064A])|(?<![\u0621-\u064A])الم(?![\u0621-\u064A])|' +
  '(?<![\u0621-\u064A])وجع(?![\u0621-\u064A])|(?<![\u0621-\u064A])مغص(?![\u0621-\u064A])|' +
  'emergency|fever|symptom|medicine|medication|diagnos|dose|rash|vomit|pain|treatment|breathing|allerg',
  'i'
);

/**
 * Structured JSON log to stdout (Apps Script execution log). Never log names,
 * phone numbers, questions or any free text — only codes and counters.
 */
function logEvent_(level, event, fields) {
  try {
    const line = { at: new Date().toISOString(), app: 'celia-kids', component: 'backend', event: event };
    Object.keys(fields || {}).forEach(function (key) { line[key] = fields[key]; });
    const logger = console[level] || console.log;
    logger(JSON.stringify(line));
  } catch (error) { /* logging must never break a request */ }
}

/** Run once from the bound spreadsheet's Apps Script editor and approve Google permissions. */
function initializeCeliaKids() {
  const props = PropertiesService.getScriptProperties();
  const active = SpreadsheetApp.getActiveSpreadsheet();
  const storedId = props.getProperty('CELIA_SHEET_ID');
  const ss = active || (storedId ? SpreadsheetApp.openById(storedId) : null);
  if (!ss) throw new Error('اربط Apps Script بملف Google Sheets أو أضف CELIA_SHEET_ID في Script Properties.');
  props.setProperty('CELIA_SHEET_ID', ss.getId());
  if (!props.getProperty('TIMEZONE')) props.setProperty('TIMEZONE', Session.getScriptTimeZone() || 'Africa/Cairo');
  // First run: generate a random PIN, keep only its hash, and show the PIN once in
  // this execution's return value. The doctor replaces it from the dashboard.
  let bootstrapPin = '';
  if (!staffPinState_().configured) {
    bootstrapPin = randomStaffPin_();
    props.setProperty('ADMIN_PIN_HASH', pinHash_(bootstrapPin));
    props.setProperty(CK.MUST_CHANGE_FLAG, '1');
    logEvent_('warn', 'bootstrap_pin_installed', {});
  }
  ensureSheet_(ss, CK.REQUESTS, CK.REQUEST_HEADERS);
  ensureSheet_(ss, CK.AUDIT, CK.AUDIT_HEADERS);
  ensureSheet_(ss, CK.CLOSURES, CK.CLOSURE_HEADERS);
  ensureSheet_(ss, CK_STAFF, CK_STAFF_HEADERS);
  [CK.REQUESTS, CK.AUDIT, CK.CLOSURES, CK_STAFF].forEach((name) => {
    const sheet = ss.getSheetByName(name);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#e3f2ec');
  });
  const calendar = ensureClinicCalendar_(props);
  const readiness = validateConfig();
  // A freshly generated PIN is expected to block readiness until it is replaced, so
  // it is reported but never aborts setup — otherwise the printed PIN would be lost.
  const blocked = readiness.checks.filter((check) => !check.ok && check.id !== 'llm_optional' && check.id !== 'admin_pin');
  logEvent_(blocked.length ? 'warn' : 'info', 'initialize_complete', { calendar: calendar.getName(), blocked: blocked.length });
  if (blocked.length) {
    throw new Error('تم تجهيز الأوراق والتقويم، لكن الإعداد غير مكتمل: ' +
      blocked.map((check) => check.id + ' — ' + check.detail).join(' | '));
  }
  const ready = 'تم تجهيز الأوراق والتقويم وربط تقويم: ' + calendar.getName() + '. الإعداد صالح للنشر.';
  if (!bootstrapPin) return ready;
  return ready + '\n\nرمز دخول مؤقت لهذه النسخة (يُعرض مرة واحدة فقط): ' + bootstrapPin +
    '\nاحفظوه الآن ثم غيّروه من: لوحة العيادة ← إعدادات العيادة ← رمز الدخول. لا يمكن استرجاعه بعد ذلك.';
}

/** Reuse a configured calendar; otherwise create one dedicated Celia Kids calendar. */
function ensureClinicCalendar_(props) {
  const configuredId = props.getProperty('CALENDAR_ID');
  if (configuredId) {
    const configured = configuredId === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(configuredId);
    if (!configured) throw new Error('تعذر العثور على تقويم العيادة. راجع CALENDAR_ID.');
    return configured;
  }
  const name = 'Celia Kids — عيادة الأطفال';
  const matches = CalendarApp.getCalendarsByName(name);
  const timezone = props.getProperty('TIMEZONE') || 'Africa/Cairo';
  const calendar = matches.length ? matches[0] : CalendarApp.createCalendar(name, {
    timeZone: timezone,
    description: 'تقويم مواعيد عيادة الأطفال في Celia Kids.'
  });
  props.setProperty('CALENDAR_ID', calendar.getId());
  return calendar;
}

/**
 * Column positions for one sheet, resolved once per execution and validated
 * against the live header row before anything is read or written.
 *
 * Declared with `var` so it lands on the Apps Script global object: a test (or a
 * second setup run) can clear it. Every other top-level binding here is `const`.
 */
var sheetSchemaIndex_ = {};

/**
 * Prove the live sheet still has the schema the code assumes, then return a
 * header -> column-position map.
 *
 * rowToRequest_() and requestToRow_() index columns by position. That is only
 * safe while the sheet's first row is exactly `headers` — and nothing checked.
 * Adding one column to CK.REQUEST_HEADERS against a sheet created earlier shifted
 * every field silently: the guardian's phone landed in the *name* column, which
 * publicBooking_() renders, so a schema edit became a privacy leak with no error
 * anywhere. Reading a header is one call, so it is done once per execution.
 *
 * Fails closed and loudly. It never repairs the sheet: rewriting a header over
 * live rows is the same defect wearing a helper's clothes.
 */
function assertSheetSchema_(sheet, headers, label) {
  if (sheetSchemaIndex_[label]) return sheetSchemaIndex_[label];
  const width = Math.max(headers.length, sheet.getLastColumn());
  const live = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (cell) { return String(cell); });
  for (let i = 0; i < headers.length; i += 1) {
    if (live[i] === headers[i]) continue;
    logEvent_('error', 'schema_drift', {
      sheet: label,
      position: i + 1,
      expected: headers[i],
      found: live[i] || ''
    });
    const drift = new Error('مخطط ورقة ' + label + ' لا يطابق ما يتوقعه الكود عند العمود ' + (i + 1) +
      ': المتوقع «' + headers[i] + '» والموجود «' + (live[i] || 'فارغ') +
      '». أُوقف التنفيذ عمدًا — لا تعدّل الترويسة يدويًا فوق بيانات قائمة.');
    // Callers catch broadly. Without a marker, every catch site reports drift as a
    // generic "cannot reach Sheets", which is the one thing an operator must not
    // be told: the sheet is reachable, its columns are wrong.
    drift.code = 'SCHEMA_DRIFT';
    drift.sheet = label;
    throw drift;
  }
  const index = {};
  headers.forEach(function (header, position) { index[header] = position; });
  sheetSchemaIndex_[label] = index;
  return index;
}

/** True when an error is the schema guard refusing, not a service being down. */
function isSchemaDrift_(error) { return !!error && error.code === 'SCHEMA_DRIFT'; }

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  // Checked on every access, not only on creation: the dangerous case is a sheet
  // that already exists. A stray formatted cell also lands here — getLastRow()
  // counts formatting, so such a sheet skips the header write and reads back empty.
  assertSheetSchema_(sheet, headers, name);
  return sheet;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Start times a visit of `duration` minutes cannot use because the next visit would
 * have to start before the clinic would actually be open that day.
 *
 * The grid steps by SLOT_MINUTES and accepts a start when `start + duration <= end`,
 * which lets the *last* start overrun the end whenever duration is not a multiple of
 * the step (45-minute visit, 30-minute grid: 13:00 reaches 14:00, 13:30 does not).
 * The demo backend has to hide those starts too, otherwise the two disagree.
 */
function paddedStartIndex_(offset, duration, step) {
  return ((offset % duration) + duration) % duration;
}

function getAvailableSlots(day, visitType) {
  try {
    if (!isValidDay_(day)) return { ok: false, message: 'التاريخ غير صحيح.' };
    const cached = getAvailableSlotsCached_(day, visitType || 'كشف جديد');
    if (cached) return { ok: true, slots: cached, cached: true };
    const config = getConfig_();
    const date = makeDate_(day, config.start);
    if (!config.workDays.includes(clinicWeekday_(day))) return { ok: true, slots: [] };
    const minutes = config.duration;
    const visitMinutes = visitDuration_(visitType || 'كشف جديد');
    const startMinutes = timeToMinutes_(config.start);
    const endMinutes = timeToMinutes_(config.end);
    const slots = [];
    const pause = paddedStartIndex_(endMinutes - startMinutes, visitMinutes, minutes);
    const lastStart = endMinutes - visitMinutes - pause;
    for (let minute = startMinutes; minute <= lastStart; minute += minutes) {
      const time = minutesToTime_(minute);
      if (isSlotAvailable_(day, time, visitMinutes, '')) slots.push(time);
    }
    putAvailableSlotsCached_(day, visitType || 'كشف جديد', slots);
    return { ok: true, slots: slots };
  } catch (error) {
    return { ok: false, message: 'تعذر التحقق من تقويم العيادة الآن. يمكن إرسال وقت مفضل للمراجعة دون تأكيد.' };
  }
}

/**
 * An open request from the same phone for the same day. A parent who taps twice (or
 * reloads on a slow connection) must not end up as two rows the clinic has to reconcile,
 * and the clinic must not receive the same child twice.
 */
function findOpenDuplicate_(phone, day) {
  const wanted = digits_(phone);
  if (wanted.length < 8) return null;
  try {
    const sheet = requestsSheet_();
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return null;
    const head = values[0].map(function (cell) { return String(cell); });
    const at = function (name) { return head.indexOf(name); };
    const iRef = at('reference'); const iStatus = at('status'); const iPhone = at('phone'); const iDay = at('day');
    if (iRef < 0 || iStatus < 0 || iPhone < 0 || iDay < 0) return null;
    const open = ['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'];
    for (let row = 1; row < values.length; row += 1) {
      if (open.indexOf(String(values[row][iStatus])) < 0) continue;
      if (String(values[row][iDay]) !== String(day)) continue;
      if (digits_(values[row][iPhone]) !== wanted) continue;
      return String(values[row][iRef]);
    }
    return null;
  } catch (error) {
    return null; // never block intake because the duplicate check failed
  }
}

/**
 * How many requests this phone already sent for this clinic day. Covers the case where a
 * parent retries with a different time on purpose: the duplicate rule allows a new day but
 * this stops one number from filling the clinic's queue.
 */
function countRequestsForPhone_(phone, day) {
  const wanted = digits_(phone);
  if (wanted.length < 8) return 0;
  try {
    const values = requestsSheet_().getDataRange().getValues();
    if (values.length < 2) return 0;
    const head = values[0].map(function (cell) { return String(cell); });
    const iPhone = head.indexOf('phone');
    const iDay = head.indexOf('day');
    if (iPhone < 0 || iDay < 0) return 0;
    let count = 0;
    for (let row = 1; row < values.length; row += 1) {
      if (String(values[row][iDay]) !== String(day)) continue;
      if (digits_(values[row][iPhone]) === wanted) count += 1;
    }
    return count;
  } catch (error) {
    return 0; // never block intake because the counter failed
  }
}

/** Public intake: creates a pending request, never a Calendar event. */
function createRequest(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك طلب آخر قيد المعالجة. حاولوا مرة أخرى بعد لحظات.' };
  try {
    const clean = validateRequest_(payload);
    if (countRequestsForPhone_(clean.phone, clean.day) >= CK.MAX_REQUESTS_PER_PHONE_DAY) {
      return {
        ok: false,
        rateLimited: true,
        message: 'وصلتم إلى الحد الأقصى للطلبات لهذا اليوم من هذا الرقم. تواصلوا مع العيادة هاتفيًا لتعديل موعدكم.'
      };
    }
    const duplicate = findOpenDuplicate_(clean.phone, clean.day);
    if (duplicate) {
      return {
        ok: false,
        duplicate: true,
        reference: duplicate,
        message: 'لديكم طلب قائم لهذا اليوم بالرقم ' + duplicate + '. تابعوه من «طلب سابق» أو انتظروا تأكيد العيادة.'
      };
    }
    let verified = false;
    try {
      if (!isSlotAvailable_(clean.day, clean.time, visitDuration_(clean.visitType), '')) {
        return { ok: false, message: 'هذا الوقت لم يعد متاحاً. اختاروا وقتاً آخر.' };
      }
      verified = true;
    } catch (availabilityError) {
      // Preserve a requested preference for staff review if Calendar is temporarily unavailable.
      verified = false;
    }
    const now = new Date().toISOString();
    const record = {
      reference: 'CK-' + Utilities.getUuid().replace(/-/g, '').toUpperCase(),
      createdAt: now,
      status: verified ? 'PENDING_APPROVAL' : 'REQUESTED',
      visitType: clean.visitType,
      guardianName: clean.guardianName,
      phone: clean.phone,
      day: clean.day,
      time: clean.time,
      eventId: '',
      updatedAt: now,
      consent: true,
      slotVerified: verified
    };
    let savedLocally = false;
    try {
      requestsSheet_().appendRow(requestToRow_(record));
      savedLocally = false;
    } catch (sheetError) {
      // Apps Script Properties hold a bounded outage queue; no confirmation is implied.
      queueOutageRequest_(record);
      savedLocally = true;
    }
    const auditStored = auditBestEffort_(record.reference, 'guardian', 'REQUEST_CREATED', '', record.status, verified ? 'availability checked' : 'calendar unavailable; review required');
    let warning = verified ? '' : 'التقويم غير متاح؛ الطلب محفوظ كتفضيل ويحتاج مراجعة قبل الموافقة.';
    if (!auditStored) warning = (warning + ' تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.').trim();
    logEvent_(savedLocally ? 'warn' : 'info', 'request_created', { verified: verified, queued: savedLocally, audit_stored: auditStored });
    return { ok: true, booking: publicBooking_(record), savedLocally: savedLocally, warning: warning };
  } catch (error) {
    // Fail closed either way, but the internal reason belongs in the log and on the
    // staff board — not in a message read by a parent.
    if (isSchemaDrift_(error)) {
      logEvent_('error', 'booking_blocked_by_schema_drift', { sheet: error.sheet });
      return { ok: false, message: 'العيادة لا تستطيع استقبال الطلبات الآن. تواصلوا معنا هاتفيًا.' };
    }
    return { ok: false, message: error.message || 'تعذر حفظ الطلب.' };
  } finally {
    lock.releaseLock();
  }
}

function lookupBooking(reference) {
  const ref = String(reference || '').trim().toUpperCase();
  if (!/^CK-[A-Z0-9-]{6,40}$/.test(ref)) return { ok: false, message: 'تحققوا من الرقم المرجعي.' };
  try {
    const record = findRequest_(ref);
    if (!record) return { ok: false, message: 'لم نعثر على طلب بهذا الرقم.' };
    // A deleted request must not answer as if it were still open: the guardian is told the
    // record was erased, not shown a status that implies an appointment still exists.
    if (record.status === 'DELETED') {
      return { ok: false, deleted: true, message: 'حُذفت بيانات هذا الطلب بناءً على طلب ولي الأمر. للاستفسار تواصلوا مع العيادة هاتفيًا.' };
    }
    return { ok: true, booking: { reference: record.reference, day: record.day, time: record.time, status: record.status } };
  } catch (error) {
    return { ok: false, message: 'تعذر قراءة حالة الطلب حالياً. احتفظوا بالرقم المرجعي وتواصلوا مع العيادة.' };
  }
}

/** Constant-time comparison of the staff secret; no logging of the PIN itself. */
/** Every staff operation checks the secret stored in Script Properties. */
function getDashboard(pin) {
  const guard = requirePermission_(pin, 'booking:read:clinic');
  if (!guard.ok) return guard;
  const warnings = [];
  // Freshness, not a log line: healthCheck_() answers "has a human looked at this clinic
  // lately?" without reading the Audit sheet (which may be exactly what is broken).
  markStaffSeen_();
  try { syncOutageQueue_(); }
  catch (error) {
    if (isSchemaDrift_(error)) warnings.push('توقف: مزامنة الطابور الاحتياطي متوقفة بسبب أعمدة ورقة «' + error.sheet + '» (schema_drift).');
    else warnings.push('تعذر مزامنة سجل الطلبات مع Sheets؛ الطلبات الاحتياطية محفوظة للمراجعة عند عودة الخدمة.');
  }
  let bookings = [];
  try { bookings = readAllRequests_(); }
  catch (error) {
    if (isSchemaDrift_(error)) {
      // The board would otherwise be empty with a "check the connection" note, and
      // the clinic would chase a network that is fine. Say what is actually wrong.
      warnings.push('توقف: أعمدة ورقة «' + error.sheet + '» لا تطابق ما يتوقعه النظام، فالطلبات لا تُقرأ. ' +
        'لا تعدّلوا الأعمدة يدويًا — التفاصيل في سجل الأخطاء (schema_drift).');
      logEvent_('error', 'dashboard_blocked_by_schema_drift', { sheet: error.sheet });
    } else {
      warnings.push('تعذر الوصول إلى Google Sheets. راجعوا الاتصال قبل اتخاذ إجراء.');
    }
  }
  const closures = [];
  try { closures.push.apply(closures, readClosures_()); }
  catch (error) { warnings.push('تعذر قراءة إغلاقات الدوام.'); }
  try {
    // One readiness pass: the LLM check is reported on its own line below (it is optional).
    validateConfig().checks.filter((check) => !check.ok && check.id !== 'llm_optional')
      .forEach((check) => warnings.push('إعداد: ' + check.detail));
  } catch (error) {
    logEvent_('error', 'config_check_failed', { code: String(error && error.message ? error.message : error) });
    warnings.push('تعذر فحص إعداد العيادة؛ راجعوا السجلات.');
  }
  const llm = llmStatus();
  if (!llm.enabled) warnings.push('المساعد الاختياري غير مفعّل (لا يؤثر على الحجز).');
  else if (llm.circuitOpen) warnings.push('المساعد الاختياري في فترة تبريد بعد أعطال متكررة.');
  // Retention is enforced from the same place the queues are drained: the staff dashboard
  // is the only screen a human is guaranteed to open, and a policy nobody runs is a slogan.
  try {
    const purge = purgeExpiredRequests_();
    if (purge.purged) warnings.push('حُذفت بيانات ' + purge.purged + ' طلبًا قديمًا وفق مدة الاحتفاظ المعلنة.');
    if (purge.failed) warnings.push('تعذر حذف بيانات ' + purge.failed + ' طلبًا قديمًا؛ راجعوا سجل التدقيق.');
  } catch (error) {
    warnings.push('تعذر تشغيل قاعدة الاحتفاظ بالبيانات؛ راجعوا السجلات.');
  }
  const queued = readOutageQueue_();
  if (queued.length) warnings.push('توجد طلبات محفوظة مؤقتاً في طابور الانقطاع ولم تُزامن بعد. لا تؤكدوا هذه الطلبات حتى عودة Sheets.');
  const pendingAuditCount = Object.keys(PropertiesService.getScriptProperties().getProperties()).filter((key) => key.indexOf(CK.AUDIT_QUEUE_PREFIX) === 0).length;
  if (pendingAuditCount) warnings.push('توجد تغييرات بانتظار مزامنة سجل التدقيق.');
  queued.forEach((item) => { if (!bookings.some((b) => b.reference === item.reference)) bookings.push(item); });
  bookings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { ok: true, bookings: bookings, closures: closures, warnings: warnings };
}

/* ------------------------------------------------------------------ health ---- */

/** Record that a staff member actually opened the dashboard (no PII, one key). */
function markStaffSeen_() {
  try { PropertiesService.getScriptProperties().setProperty('CK_LAST_STAFF_ACTION', new Date().toISOString()); }
  catch (error) { /* freshness is best effort; it must never block the dashboard */ }
}


/**
 * One machine-readable answer to "is this deployment fit to take a request right now?".
 *
 * It exists because the alternative is finding out from a parent's phone call. It is
 * deliberately narrow: booleans, counters and timestamps — no name, no phone, no free
 * text, so the same payload can be read by staff, logged, or polled by an uptime check.
 */
function healthCheck_() {
  const started = new Date().toISOString();
  const now = Date.now();
  const checks = [];
  const add = function (id, ok, detail) { checks.push({ id: id, ok: !!ok, detail: detail || '' }); };

  let config = null;
  try { config = getConfig_(); add('config', true, ''); }
  catch (error) { add('config', false, error.message || 'إعداد غير صالح'); }

  let requestRows = 0;
  let sheetOk = false;
  let schemaDrifted = false;
  try {
    const sheet = getSpreadsheet_().getSheetByName(CK.REQUESTS);
    if (!sheet) add('sheets', false, 'ورقة Requests غير موجودة؛ شغّلوا initializeCeliaKids().');
    else {
      // Deliberately not getSheetByName alone: that only proves the tab exists. This
      // endpoint is the one an external monitor watches, so it has to notice a sheet
      // whose columns no longer match the code — otherwise the site stays green while
      // every read is wrong.
      assertSheetSchema_(sheet, CK.REQUEST_HEADERS, CK.REQUESTS);
      sheetOk = true;
      requestRows = Math.max(0, sheet.getLastRow() - 1);
      add('sheets', true, '');
    }
  } catch (error) {
    schemaDrifted = isSchemaDrift_(error);
    add('sheets', false, schemaDrifted
      ? 'أعمدة ورقة «' + error.sheet + '» لا تطابق النظام (schema_drift).'
      : (error.message || 'تعذر الوصول إلى Sheets'));
  }

  let calendarOk = false;
  try { calendarOk = !!getCalendar_(); add('calendar', calendarOk, calendarOk ? '' : 'تعذر العثور على تقويم العيادة'); }
  catch (error) { add('calendar', false, error.message || 'تعذر الوصول إلى Calendar'); }

  let pendingAudit = 0;
  let queuedRequests = 0;
  try {
    queuedRequests = readOutageQueue_().length;
    pendingAudit = Object.keys(PropertiesService.getScriptProperties().getProperties())
      .filter(function (key) { return key.indexOf(CK.AUDIT_QUEUE_PREFIX) === 0; }).length;
    // Half-full queues are the early warning; a full queue is in the detail text, not a
    // second boolean, so the payload stays one shape.
    const queueOk = queuedRequests < CK.MAX_OUTAGE_REQUESTS && pendingAudit < CK.MAX_OUTAGE_AUDITS;
    add('queues', queueOk, queuedRequests + '/' + CK.MAX_OUTAGE_REQUESTS + ' · ' + pendingAudit + '/' + CK.MAX_OUTAGE_AUDITS);
  } catch (error) { add('queues', false, 'تعذر قراءة طوابير الانقطاع'); }

  const pinState = staffPinState_();
  const pinOk = pinState.configured && PropertiesService.getScriptProperties().getProperty(CK.MUST_CHANGE_FLAG) !== '1';
  add('staff_pin', pinOk, pinOk ? '' : pinState.configured ? 'الرمز المؤقت ما زال مستخدمًا' : 'لا يوجد رمز دخول');

  const retentionMonths = (typeof readRetentionMonths_ === 'function')
    ? readRetentionMonths_(PropertiesService.getScriptProperties()) : 0;
  add('retention', retentionMonths >= 1, retentionMonths + ' شهر');

  // The two failures that made this function worth writing: a write that silently did
  // not land (stuck queue) and a dashboard nobody opened for days (no purge).
  const lastPurge = PropertiesService.getScriptProperties().getProperty('CK_LAST_PURGE') || '';
  const lastAction = PropertiesService.getScriptProperties().getProperty('CK_LAST_STAFF_ACTION') || '';
  const ageDays = function (iso) {
    if (!iso) return null;
    const then = Date.parse(iso);
    return Number.isFinite(then) ? Math.floor((now - then) / 86400000) : null;
  };
  add('last_purge', ageDays(lastPurge) === null || ageDays(lastPurge) <= 8, lastPurge || 'لم يُسجل بعد');

  const healthy = checks.every(function (check) { return check.ok; });
  return {
    ok: healthy,
    // One flat word for an external monitor to watch. `ok` alone cannot carry the
    // distinction: doGetHealth answers { ok: false } when the token is missing, so a
    // monitor reading only `ok` cannot tell "healthy" from "closed" from "broken",
    // and an HTTP-level monitor sees 200 in all three cases. Watch this field.
    //   ok    — every check passed
    //   drift — the sheet's columns no longer match the code; nothing reads correctly
    //   down  — some other failure (Sheets, Calendar, queues, retention, config)
    status: healthy ? 'ok' : (schemaDrifted ? 'drift' : 'down'),
    started: started,
    checks: checks,
    counters: {
      requests: requestRows,
      queued_requests: queuedRequests,
      queued_audits: pendingAudit,
      retention_months: retentionMonths
    },
    last_staff_action: lastAction,
    staff_action_age_days: ageDays(lastAction)
  };
}

/** Staff-facing health report (same payload, PIN required). */
function getHealthReport(pin) {
  const guard = requirePermission_(pin, 'staff:manage');
  if (!guard.ok) return guard;
  try {
    const report = healthCheck_();
    logEvent_('info', 'health_check', { ok: report.ok, status: report.status, queued: report.counters.queued_requests });
    // `status` is lifted out of the report so the board and the external monitor read
    // the same word from the same place, with no conditional expression on either side.
    return { ok: true, status: report.status, report: report };
  } catch (error) {
    // The endpoint still goes red, but a red light with no cause is a light nobody
    // can act on. Schema drift is named so the operator knows it is not an outage.
    const drift = isSchemaDrift_(error);
    logEvent_('error', 'health_check_failed', { code: drift ? 'SCHEMA_DRIFT' : 'HEALTH', sheet: drift ? error.sheet : '' });
    return { ok: false, message: drift
      ? 'فحص الصحة أحمر: أعمدة ورقة «' + error.sheet + '» لا تطابق النظام.'
      : 'تعذر تشغيل فحص الصحة.' };
  }
}

/**
 * Public uptime endpoint for an external monitor (freshness, not security).
 *
 * Publishing it must be an explicit act, not a default: without the secret
 * `HEALTH_TOKEN` set in Script Properties this returns 404 and reveals nothing.
 * With it, `?token=…` returns the same counters — never the request list.
 */
function doGetHealth(event) {
  const token = String(PropertiesService.getScriptProperties().getProperty('HEALTH_TOKEN') || '');
  const provided = String((event && event.parameter && event.parameter.token) || '');
  if (!token || !constantTimeEquals_(provided, token)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false })).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify(healthCheck_())).setMimeType(ContentService.MimeType.JSON);
}

/* --------------------------------------------------------------- retention ---- */

/** Statuses whose contact data may be erased once the retention window has passed. */
const CK_PURGEABLE_STATUSES = ['CANCELLED', 'COMPLETED', 'DELETED'];
const CK_PURGE_INTERVAL_MS = 22 * 60 * 60 * 1000;

function retentionCutoff_(months) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff.getTime();
}

/**
 * Erase contact data from old, settled requests. Two safety rules:
 *  - only terminal statuses are touched (a pending or confirmed visit is a live promise),
 *  - a row that still has a calendar event keeps its details, because the appointment is
 *    still real even if the sheet says otherwise.
 * The rest of the row (reference, dates, statuses) stays for the Clinic's own audit.
 */
function purgeExpiredRequests_() {
  const props = PropertiesService.getScriptProperties();
  const last = Date.parse(props.getProperty('CK_LAST_PURGE') || '');
  if (Number.isFinite(last) && Date.now() - last < CK_PURGE_INTERVAL_MS) return { purged: 0, failed: 0, skipped: true };
  const months = (typeof readRetentionMonths_ === 'function') ? readRetentionMonths_(props) : 12;
  const cutoff = retentionCutoff_(months);
  const sheet = requestsSheet_();
  let purged = 0;
  let failed = 0;
  if (sheet.getLastRow() >= 2) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, CK.REQUEST_HEADERS.length).getValues();
    const calendar = (function () { try { return getCalendar_(); } catch (error) { return null; } })();
    for (let index = 0; index < rows.length; index += 1) {
      const record = rowToRequest_(rows[index]);
      if (!record.phone && !record.guardianName) continue;
      if (CK_PURGEABLE_STATUSES.indexOf(record.status) === -1) continue;
      const created = Date.parse(record.createdAt);
      if (!Number.isFinite(created) || created > cutoff) continue;
      try {
        if (calendar && findCalendarEvent_(calendar, record.reference, record.day, record.time)) continue;
        record.guardianName = '';
        record.phone = '';
        if (record.status !== 'DELETED') record.status = 'DELETED';
        record.updatedAt = new Date().toISOString();
        sheet.getRange(index + 2, 1, 1, CK.REQUEST_HEADERS.length).setValues([requestToRow_(record)]);
        auditBestEffort_(record.reference, 'retention', 'RETENTION_PURGE', 'TERMINAL', 'DELETED', 'reached ' + months + ' months');
        purged += 1;
      } catch (error) {
        failed += 1;
        logEvent_('error', 'retention_purge_failed', { code: 'PURGE' });
      }
    }
  }
  props.setProperty('CK_LAST_PURGE', new Date().toISOString());
  if (purged || failed) logEvent_(failed ? 'warn' : 'info', 'retention_purge_complete', { purged: purged, failed: failed, months: months });
  return { purged: purged, failed: failed };
}

/**
 * Optional WhatsApp notice. Two failure modes must never reach the booking path:
 * the adapter throwing, and the adapter being absent (an older bundle that predates
 * WhatsApp.gs). In both cases the appointment stands: it is already saved and CONFIRMED
 * before this is called, so a notification problem can never downgrade it.
 * @param {string} kind confirmation | cancellation
 * @param {Object} record
 * @return {{ok: boolean, sent: boolean, reason: string}}
 */
function notifyWhatsapp_(kind, record) {
  if (typeof whatsappNotify_ !== 'function') return { ok: false, sent: false, reason: 'adapter-missing' };
  try {
    return whatsappNotify_(kind, record);
  } catch (error) {
    logEvent_('warn', 'whatsapp_notify_failed', {
      kind: kind,
      code: String((error && error.code) || 'WHATSAPP_FAILED')
    });
    return { ok: false, sent: false, reason: 'error' };
  }
}

function approveRequest(reference, pin) {
  const guard = requirePermission_(pin, 'booking:approve');
  if (!guard.ok) return guard;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    const located = findRequestLocation_(reference);
    if (!located) return { ok: false, message: 'الطلب غير موجود.' };
    if (located.queueKey) return { ok: false, message: 'الطلب محفوظ مؤقتاً أثناء انقطاع Sheets؛ لا يمكن تأكيده حتى عودة السجل.' };
    const record = located.record;
    if (!['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(record.status)) return { ok: false, message: 'حالة الطلب لا تسمح بالموافقة.' };
    const calendar = getCalendar_();
    const duration = visitDuration_(record.visitType);
    const start = makeDate_(record.day, record.time);
    const end = new Date(start.getTime() + duration * 60000);
    // Reuse a matching event from a prior partial attempt before checking for conflicts.
    let event = findCalendarEvent_(calendar, record.reference, record.day, record.time);
    if (event && (event.getStartTime().getTime() !== start.getTime() || event.getEndTime().getTime() !== end.getTime())) return { ok: false, message: 'يوجد حدث سابق بهذا المرجع بوقت مختلف؛ راجعوا التقويم قبل المتابعة.' };
    if (!isSlotAvailable_(record.day, record.time, duration, event ? event.getId() : '')) return { ok: false, message: 'الوقت لم يعد متاحاً. اقترحوا وقتاً بديلاً.' };
    if (!event) event = calendar.createEvent('Celia Kids | ' + record.visitType + ' | ' + record.reference, start, end, { description: 'مرجع إداري: ' + record.reference + '\nبيانات طبية: غير محفوظة.' });
    const oldStatus = record.status;
    record.eventId = event.getId();
    record.status = 'CONFIRMED';
    record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    logEvent_('info', 'appointment_confirmed', { has_event: !!record.eventId });
    const auditStored = auditBestEffort_(record.reference, staffActor_(), 'APPROVED_AND_SAVED', oldStatus, 'CONFIRMED', 'calendar event id stored');
    // Optional notice, OFF by default (WHATSAPP_MODE). Guarded twice (adapter present, and
    // adapter throwing) so it can never change the outcome of an already-saved appointment.
    // The 30-second read cache is now wrong for this day: it still offers a time the
    // calendar has just taken. A guardian could be shown a slot that is already sold.
    invalidateSlotCacheFor_(record.day);
    markStaffSeen_();
    notifyWhatsapp_('confirmation', record);
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم حفظ الموعد لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) {
    return { ok: false, message: error.message || 'تعذرت الموافقة. لم يُعرض تأكيد.' };
  } finally { lock.releaseLock(); }
}

function proposeAlternative(reference, day, time, pin) {
  const guard = requirePermission_(pin, 'booking:reschedule');
  if (!guard.ok) return guard;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    if (!isValidDay_(day) || !isValidTime_(time)) return { ok: false, message: 'التاريخ أو الوقت غير صحيح.' };
    const located = findRequestLocation_(reference);
    if (!located) return { ok: false, message: 'الطلب غير موجود.' };
    if (located.queueKey) return { ok: false, message: 'الطلب المؤقت لا يمكن تعديله حتى عودة Sheets.' };
    const record = located.record;
    if (!['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(record.status)) return { ok: false, message: 'اقتراح وقت بديل متاح للطلبات غير المؤكدة فقط.' };
    if (!isSlotAvailable_(day, time, visitDuration_(record.visitType), '')) return { ok: false, message: 'الوقت البديل غير متاح في التقويم.' };
    const oldStatus = record.status;
    record.day = day; record.time = time; record.status = 'RESCHEDULED'; record.slotVerified = true; record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    // A proposal reserves nothing in Calendar, but the slot list must stop advertising the
    // time the clinic has just offered, otherwise the phone will show it as still open.
    invalidateSlotCacheFor_(day);
    const auditStored = auditBestEffort_(record.reference, staffActor_(), 'ALTERNATIVE_PROPOSED', oldStatus, 'RESCHEDULED', day + ' ' + time);
    return { ok: true, booking: publicBooking_(record), message: 'تم تسجيل الاقتراح فقط؛ لم يُنشأ حدث ولم يتأكد الموعد.', warning: auditStored ? '' : 'تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تسجيل الوقت البديل.' }; }
  finally { lock.releaseLock(); }
}

function moveConfirmedAppointment(reference, day, time, reason, pin) {
  const guard = requirePermission_(pin, 'booking:reschedule');
  if (!guard.ok) return guard;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    if (!isValidDay_(day) || !isValidTime_(time)) return { ok: false, message: 'التاريخ أو الوقت غير صحيح.' };
    const located = findRequestLocation_(reference);
    if (!located || located.queueKey) return { ok: false, message: 'تعذر العثور على طلب محفوظ في Sheets.' };
    const record = located.record;
    if (record.status !== 'CONFIRMED' || !record.eventId) return { ok: false, message: 'يمكن تعديل موعد مؤكد فقط.' };
    if (!isSlotAvailable_(day, time, visitDuration_(record.visitType), record.eventId)) return { ok: false, message: 'الوقت الجديد غير متاح في التقويم.' };
    const event = getCalendar_().getEventById(record.eventId);
    if (!event) return { ok: false, message: 'لم نعثر على حدث التقويم. لا تتغير حالة الطلب.' };
    const oldDay = record.day; const oldTime = record.time;
    const start = makeDate_(day, time); const end = new Date(start.getTime() + visitDuration_(record.visitType) * 60000);
    event.setTime(start, end);
    invalidateSlotCacheFor_(oldDay);
    invalidateSlotCacheFor_(day);
    record.day = day; record.time = time; record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    const auditStored = auditBestEffort_(record.reference, staffActor_(), 'CONFIRMED_APPOINTMENT_MOVED', 'CONFIRMED', 'CONFIRMED', `${oldDay} ${oldTime} -> ${day} ${time}; ${String(reason || '').slice(0, 80)}`);
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم تحديث الموعد لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تعديل الموعد.' }; }
  finally { lock.releaseLock(); }
}

function cancelRequest(reference, reason, pin) {
  const guard = requirePermission_(pin, 'booking:reschedule');
  if (!guard.ok) return guard;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    const located = findRequestLocation_(reference);
    if (!located) return { ok: false, message: 'الطلب غير موجود.' };
    if (located.queueKey) return { ok: false, message: 'الطلب الاحتياطي محفوظ، لكن تحديثه يتطلب عودة Sheets.' };
    const record = located.record; const oldStatus = record.status;
    if (oldStatus === 'CANCELLED' || oldStatus === 'COMPLETED') return { ok: false, message: 'لا يمكن تغيير هذه الحالة.' };
    if (record.eventId) {
      const event = getCalendar_().getEventById(record.eventId);
      if (event) event.deleteEvent();
    }
    record.status = 'CANCELLED'; record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    logEvent_('info', 'appointment_cancelled', { from_status: oldStatus });
    const auditStored = auditBestEffort_(record.reference, staffActor_(), 'CANCELLED', oldStatus, 'CANCELLED', String(reason || '').slice(0, 100));
    // The freed time must be bookable now, not after the cache expires.
    invalidateSlotCacheFor_(record.day);
    notifyWhatsapp_('cancellation', record);
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم الإلغاء لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر إلغاء الطلب.' }; }
  finally { lock.releaseLock(); }
}

function completeRequest(reference, pin) {
  const guard = requirePermission_(pin, 'booking:no_show');
  if (!guard.ok) return guard;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    const located = findRequestLocation_(reference);
    if (!located || located.queueKey) return { ok: false, message: 'تعذر العثور على طلب محفوظ في Sheets.' };
    const record = located.record;
    if (record.status !== 'CONFIRMED') return { ok: false, message: 'يمكن إكمال زيارة مؤكدة فقط.' };
    record.status = 'COMPLETED'; record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    const auditStored = auditBestEffort_(record.reference, staffActor_(), 'VISIT_COMPLETED', 'CONFIRMED', 'COMPLETED', '');
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم تحديث الحالة لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تحديث حالة الزيارة.' }; }
  finally { lock.releaseLock(); }
}

function closeDay(day, label, pin) {
  const guard = requirePermission_(pin, 'booking:reschedule');
  if (!guard.ok) return guard;
  if (!isValidDay_(day)) return { ok: false, message: 'التاريخ غير صحيح.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    const sheet = closuresSheet_();
    const existing = readClosures_().some((item) => item.day === day && item.start === '' && item.end === '');
    if (!existing) sheet.appendRow([day, '', '', String(label || 'إغلاق يوم').slice(0, 80), new Date().toISOString()]);
    const auditStored = auditBestEffort_('', staffActor_(), 'DAY_CLOSED', '', '', day + ' ' + String(label || '').slice(0, 80));
    // Without this the closed day kept offering its slots for up to 30 seconds, and the
    // guardian met an error only after choosing a time the clinic had just closed.
    invalidateSlotCacheFor_(day);
    return { ok: true, warning: auditStored ? '' : 'تم إغلاق اليوم لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تسجيل الإغلاق.' }; }
  finally { lock.releaseLock(); }
}

/** Optional administrative FAQ only. Isolated from booking/calendar decisions. */
function askGeneralQuestion(question) {
  const text = String(question || '').trim().slice(0, 500);
  if (!text) return { ok: false, message: 'اكتبوا سؤالاً إدارياً قصيراً.' };
  // Policy screen stays in the domain: never forward medical content to a model.
  if (CK_MEDICAL_PATTERN.test(text)) {
    return { ok: true, answer: 'لا أقدم إرشادات طبية أو تشخيصاً. يرجى التواصل مع طبيب مؤهل، وفي الحالات الطارئة توجهوا فوراً إلى خدمات الطوارئ المحلية.' };
  }
  if (/@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\d\s().-]{8,}\d)/i.test(text)) {
    return { ok: false, code: 'PII_BLOCKED', message: 'لا ترسلوا بريداً إلكترونياً أو رقم هاتف في سؤال المساعد. يمكنكم متابعة الحجز دونها.' };
  }
  // Provider, model, retries and limits live in Llm.gs only.
  const result = llmAnswer_(text);
  if (result.ok) return { ok: true, answer: result.answer, cached: !!result.cached };
  const messages = {
    DISABLED: 'مساعدة المساعد غير مفعلة. يمكنكم متابعة الحجز دونها.',
    BUDGET: 'وصلت مساعدة المساعد إلى حد الاستخدام المسموح اليوم. يمكنكم متابعة الحجز دونها.',
    CIRCUIT_OPEN: 'المساعد غير متاح مؤقتاً. يمكنكم متابعة الحجز دونها.',
    INVALID_INPUT: 'اكتبوا سؤالاً إدارياً قصيراً.',
    EMPTY_ANSWER: 'لم تصل إجابة. يمكنكم متابعة الحجز دون المساعد.',
    PROVIDER_HTTP: 'تعذرت مساعدة المساعد الآن؛ استمروا بالحجز أو تواصلوا مع العيادة.',
    PROVIDER_NETWORK: 'تعذرت مساعدة المساعد الآن؛ استمروا بالحجز أو تواصلوا مع العيادة.'
  };
  return { ok: false, code: result.code, message: messages[result.code] || 'المساعدة غير متاحة الآن. يمكنكم متابعة الحجز دونها.' };
}

/**
 * Reads and validates runtime config. Invalid values are reported explicitly
 * (never silently replaced) so a misconfigured clinic fails fast and loudly.
 */
/** Display-only clinic facts for the page. Never includes PINs, ids or limits. */
function getClinicProfile() {
  try {
    const config = getConfig_();
    const license = config.doctorLicense || '';
    return {
      ok: true,
      name: config.clinicName,
      phone: config.clinicPhone,
      address: config.clinicAddress,
      license: license,
      // Tell the page whether the licence was verified by the clinic or is still a placeholder.
      licenseVerified: !!license,
      timeline: config.clinicTimeline,
      doctorName: config.doctorName,
      doctorRole: config.doctorTitle,
      subspecialty: config.doctorSubspecialty,
      hours: formatClinicHours_(config),
      // The visit types the clinic configured. Without this every visitor saw the two
      // built-in defaults, so a service added in settings never reached the page.
      services: clinicServices_(),
      workStart: config.start, workEnd: config.end,
      workDays: config.workDays, weekendDays: config.weekendDays, timezone: config.timezone
    };
  } catch (error) {
    return { ok: false, message: 'تعذر قراءة بيانات العيادة.' };
  }
}

function getConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const problems = [];
  const start = String(properties.getProperty('WORK_START') || CK.DEFAULT_START).trim();
  const end = String(properties.getProperty('WORK_END') || CK.DEFAULT_END).trim();
  if (!isValidTime_(start)) problems.push('WORK_START يجب أن يكون بصيغة HH:MM (القيمة الحالية: ' + start + ').');
  if (!isValidTime_(end)) problems.push('WORK_END يجب أن يكون بصيغة HH:MM (القيمة الحالية: ' + end + ').');
  if (!problems.length && timeToMinutes_(start) >= timeToMinutes_(end)) problems.push('WORK_START يجب أن يسبق WORK_END.');

  const rawDays = String(properties.getProperty('WORK_DAYS') || CK.DEFAULT_WORK_DAYS).split(',').map((v) => Number(v.trim()));
  const invalidDays = rawDays.filter((v) => !Number.isInteger(v) || v < 0 || v > 6);
  if (invalidDays.length) problems.push('WORK_DAYS يجب أن يحتوي أرقام أيام من 0 إلى 6 (غير صالح: ' + invalidDays.join(',') + ').');
  const workDays = Array.from(new Set(rawDays.filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)));

  const rawWeekend = String(properties.getProperty('WEEKEND_DAYS') || CK.DEFAULT_WEEKEND_DAYS).split(',').map((v) => Number(v.trim()));
  const weekendDays = Array.from(new Set(rawWeekend.filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)));
  const weekendOverlap = weekendDays.filter((v) => workDays.includes(v));
  if (weekendOverlap.length) problems.push('WEEKEND_DAYS يتقاطع مع WORK_DAYS في الأيام: ' + weekendOverlap.join(',') + '.');

  const rawDuration = properties.getProperty('SLOT_MINUTES');
  const duration = positiveNumber_(rawDuration, CK.DEFAULT_MINUTES);
  if (rawDuration && duration === CK.DEFAULT_MINUTES && Number(rawDuration) !== CK.DEFAULT_MINUTES) {
    problems.push('SLOT_MINUTES يجب أن يكون رقماً موجباً.');
  }
  if (problems.length) {
    const error = new Error('إعداد العيادة غير صالح: ' + problems.join(' '));
    error.code = 'CONFIG_INVALID';
    error.problems = problems;
    throw error;
  }
  return {
    start: start,
    end: end,
    duration: duration,
    workDays: workDays,
    weekendDays: weekendDays,
    clinicName: String(properties.getProperty('CLINIC_NAME') || 'Celia Kids').trim(),
    clinicPhone: String(properties.getProperty('CLINIC_PHONE') || '').replace(/[^0-9+]/g, ''),
    clinicTimeline: String(properties.getProperty('CLINIC_TIMELINE') || '').trim().slice(0, 80),
    clinicAddress: String(properties.getProperty('CLINIC_ADDRESS') || '').trim().slice(0, 120),
    // Doctor identity is display-only and optional: an empty value never becomes
    // an invented credential on the page (see getClinicProfile + the UI contract).
    doctorName: String(properties.getProperty('DOCTOR_NAME') || '').trim().slice(0, 80),
    doctorTitle: String(properties.getProperty('DOCTOR_TITLE') || '').trim().slice(0, 80),
    doctorSubspecialty: String(properties.getProperty('DOCTOR_SUBSPECIALTY') || '').trim().slice(0, 80),
    doctorLicense: String(properties.getProperty('DOCTOR_LICENSE') || '').trim().slice(0, 40),
    timezone: properties.getProperty('TIMEZONE') || Session.getScriptTimeZone() || 'Africa/Cairo'
  };
}

/** Human-readable opening hours built from the clinic configuration (never hardcoded). */
function formatClinicHours_(config) {
  const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const work = (config.workDays || []).slice().sort(function (a, b) { return a - b; });
  const weekend = (config.weekendDays || []).slice().sort(function (a, b) { return a - b; });
  const arabic = function (value) { return String(value).replace(/[0-9]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[Number(d)]; }); };
  const clock = function (time) {
    const parts = String(time || '').split(':');
    const hour = Number(parts[0]);
    const minute = parts[1] || '00';
    const suffix = hour < 12 ? 'ص' : 'م';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return arabic(hour12) + ':' + arabic(minute) + ' ' + suffix;
  };
  // A range is only honest when the working days form one consecutive block;
  // any other pattern is listed by name (a range would claim days that are closed).
  const consecutive = work.every(function (day, index) { return index === 0 || day === work[index - 1] + 1; });
  const dayLabel = !work.length ? ''
    : consecutive && work.length > 1 ? days[work[0]] + ' – ' + days[work[work.length - 1]]
      : work.map(function (day) { return days[day]; }).join('، ');
  const closed = !weekend.length ? ''
    : weekend.length === 2 && weekend[1] === weekend[0] + 1
      ? ' · ' + days[weekend[0]] + ' و' + days[weekend[1]] + ' مغلقان'
      : ' · مغلق: ' + weekend.map(function (day) { return days[day]; }).join('، ');
  return (dayLabel ? dayLabel + ' · ' : '') + clock(config.start) + ' – ' + clock(config.end) + closed;
}

/** Explicit startup check used by initializeCeliaKids() and the staff dashboard. */
function validateConfig() {
  const checks = [];
  const props = PropertiesService.getScriptProperties();
  let config = null;
  try { config = getConfig_(); checks.push({ id: 'clinic_config', ok: true }); }
  catch (error) { checks.push({ id: 'clinic_config', ok: false, detail: error.message }); }

  // The PIN is stored as a hash; readiness checks that one exists, that it is not
  // the shipped bootstrap credential, and that the doctor has replaced it.
  const pinState = staffPinState_();
  const pinOk = pinState.configured && !(props.getProperty('CK_MUST_CHANGE_PIN') === '1');
  checks.push({ id: 'admin_pin', ok: pinOk,
    detail: pinOk ? '' : pinState.configured
      ? 'رمز الدخول الحالي مؤقت: غيّروه من «إعدادات العيادة ← رمز الدخول».'
      : 'لا يوجد رمز دخول: شغّلوا initializeCeliaKids() ثم غيّروا الرمز من لوحة العيادة.' });

  let sheetOk = false;
  let sheetDetail = '';
  try { sheetOk = !!getSpreadsheet_().getSheetByName(CK.REQUESTS); if (!sheetOk) sheetDetail = 'ورقة Requests غير موجودة؛ شغّلوا initializeCeliaKids().'; }
  catch (error) { sheetDetail = error.message || 'تعذر الوصول إلى Sheets.'; }
  checks.push({ id: 'sheets', ok: sheetOk, detail: sheetDetail });

  let calendarOk = false;
  let calendarDetail = '';
  try { calendarOk = !!getCalendar_(); } catch (error) { calendarDetail = error.message || 'تعذر الوصول إلى Calendar.'; }
  checks.push({ id: 'calendar', ok: calendarOk, detail: calendarDetail });

  const llm = llmStatus();
  checks.push({ id: 'llm_optional', ok: true, detail: llm.enabled ? 'مفعّل (اختياري)' : 'غير مفعّل (اختياري)' });

  return {
    ok: checks.filter((check) => check.id !== 'llm_optional').every((check) => check.ok),
    checks: checks,
    config: config
  };
}
/**
 * Duration of a visit type, read from the clinic's configured services (Settings.gs).
 * Adding a service in the dashboard makes it bookable without a code change.
 */
function visitDuration_(visitType) {
  const services = readVisitServices_(PropertiesService.getScriptProperties());
  const match = services.filter(function (item) { return item.label === String(visitType || '').trim(); })[0];
  if (match) return match.minutes;
  return services.length ? services[0].minutes : positiveNumber_(PropertiesService.getScriptProperties().getProperty('SLOT_MINUTES'), CK.DEFAULT_MINUTES);
}

/** The visit types the clinic currently offers (first one is the default). */
function clinicServices_() {
  return readVisitServices_(PropertiesService.getScriptProperties());
}
function positiveNumber_(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback; }
function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('CELIA_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('لم يتم إعداد Google Sheets. شغّل initializeCeliaKids() أولاً.');
}
// ensureSheet_ is idempotent and now carries the schema guard, so it runs on every
// access. The previous `getSheetByName(name) || ensureSheet_(...)` short-circuit
// meant an existing sheet was returned unchecked — exactly the sheet that can drift.
function requestsSheet_() { return ensureSheet_(getSpreadsheet_(), CK.REQUESTS, CK.REQUEST_HEADERS); }
function closuresSheet_() { return ensureSheet_(getSpreadsheet_(), CK.CLOSURES, CK.CLOSURE_HEADERS); }
function auditSheet_() { return ensureSheet_(getSpreadsheet_(), CK.AUDIT, CK.AUDIT_HEADERS); }
function getCalendar_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID') || 'primary';
  const calendar = id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  if (!calendar) throw new Error('تعذر العثور على تقويم العيادة. راجع CALENDAR_ID.');
  return calendar;
}
/**
 * Staff gate. Delegates to verifyStaffPin_ (Settings.gs): the PIN is stored as a
 * SHA-256 hash, the browser sends the hash, and a legacy plain ADMIN_PIN is
 * migrated on first successful login. A hash shorter than 16 hex characters or
 * the demo PIN can never authenticate in a real deployment.
 */
function isStaff_(pin) {
  const candidate = String(pin || '');
  if (candidate.length < 16 || candidate === '2468') return false;
  try { return verifyStaffPin_(candidate); }
  catch (error) { return false; }
}
/**
 * Compare two secrets without leaking WHERE they differ.
 *
 * Length is compared first and is not secret (a PIN digest is always 64 chars). The loop then
 * runs over the full length of both strings, so a correct prefix is not "equal": comparing
 * only up to a.length made every prefix of the stored secret pass — silently.
 */
function constantTimeEquals_(a, b) {
  const left = String(a === undefined || a === null ? '' : a);
  const right = String(b === undefined || b === null ? '' : b);
  if (left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i += 1) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}
function validateRequest_(payload) {
  if (!payload || payload.consent !== true) throw new Error('يلزم تأكيد الموافقة على استخدام بيانات التواصل لإدارة الطلب.');
  const services = clinicServices_();
  const labels = services.map(function (item) { return item.label; });
  const visitType = String(payload.visitType || '').trim() || labels[0];
  if (labels.indexOf(visitType) === -1) throw new Error('نوع الزيارة غير صحيح.');
  const guardianName = String(payload.guardianName || '').trim().replace(/[<>]/g, '').slice(0, 80);
  const phone = String(payload.phone || '').trim().slice(0, 22);
  if (guardianName.length < 2 || digits_(phone).length < 8) throw new Error('يرجى إدخال اسم ولي الأمر ورقم هاتف صالح.');
  if (!isValidDay_(payload.day) || !isValidTime_(payload.time)) throw new Error('التاريخ أو الوقت غير صحيح.');
  if (makeDate_(String(payload.day), String(payload.time)) <= new Date()) throw new Error('اختاروا وقتاً في المستقبل.');
  return { visitType: visitType, guardianName: guardianName, phone: phone, day: String(payload.day), time: String(payload.time), consent: true };
}
function digits_(value) { return String(value || '').replace(/\D/g, ''); }
function isValidDay_(day) { return /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) && !isNaN(new Date(String(day) + 'T12:00:00').getTime()); }
function isValidTime_(time) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(time || '')); }
// Minutes east of UTC for a zone at a given instant (+02:00 for Cairo in winter).
function zoneOffsetMinutes_(date, timezone) {
  if (!Utilities || typeof Utilities.formatDate !== 'function') return 0;
  const stamp = Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm');
  const chunks = stamp.split(' ');
  const day = chunks[0].split('-').map(Number);
  const clock = chunks[1].split(':').map(Number);
  if (day.length !== 3 || clock.length !== 2 || day.concat(clock).some(isNaN)) return 0;
  const asUTC = Date.UTC(day[0], day[1] - 1, day[2], clock[0], clock[1]);
  return Math.round((asUTC - date.getTime()) / 60000);
}
// An instant that reads as the given clinic-local wall clock, whatever zone the script
// itself runs in. `new Date(y, m, d, h, min)` used the runtime's zone, so a script account
// in UTC built 09:00 Cairo two hours early — and "is this still in the future?" was then
// answered for the wrong moment.
function clinicWallClock_(day, time) {
  if (!isValidDay_(day) || !isValidTime_(time)) throw new Error('التاريخ أو الوقت غير صحيح.');
  const timezone = getConfig_().timezone;
  const d = String(day).split('-').map(Number); const t = String(time).split(':').map(Number);
  const guess = Date.UTC(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0);
  // Two passes settle the DST edge: the first probe may itself be off by an hour.
  let instant = guess - zoneOffsetMinutes_(new Date(guess), timezone) * 60000;
  instant = guess - zoneOffsetMinutes_(new Date(instant), timezone) * 60000;
  return new Date(instant);
}
function makeDate_(day, time) {
  const date = clinicWallClock_(day, time);
  if (Utilities.formatDate(date, getConfig_().timezone, 'yyyy-MM-dd') !== day) throw new Error('التاريخ غير صالح.');
  return date;
}
// Day of week (0=Sunday) of a clinic day, from the calendar date itself.
function clinicWeekday_(day) {
  const parts = String(day).split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay();
}
function timeToMinutes_(time) { const p = time.split(':').map(Number); return p[0] * 60 + p[1]; }
function minutesToTime_(minutes) { return ('0' + Math.floor(minutes / 60)).slice(-2) + ':' + ('0' + (minutes % 60)).slice(-2); }
function isSlotAvailable_(day, time, duration, excludeEventId) {
  const config = getConfig_();
  if (!isValidDay_(day) || !isValidTime_(time)) return false;
  const start = makeDate_(day, time); const end = new Date(start.getTime() + duration * 60000);
  const offset = (timeToMinutes_(time) - timeToMinutes_(config.start)) % config.duration;
  // One nanosecond of tolerance: `new Date()` inside the same millisecond as a slot
  // must not make "the next slot" look like the past.
  if (start.getTime() - new Date().getTime() <= 0 || !config.workDays.includes(clinicWeekday_(day)) || timeToMinutes_(time) < timeToMinutes_(config.start) || (offset !== 0 && offset !== duration % config.duration) || timeToMinutes_(time) + duration > timeToMinutes_(config.end)) return false;
  if (closureBlocks_(day, time, duration)) return false;
  const events = getCalendar_().getEvents(start, end);
  return !events.some((event) => event.getId() !== excludeEventId && event.getStartTime() < end && event.getEndTime() > start);
}
function intervalsOverlap_(time, duration, otherStart, otherEnd) {
  if (!otherStart || !otherEnd) return true;
  const start = timeToMinutes_(time); const end = start + duration;
  return start < timeToMinutes_(otherEnd) && end > timeToMinutes_(otherStart);
}
/**
 * True when the requested time overlaps a stored closure.
 *
 * A closure row with empty start/end means "the whole day is closed" and blocks
 * every slot that day; a row with start/end blocks only that window. This is the
 * only place availability consults Closures, so closing a day really removes it
 * from the guardian's view (the dashboard already shows it as closed).
 */
function closureBlocks_(day, time, duration) {
  const minute = timeToMinutes_(time);
  return readClosures_().some((item) => {
    if (item.day !== day) return false;
    if (!item.start && !item.end) return true;
    const start = item.start ? timeToMinutes_(item.start) : 0;
    const end = item.end ? timeToMinutes_(item.end) : 24 * 60;
    return minute < end && start < minute + duration;
  });
}
function readClosures_() {
  const sheet = closuresSheet_(); if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, CK.CLOSURE_HEADERS.length).getValues().map((row) => ({ day: normalizeDayCell_(row[0]), start: String(row[1] || ''), end: String(row[2] || ''), label: String(row[3] || '') }));
}
function requestToRow_(record) { return [record.reference, record.createdAt, record.status, record.visitType, record.guardianName, record.phone, record.day, record.time, record.eventId || '', record.updatedAt, !!record.consent, !!record.slotVerified]; }
function normalizeDayCell_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return Utilities.formatDate(value, getConfig_().timezone, 'yyyy-MM-dd');
  const match = String(value || '').match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : '';
}
function rowToRequest_(row) { return { reference: String(row[0] || ''), createdAt: String(row[1] || ''), status: String(row[2] || ''), visitType: String(row[3] || ''), guardianName: String(row[4] || ''), phone: String(row[5] || ''), day: normalizeDayCell_(row[6]), time: String(row[7] || ''), eventId: String(row[8] || ''), updatedAt: String(row[9] || ''), consent: row[10] === true, slotVerified: row[11] === true }; }
function publicBooking_(record) { return { reference: record.reference, status: record.status, visitType: record.visitType, day: record.day, time: record.time, guardianName: record.guardianName, phone: record.phone, slotVerified: !!record.slotVerified }; }
function readAllRequests_() {
  const sheet = requestsSheet_(); const result = [];
  if (sheet.getLastRow() >= 2) sheet.getRange(2, 1, sheet.getLastRow() - 1, CK.REQUEST_HEADERS.length).getValues().forEach((row) => result.push(rowToRequest_(row)));
  // getLastRow() counts formatting as well as content, so a stray bold cell below
  // the data makes this read past the last real row. Every such row maps to an
  // all-empty record; without this filter they collapse into one phantom booking
  // keyed by '' and appear on the staff board.
  const records = result.filter((item) => item.reference !== '');
  const map = new Map(); records.forEach((item) => map.set(item.reference, item));
  readOutageQueue_().forEach((item) => { if (!map.has(item.reference)) map.set(item.reference, item); });
  return Array.from(map.values());
}
function readOutageQueue_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const broken = [];
  const records = Object.keys(props).filter((key) => key.indexOf(CK.QUEUE_PREFIX) === 0).map((key) => {
    try { return JSON.parse(props[key]); }
    catch (error) {
      broken.push(key);
      logEvent_('error', 'outage_queue_entry_unreadable', { key_suffix: key.slice(-6), code: String(error && error.message ? error.message : error) });
      return null;
    }
  }).filter(Boolean);
  if (broken.length) logEvent_('warn', 'outage_queue_entries_skipped', { count: broken.length });
  return records;
}
function queueOutageRequest_(record) {
  const encoded = JSON.stringify(record);
  if (encoded.length > 8000) throw new Error('تعذر حفظ الطلب: السجل الاحتياطي أكبر من الحد المسموح. أعدوا المحاولة أو تواصلوا مع العيادة.');
  if (readOutageQueue_().length >= CK.MAX_OUTAGE_REQUESTS) throw new Error('طابور الانقطاع ممتلئ؛ لم يُحفظ الطلب. يرجى إعادة المحاولة أو التواصل مع العيادة.');
  PropertiesService.getScriptProperties().setProperty(CK.QUEUE_PREFIX + record.reference, encoded);
}
function syncOutageQueue_() {
  const sheet = requestsSheet_(); const properties = PropertiesService.getScriptProperties();
  const queued = readOutageQueue_();
  queued.forEach((record) => {
    const existing = findRequestRow_(sheet, record.reference);
    if (!existing) sheet.appendRow(requestToRow_(record));
    properties.deleteProperty(CK.QUEUE_PREFIX + record.reference);
  });
  syncAuditQueue_();
}
function findRequestRow_(sheet, reference) {
  if (sheet.getLastRow() < 2) return 0;
  const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(String(reference)).matchEntireCell(true).findNext();
  return match ? match.getRow() : 0;
}
function findRequest_(reference) { const located = findRequestLocation_(reference); return located ? located.record : null; }
function findRequestLocation_(reference) {
  const ref = String(reference || '').trim().toUpperCase();
  const key = CK.QUEUE_PREFIX + ref; const saved = PropertiesService.getScriptProperties().getProperty(key);
  try {
    const sheet = requestsSheet_(); const rowNumber = findRequestRow_(sheet, ref);
    if (rowNumber) return { sheet: sheet, row: rowNumber, record: rowToRequest_(sheet.getRange(rowNumber, 1, 1, CK.REQUEST_HEADERS.length).getValues()[0]), queueKey: '' };
  } catch (error) {
    if (saved) return { sheet: null, row: 0, record: JSON.parse(saved), queueKey: key };
    throw error;
  }
  if (saved) return { sheet: null, row: 0, record: JSON.parse(saved), queueKey: key };
  return null;
}
function updateRequestRow_(row, record) { requestsSheet_().getRange(row, 1, 1, CK.REQUEST_HEADERS.length).setValues([requestToRow_(record)]); }
function findCalendarEvent_(calendar, reference, day, time) {
  const start = makeDate_(day, time); const end = new Date(start.getTime() + visitDurationFromRef_(reference) * 60000);
  const events = calendar.getEvents(new Date(start.getTime() - 60 * 60000), new Date(end.getTime() + 60 * 60000));
  const marker = 'مرجع إداري: ' + reference;
  return events.find((event) => String(event.getDescription() || '').indexOf(marker) !== -1) || null;
}
function visitDurationFromRef_(reference) { const record = findRequest_(reference); return record ? visitDuration_(record.visitType) : getConfig_().duration; }
function appendAudit_(reference, actor, action, fromStatus, toStatus, details) {
  auditSheet_().appendRow([new Date().toISOString(), actor, reference || '', action, fromStatus || '', toStatus || '', String(details || '').slice(0, 180)]);
}
function queueAudit_(reference, actor, action, fromStatus, toStatus, details) {
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  if (Object.keys(all).filter((key) => key.indexOf(CK.AUDIT_QUEUE_PREFIX) === 0).length >= CK.MAX_OUTAGE_AUDITS) throw new Error('طابور سجل التدقيق ممتلئ.');
  const key = CK.AUDIT_QUEUE_PREFIX + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  properties.setProperty(key, JSON.stringify([new Date().toISOString(), actor, reference || '', action, fromStatus || '', toStatus || '', String(details || '').slice(0, 180)]));
}
function auditBestEffort_(reference, actor, action, fromStatus, toStatus, details) {
  try { appendAudit_(reference, actor, action, fromStatus, toStatus, details); return true; }
  catch (auditError) {
    try { queueAudit_(reference, actor, action, fromStatus, toStatus, details); return true; }
    catch (queueError) { return false; }
  }
}
function syncAuditQueue_() {
  const properties = PropertiesService.getScriptProperties(); const all = properties.getProperties(); const sheet = auditSheet_();
  let stranded = 0;
  Object.keys(all).filter((key) => key.indexOf(CK.AUDIT_QUEUE_PREFIX) === 0).forEach((key) => {
    try { sheet.appendRow(JSON.parse(all[key])); properties.deleteProperty(key); }
    catch (error) {
      // Keep the entry queued, but record that it is still pending (never silent).
      stranded += 1;
      logEvent_('error', 'audit_queue_sync_failed', { key_suffix: key.slice(-6), code: String(error && error.message ? error.message : error) });
    }
  });
  if (stranded) logEvent_('warn', 'audit_queue_stranded', { count: stranded });
}
