/**
 * Celia Kids — editable clinic settings (no code required).
 *
 * WHY THIS FILE EXISTS
 * The clinic owner / doctor should never have to open Script Properties or edit
 * code to change a phone number, opening hours, a visit duration or a service.
 * Everything the page shows is described ONCE in CK_SETTINGS_CATALOG below; the
 * staff dashboard renders its form from that catalog, and this file validates and
 * writes the values back to Script Properties after a staff-authenticated save.
 *
 * ADDING A SETTING = ONE ENTRY IN THE CATALOG. No HTML, no CSS, no JS change:
 *   { key: 'CLINIC_LANDMARK', label: 'علامة مميزة قريبة', type: 'text', max: 80,
 *     help: 'تظهر أسفل العنوان في بطاقة العيادة' }
 *
 * BOUNDARIES (deliberate, see docs/settings.md)
 *  - Secrets are NEVER in the catalog: no GEMINI_API_KEY, no CALENDAR_ID, no
 *    GOOGLE_* token, no SHEET id. They stay in Script Properties / the manifest.
 *  - The staff PIN is never stored in clear text. The browser hashes it
 *    (SHA-256) and only the hash reaches Google; the plain PIN exists only in the
 *    browser's memory and in the owner's head.
 *  - Every write is audited (who / what / before → after) and the availability
 *    cache is invalidated so a saved change is visible immediately.
 */

const CK_SETTINGS_VERSION = 1;
const CK_MAX_SERVICES = 6;
const CK_MIN_PIN_LENGTH = 16;
// A stolen browser that keeps guessing is the realistic threat here: the PIN is long,
// but an unbounded endpoint turns a long PIN into a matter of patience. Locking for
// minutes (not seconds) keeps a human owner unaffected and makes guessing useless.
const CK_PIN_MAX_FAILURES = 5;
const CK_PIN_LOCK_SECONDS = 900;
// How long contact data lives. A month count, not a date, so the page can state the rule
// without a second copy of it: getPrivacyNotice() reads this same value.
const CK_DEFAULT_RETENTION_MONTHS = 12;
const CK_MIN_RETENTION_MONTHS = 1;
const CK_MAX_RETENTION_MONTHS = 60;

/** The single source of truth for what an owner can edit in the UI. */
const CK_SETTINGS_CATALOG = [
  {
    group: 'clinic',
    title: 'هوية العيادة',
    help: 'تظهر أعلى الصفحة وفي نتائج البحث.',
    fields: [
      { key: 'CLINIC_NAME', label: 'اسم العيادة', type: 'text', max: 60, required: true, help: 'كما يظهر لولي الأمر' },
      { key: 'CLINIC_PHONE', label: 'هاتف العيادة', type: 'phone', max: 22, help: 'اتركوه فارغًا إن لم يكن هناك رقم معلن' },
      { key: 'CLINIC_ADDRESS', label: 'العنوان', type: 'text', max: 120, help: 'العنوان الذي يظهر لولي الأمر' },
      { key: 'CLINIC_TIMELINE', label: 'سطر تعريفي قصير', type: 'text', max: 80, help: 'مثال: نخدم أطفال الجيزة منذ ٢٠١٤' }
    ]
  },
  {
    group: 'doctor',
    title: 'هوية الطبيب',
    help: 'أي حقل فارغ يُعرض على الصفحة كـ«غير منشور» — لا تُكتب بيانات غير محققة.',
    fields: [
      { key: 'DOCTOR_NAME', label: 'الاسم واللقب العلمي', type: 'text', max: 80 },
      { key: 'DOCTOR_TITLE', label: 'اللقب الوظيفي', type: 'text', max: 80, help: 'مثال: استشاري طب الأطفال وحديثي الولادة' },
      { key: 'DOCTOR_SUBSPECIALTY', label: 'التخصص الدقيق', type: 'text', max: 80 },
      { key: 'DOCTOR_LICENSE', label: 'رقم ترخيص مزاولة المهنة', type: 'text', max: 40, help: 'عند تعبئته تختفي شارة «لم يُتحقق بعد»' }
    ]
  },
  {
    group: 'hours',
    title: 'الدوام والمواعيد',
    help: 'ساعات العرض على الصفحة تُبنى من هذه القيم، ولا توجد نسخة مكتوبة في الكود.',
    fields: [
      { key: 'WORK_DAYS', label: 'أيام العمل', type: 'weekdays', help: 'الأحد = ٠ … السبت = ٦' },
      { key: 'WEEKEND_DAYS', label: 'أيام الإغلاق الأسبوعي', type: 'weekdays', help: 'لا تتقاطع مع أيام العمل' },
      { key: 'WORK_START', label: 'بداية الدوام', type: 'time' },
      { key: 'WORK_END', label: 'نهاية الدوام', type: 'time' },
      { key: 'SLOT_MINUTES', label: 'الفاصل بين بدايات المواعيد', type: 'int', min: 5, max: 120, help: 'بالدقائق' }
    ]
  },
  {
    group: 'services',
    title: 'أنواع الزيارات ومدتها',
    help: 'تُبنى منها قائمة «نوع الزيارة» على الصفحة ومدة كل موعد والتحقق من السعة.',
    fields: [
      { key: 'VISIT_SERVICES', label: 'أنواع الزيارات وأسعارها', type: 'services', help: 'سطر لكل نوع: الاسم = المدة بالدقائق = السعر (السعر اختياري، واتركوه فارغًا إن لم يكن معلنًا)' }
    ]
  },
  {
    group: 'retention',
    title: 'الخصوصية والاحتفاظ',
    help: 'تُعرض على صفحة الخصوصية المنشورة؛ تغييرها هنا يغيّر ما يقرأه ولي الأمر.',
    fields: [
      { key: 'RETENTION_MONTHS', label: 'مدة الاحتفاظ ببيانات الطلبات (بالأشهر)', type: 'int', min: 1, max: 60, help: 'بعدها تُحذف بيانات التواصل من الطلبات القديمة. القيمة نفسها تظهر على صفحة الخصوصية.' }
    ]
  },
  {
    group: 'security',
    title: 'رمز الدخول',
    help: 'لا يُخزَّن الرمز كما هو: يُخزَّن بصمة SHA-256 فقط، ولا يمكن قراءته من الواجهة.',
    fields: [
      { key: 'STAFF_PIN', label: 'رمز دخول جديد', type: 'pin', secret: true, help: '16 حرفًا على الأقل؛ لا يُعرض الرمز الحالي أبدًا' }
    ]
  }
];

/** Fields the catalog exposes; everything else in Script Properties is off-limits to the UI. */
function settingsFieldMap_() {
  const map = {};
  CK_SETTINGS_CATALOG.forEach(function (group) {
    group.fields.forEach(function (field) { map[field.key] = field; });
  });
  return map;
}

/* ------------------------------------------------------------------ auth ---- */

function pinHash_(pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pin), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

/**
 * A random staff PIN for a brand-new deployment. 24 characters from an unambiguous
 * alphabet (~139 bits) are generated per deployment and never stored: only the hash
 * is kept, and initializeCeliaKids returns the PIN once for the doctor to save.
 */
function randomStaffPin_() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let pin = '';
  for (let index = 0; index < 24; index += 1) {
    const byte = parseInt(hex.substr(index * 2, 2), 16);
    pin += alphabet.charAt(byte % alphabet.length);
  }
  return pin;
}

function isPinHash_(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

/** { configured, hashed } — never the value itself. */
function staffPinState_() {
  const props = PropertiesService.getScriptProperties();
  if (isPinHash_(props.getProperty('ADMIN_PIN_HASH'))) return { configured: true, hashed: true };
  const legacy = props.getProperty('ADMIN_PIN');
  if (legacy) return { configured: true, hashed: false, legacy: legacy };
  return { configured: false, hashed: false };
}

/**
 * Verify a PIN. Accepts the hash (what the browser sends) or, in demo/tests, the
 * plain value. A legacy plain ADMIN_PIN is upgraded to a hash on first success.
 */
function verifyStaffPin_(candidate, countFailure) {
  // A caller checking multiple stores records one final failure, not one per store.
  // Other callers preserve the original single-store behavior.
  const recordFailure = countFailure !== false;
  const value = String(candidate || '');
  if (!value) return false;
  if (staffPinLocked_()) {
    // Logged without the candidate: a lockout must never become a way to test a PIN.
    logEvent_('warn', 'staff_pin_locked', { window_s: CK_PIN_LOCK_SECONDS });
    return false;
  }
  const state = staffPinState_();
  if (!state.configured) return false;
  if (state.hashed) {
    const hash = isPinHash_(value) ? value.toLowerCase() : pinHash_(value);
    const stored = String(PropertiesService.getScriptProperties().getProperty('ADMIN_PIN_HASH')).toLowerCase();
    if (!constantTimeEquals_(hash, stored)) { if (recordFailure) staffPinFailure_(); return false; }
    staffPinSuccess_();
    return true;
  }
  if (!constantTimeEquals_(value, state.legacy)) { if (recordFailure) staffPinFailure_(); return false; }
  staffPinSuccess_();
  migrateLegacyPin_(state.legacy);
  return true;
}

/* ------------------------------------------------- staff PIN attempt limit ---- */

/**
 * Is the staff gate in a cooling-off window after repeated wrong PINs?
 *
 * CacheService is per-script and shared by every user of the web app, which is
 * exactly the scope the limit needs. It is deliberately best-effort: if the cache
 * is unavailable the clinic is not locked out by a storage problem, and the
 * decision is simply "not locked" (the PIN itself is still verified).
 */
function staffPinLocked_() {
  if (typeof CacheService === 'undefined') return false;
  try { return !!CacheService.getScriptCache().get('CK_PIN_LOCKED'); }
  catch (error) { return false; }
}

/** Count a failure and arm the lock once the threshold is reached. */
function staffPinFailure_() {
  if (typeof CacheService === 'undefined') return;
  try {
    const cache = CacheService.getScriptCache();
    const used = Number(cache.get('CK_PIN_FAILURES') || 0) + 1;
    // The counter lives as long as the lock does; a slow guesser cannot outlive it.
    cache.put('CK_PIN_FAILURES', String(used), CK_PIN_LOCK_SECONDS);
    if (used >= CK_PIN_MAX_FAILURES) {
      cache.put('CK_PIN_LOCKED', '1', CK_PIN_LOCK_SECONDS);
      cache.remove('CK_PIN_FAILURES');
      logEvent_('warn', 'staff_pin_lock_armed', { failures: used, window_s: CK_PIN_LOCK_SECONDS });
    }
  } catch (error) { /* best effort: a cache failure must not block a real login */ }
}

/** A successful login clears the counter so a typo never accumulates into a lock. */
function staffPinSuccess_() {
  if (typeof CacheService === 'undefined') return;
  try {
    const cache = CacheService.getScriptCache();
    cache.remove('CK_PIN_FAILURES');
    cache.remove('CK_PIN_LOCKED');
  } catch (error) { /* best effort */ }
}

/** Non-secret state for the dashboard and the readiness check. */
function staffPinLockState_() {
  return { locked: staffPinLocked_(), maxFailures: CK_PIN_MAX_FAILURES, lockSeconds: CK_PIN_LOCK_SECONDS };
}

/**
 * The audit trail says "staff". With one shared PIN that is all it can say, so the
 * evidence needed after a mistake ("who confirmed this?") does not exist. Apps Script
 * exposes the signed-in account of whoever runs the web app, so the audit row records
 * it. It is actor identity only: no email is rendered to a guardian, and a failure to
 * read it must never block an action.
 */
function staffActor_() {
  // Identity is the staff row that authenticated this call (ADR 0007). The platform
  // account is a fallback for actions that have no session, and 'staff' for the rest —
  // it is never a claim that the row is unknown.
  const session = activeStaff_();
  if (session && session.id && !session.legacy) {
    return 'staff:' + String(session.id).slice(0, 40) + ':' + String(session.role || '');
  }
  try {
    const email = Session.getActiveUser().getEmail();
    return email ? 'staff:' + String(email).toLowerCase().slice(0, 120) : 'staff';
  } catch (error) { return 'staff'; }
}


/** Replace a legacy plain PIN with its hash (one-way; the plain value is deleted). */
function migrateLegacyPin_(plain) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('ADMIN_PIN_HASH')) return false;
    props.setProperty('ADMIN_PIN_HASH', pinHash_(plain));
    props.deleteProperty('ADMIN_PIN');
    logEvent_('info', 'admin_pin_hashed', {});
    return true;
  } catch (error) { return false; }
}

/* ------------------------------------------------------------- read side ---- */

function readSetting_(props, key) {
  const value = props.getProperty(key);
  return value === null || value === undefined ? '' : String(value);
}

function readDayList_(raw, fallback) {
  const source = raw === null || raw === undefined || raw === '' ? fallback : raw;
  return String(source).split(',').map(function (v) { return Number(String(v).trim()); })
    .filter(function (v) { return Number.isInteger(v) && v >= 0 && v <= 6; })
    .filter(function (v, index, list) { return list.indexOf(v) === index; })
    .sort(function (a, b) { return a - b; })
    .join(',');
}

/* -------------------------------------------------------- services table ---- */

/** Visit types are configuration, not hardcoded Arabic strings in the page. */
const CK_DEFAULT_SERVICES = [
  { label: 'كشف جديد', minutes: 60 },
  { label: 'متابعة', minutes: 30 }
];

function readVisitServices_(props) {
  const raw = props.getProperty('VISIT_SERVICES');
  if (!raw) {
    // Backwards compatible: the two original durations keep working if only they are set.
    const slot = positiveNumber_(props.getProperty('SLOT_MINUTES'), CK.DEFAULT_MINUTES);
    const list = [
      { label: CK_DEFAULT_SERVICES[0].label, minutes: positiveNumber_(props.getProperty('NEW_VISIT_MINUTES'), 60) },
      { label: CK_DEFAULT_SERVICES[1].label, minutes: positiveNumber_(props.getProperty('FOLLOWUP_MINUTES'), 30) }
    ].filter(function (item) { return item.minutes > 0; });
    return list.length ? list : [{ label: CK_DEFAULT_SERVICES[0].label, minutes: slot }];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return CK_DEFAULT_SERVICES.slice();
    const list = parsed
      .map(function (item) {
        return {
          label: String(item && item.label || '').trim().slice(0, 40),
          minutes: Math.round(Number(item && item.minutes)),
          price: Math.max(0, Math.round(Number(item && item.price) || 0))
        };
      })
      .filter(function (item) { return item.label && Number.isFinite(item.minutes) && item.minutes >= 5 && item.minutes <= 240; });
    return list.length ? list : CK_DEFAULT_SERVICES.slice();
  } catch (error) { return CK_DEFAULT_SERVICES.slice(); }
}

function parseServicesInput_(raw) {
  const lines = String(raw || '').split('\n').map(function (line) { return line.trim(); }).filter(Boolean);
  const list = [];
  for (let index = 0; index < lines.length; index += 1) {
    // Split explicitly instead of one clever regex: with `-` as a separator a negative
    // price used to be swallowed as a separator and the line parsed as a 5-minute visit.
    const parts = String(lines[index]).split(/\s*[=\-–—:]\s*/).map(function (part) { return part.trim(); });
    if (parts.length < 2 || parts.length > 3) {
      return { ok: false, message: 'صيغة أنواع الزيارات غير صحيحة في السطر ' + (index + 1) + '. استخدموا: الاسم = المدة بالدقائق، ويمكن إضافة السعر بعد علامة = ثانية.' };
    }
    const label = parts[0];
    if (!label) return { ok: false, message: 'اسم نوع الزيارة مطلوب في السطر ' + (index + 1) + '.' };
    if (!/^\d{1,3}$/.test(parts[1])) return { ok: false, message: 'مدة الزيارة بالدقائق يجب أن تكون رقمًا صحيحًا في السطر ' + (index + 1) + '.' };
    const minutes = Number(parts[1]);
    if (minutes < 5 || minutes > 240) return { ok: false, message: 'مدة الزيارة يجب أن تكون بين ٥ و٢٤٠ دقيقة.' };
    // A price is optional on purpose: when the doctor has not decided a fee, the page
    // must show no price at all rather than a zero. A dangling separator is an error,
    // not "no price" — otherwise a typo would silently look like a free visit.
    let price = 0;
    if (parts.length === 3) {
      if (!/^\d{1,6}$/.test(parts[2]) || Number(parts[2]) > 100000) {
        return { ok: false, message: 'سعر الزيارة يجب أن يكون رقمًا صحيحًا بالجنيه في السطر ' + (index + 1) + '، أو احذفوا علامة = الأخيرة.' };
      }
      price = Number(parts[2]);
    }
    if (list.some(function (item) { return item.label === label; })) return { ok: false, message: 'نوع الزيارة مكرر: ' + label };
    list.push({ label: label, minutes: minutes, price: price });
  }
  if (!list.length) return { ok: false, message: 'أضيفوا نوع زيارة واحدًا على الأقل.' };
  if (list.length > CK_MAX_SERVICES) return { ok: false, message: 'الحد الأقصى ' + CK_MAX_SERVICES + ' أنواع زيارة.' };
  return { ok: true, services: list };
}

/** Current values for every catalog field, with the secret redacted. */
function getClinicSettings(pin) {
  const guard = requirePermission_(pin, 'booking:read:clinic');
  if (!guard.ok) return guard;
  try {
    const props = PropertiesService.getScriptProperties();
    const values = {};
    const map = settingsFieldMap_();
    Object.keys(map).forEach(function (key) {
      const field = map[key];
      if (field.secret) { values[key] = ''; return; }
      if (key === 'VISIT_SERVICES') {
        values[key] = readVisitServices_(props)
          .map(function (item) { return item.label + ' = ' + item.minutes + (item.price ? ' = ' + item.price : ''); })
          .join('\n');
        return;
      }
      if (key === 'WORK_DAYS') { values[key] = readDayList_(props.getProperty('WORK_DAYS'), CK.DEFAULT_WORK_DAYS); return; }
      if (key === 'WEEKEND_DAYS') { values[key] = readDayList_(props.getProperty('WEEKEND_DAYS'), CK.DEFAULT_WEEKEND_DAYS); return; }
      if (key === 'WORK_START') { values[key] = readSetting_(props, key) || CK.DEFAULT_START; return; }
      if (key === 'WORK_END') { values[key] = readSetting_(props, key) || CK.DEFAULT_END; return; }
      if (key === 'SLOT_MINUTES') { values[key] = readSetting_(props, key) || String(CK.DEFAULT_MINUTES); return; }
      if (key === 'RETENTION_MONTHS') { values[key] = String(readRetentionMonths_(props)); return; }
      values[key] = readSetting_(props, key);
    });
    const pinState = staffPinState_();
    return {
      ok: true,
      version: CK_SETTINGS_VERSION,
      catalog: CK_SETTINGS_CATALOG,
      values: values,
      meta: {
        staffPinConfigured: pinState.configured,
        staffPinHashed: pinState.hashed,
        calendarConfigured: !!props.getProperty('CALENDAR_ID'),
        mustChangePin: props.getProperty('CK_MUST_CHANGE_PIN') === '1',
        minPinLength: CK_MIN_PIN_LENGTH,
        retentionMonths: readRetentionMonths_(props)
      }
    };
  } catch (error) {
    return { ok: false, message: 'تعذر قراءة الإعدادات.' };
  }
}

/* ------------------------------------------------------------ write side ---- */

/**
 * Save a subset of the catalog. Values arrive keyed by catalog key plus the staff
 * session PIN. Unknown keys are rejected: the catalog is the allowlist, so a
 * crafted request can never touch a secret or an internal key.
 */
function saveClinicSettings(payload, pin) {
  const guard = requirePermission_(pin, 'settings:write');
  if (!guard.ok) return guard;
  const input = payload && payload.values ? payload.values : {};
  const map = settingsFieldMap_();
  const unknown = Object.keys(input).filter(function (key) { return !map[key]; });
  if (unknown.length) return { ok: false, message: 'حقول غير معروفة: ' + unknown.join(', ') };

  const props = PropertiesService.getScriptProperties();
  const before = {};
  const next = {};
  const problems = [];
  Object.keys(input).forEach(function (key) {
    const result = normalizeSettingValue_(map[key], input[key], props);
    if (!result.ok) { problems.push(result.message); return; }
    if (result.skip) return;
    before[key] = readSetting_(props, key);
    next[key] = result.value;
  });
  if (problems.length) return { ok: false, message: problems.join(' ') };
  if (!Object.keys(next).length) return { ok: false, message: 'لا يوجد تغيير للحفظ.' };

  const check = validateCombinedSettings_(next, props);
  if (!check.ok) return check;

  try {
    Object.keys(next).forEach(function (key) {
      if (key === 'STAFF_PIN') return; // handled by saveStaffPin with the current PIN
      props.setProperty(key, next[key]);
    });
    const changed = Object.keys(next).filter(function (key) { return key !== 'STAFF_PIN'; }).map(function (key) {
      return key + ': ' + (before[key] || '—') + ' → ' + (next[key] || '—');
    });
    if (!changed.length) return { ok: false, message: 'لا يوجد تغيير للحفظ.' };
    dropSettingsCaches_();
    const auditStored = auditBestEffort_('', staffActor_(), 'SETTINGS_UPDATED', '', '',
      String(payload && payload.reason || 'تعديل من لوحة العيادة').slice(0, 60) + ' | ' + changed.join(' ; ').slice(0, 500));
    const settings = getClinicSettings(pin);
    return {
      ok: true,
      saved: Object.keys(next).filter(function (key) { return key !== 'STAFF_PIN'; }),
      warning: auditStored ? '' : 'تم الحفظ لكن تعذر تسجيل التغيير في سجل التدقيق؛ أبلغوا مسؤول النظام.',
      settings: settings.ok ? settings : null
    };
  } catch (error) {
    return { ok: false, message: error.message || 'تعذر حفظ الإعدادات.' };
  }
}

function normalizeSettingValue_(field, raw, props) {
  const value = raw === null || raw === undefined ? '' : String(raw).trim();
  if (field.type === 'pin') {
    if (!value) return { skip: true };
    if (!isPinHash_(value)) return { ok: false, message: 'الرمز يجب أن يُرسل كبصمة SHA-256 من الواجهة، لا كنص صريح.' };
    return { ok: true, value: value.toLowerCase() };
  }
  if (field.type === 'text') {
    if (!value && field.required) return { ok: false, message: field.label + ' مطلوب.' };
    if (value.length > (field.max || 80)) return { ok: false, message: field.label + ' أطول من المسموح (' + field.max + ' حرفًا).' };
    if (/[<>]/.test(value)) return { ok: false, message: field.label + ' يحتوي رموزًا غير مسموحة.' };
    return { ok: true, value: value };
  }
  if (field.type === 'phone') {
    if (!value) return { ok: true, value: '' };
    const cleaned = value.replace(/[^0-9+]/g, '');
    if (cleaned.replace(/\D/g, '').length < 6 || cleaned.length > (field.max || 22)) return { ok: false, message: 'رقم الهاتف غير صالح.' };
    return { ok: true, value: cleaned };
  }
  if (field.type === 'time') {
    if (!isValidTime_(value)) return { ok: false, message: field.label + ' يجب أن يكون بصيغة HH:MM.' };
    return { ok: true, value: value };
  }
  if (field.type === 'int') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < (field.min || 1) || number > (field.max || 999)) {
      return { ok: false, message: field.label + ' يجب أن يكون رقمًا بين ' + (field.min || 1) + ' و' + (field.max || 999) + '.' };
    }
    return { ok: true, value: String(number) };
  }
  if (field.type === 'weekdays') {
    const cleaned = readDayList_(value, '');
    return { ok: true, value: cleaned };
  }
  if (field.type === 'services') {
    const parsed = parseServicesInput_(value);
    if (!parsed.ok) return parsed;
    return { ok: true, value: JSON.stringify(parsed.services) };
  }
  return { ok: false, message: 'نوع حقل غير معروف: ' + field.type };
}

function validateCombinedSettings_(next, props) {
  const start = next.WORK_START || props.getProperty('WORK_START') || CK.DEFAULT_START;
  const end = next.WORK_END || props.getProperty('WORK_END') || CK.DEFAULT_END;
  if (!isValidTime_(start) || !isValidTime_(end)) return { ok: false, message: 'وقت الدوام غير صحيح.' };
  if (timeToMinutes_(start) >= timeToMinutes_(end)) return { ok: false, message: 'بداية الدوام يجب أن تسبق نهايته.' };

  const work = readDayList_(next.WORK_DAYS !== undefined ? next.WORK_DAYS : props.getProperty('WORK_DAYS'), CK.DEFAULT_WORK_DAYS);
  const weekend = readDayList_(next.WEEKEND_DAYS !== undefined ? next.WEEKEND_DAYS : props.getProperty('WEEKEND_DAYS'), CK.DEFAULT_WEEKEND_DAYS);
  const workList = work ? work.split(',').map(Number) : [];
  const weekendList = weekend ? weekend.split(',').map(Number) : [];
  const overlap = workList.filter(function (day) { return weekendList.indexOf(day) !== -1; });
  if (overlap.length) return { ok: false, message: 'أيام العمل وأيام الإغلاق تتقاطع في: ' + overlap.join(', ') };
  if (!workList.length) return { ok: false, message: 'اختاروا يوم عمل واحدًا على الأقل.' };

  const slot = Number(next.SLOT_MINUTES || props.getProperty('SLOT_MINUTES') || CK.DEFAULT_MINUTES);
  const services = next.VISIT_SERVICES
    ? (function () {
      try { return JSON.parse(next.VISIT_SERVICES); } catch (error) { return []; }
    })()
    : readVisitServices_(props);
  if (!services.length) return { ok: false, message: 'أضيفوا نوع زيارة واحدًا على الأقل.' };
  const longest = services.reduce(function (max, item) { return Math.max(max, Number(item.minutes) || 0); }, 0);
  const shortest = services.reduce(function (min, item) { return Math.min(min, Number(item.minutes) || 999); }, 999);
  const window_ = timeToMinutes_(end) - timeToMinutes_(start);
  if (longest > window_) {
    return { ok: false, message: 'أطول زيارة (' + longest + ' دقيقة) أطول من نافذة الدوام (' + window_ + ' دقيقة).' };
  }
  // A spacing wider than a short visit is allowed (it just leaves gaps); what is
  // never allowed is a visit that cannot fit inside the working window at all.
  if (shortest > window_) {
    return { ok: false, message: 'أقصر زيارة أطول من نافذة الدوام.' };
  }
  return { ok: true };
}

function dropSettingsCaches_() {
  invalidateSlotCache_();
}

/* --------------------------------------------------------- staff PIN change - */

/**
 * Changing the PIN requires the CURRENT PIN even inside an open session, so a
 * borrowed browser cannot lock the clinic out.
 */
function saveStaffPin(currentPin, newPin, pin) {
  const guard = requirePermission_(pin, 'staff:manage');
  if (!guard.ok) return guard;
  if (!verifyStaffPin_(currentPin)) return { ok: false, message: 'الرمز الحالي غير صحيح.' };
  const next = String(newPin || '').trim();
  if (next.length < CK_MIN_PIN_LENGTH) return { ok: false, message: 'الرمز الجديد يجب أن يكون ' + CK_MIN_PIN_LENGTH + ' حرفًا على الأقل.' };
  const nextHash = isPinHash_(next) ? next.toLowerCase() : pinHash_(next);
  const props = PropertiesService.getScriptProperties();
  if (nextHash === String(props.getProperty('ADMIN_PIN_HASH') || '').toLowerCase()) {
    return { ok: false, message: 'اختاروا رمزًا مختلفًا عن الحالي.' };
  }
  const previousHash = String(props.getProperty('ADMIN_PIN_HASH') || '').toLowerCase();
  props.setProperty('ADMIN_PIN_HASH', nextHash);
  props.deleteProperty('ADMIN_PIN');
  props.deleteProperty('CK_MUST_CHANGE_PIN');
  syncStaffPinHash_(previousHash, nextHash);
  invalidateSlotCache_();
  const auditStored = auditBestEffort_('', staffActor_(), 'STAFF_PIN_CHANGED', '', '', 'updated from the clinic dashboard');
  return { ok: true, warning: auditStored ? '' : 'تم تغيير الرمز لكن تعذر تسجيله في سجل التدقيق.' };
}

/* ------------------------------------------- retention + guardian data rights -- */

/**
 * Months of contact data the clinic keeps. Read in one place so the owner's setting and
 * the published privacy page cannot disagree; an out-of-range value falls back to the
 * default rather than silently inventing a policy the owner never chose.
 */
function readRetentionMonths_(props) {
  const raw = Number(String((props && props.getProperty('RETENTION_MONTHS')) || '').trim());
  if (!Number.isFinite(raw) || Math.round(raw) !== raw) return CK_DEFAULT_RETENTION_MONTHS;
  if (raw < CK_MIN_RETENTION_MONTHS || raw > CK_MAX_RETENTION_MONTHS) return CK_DEFAULT_RETENTION_MONTHS;
  return raw;
}

/**
 * What the published privacy page says. Public (no PIN): it is the notice a guardian must
 * be able to read *before* sending anything. It carries no contact detail, no secret and
 * no PII — only the policy and where to exercise the rights.
 */
function getPrivacyNotice() {
  try {
    const config = getConfig_();
    const props = PropertiesService.getScriptProperties();
    return {
      ok: true,
      clinicName: config.clinicName || '',
      phone: config.clinicPhone || '',
      address: config.clinicAddress || '',
      retentionMonths: readRetentionMonths_(props),
      // Without a published phone number the page must not claim a deletion channel that
      // does not exist; it says so in plain words instead.
      deletionChannels: config.clinicPhone
        ? ['phone']
        : []
    };
  } catch (error) {
    return { ok: false, message: 'تعذر قراءة سياسة الخصوصية.' };
  }
}

/** Reference prefixes are random; the phone digits are the ownership credential. */
function samePhone_(a, b) {
  const left = digits_(a);
  const right = digits_(b);
  if (left.length < 8 || right.length < 8) return false;
  return constantTimeEquals_(left.slice(-11), right.slice(-11));
}

/** The guardian's view of their own request. Deliberately narrower than a staff row. */
function lookupOwnRequest(reference, phone) {
  if (!String(phone || '').trim()) return { ok: false, message: 'أدخلوا رقم الهاتف المسجل في الطلب.' };
  try {
    const result = findOwnedRequest_(reference, phone);
    if (!result.ok) return result;
    if (!result.record) return { ok: false, message: 'لا يوجد طلب مطابق لهذا الرقم المرجعي وهذا الهاتف.' };
    const record = result.record;
    return {
      ok: true,
      booking: {
        reference: record.reference,
        status: record.status,
        visitType: record.visitType,
        day: record.day,
        time: record.time,
        slotVerified: !!record.slotVerified,
        retentionMonths: readRetentionMonths_(PropertiesService.getScriptProperties())
      }
    };
  } catch (error) {
    return { ok: false, message: 'تعذر قراءة الطلب الآن. حاولوا مرة أخرى بعد قليل.' };
  }
}

/**
 * Locate a request the caller can prove is theirs.
 *
 * A phone match is checked FIRST, and that is a safety decision, not an optimisation:
 * findRequest_() falls back to the outage queue (a Script Property, where rows that could
 * not reach Sheets wait), and the erasure path must never rewrite that queue from the
 * public web app. So the ownership check runs without touching Sheets, and the row is
 * located separately afterwards.
 */
function findOwnedRequest_(reference, phone) {
  const ref = String(reference || '').trim().toUpperCase();
  if (!/^CK-[A-Z0-9-]{6,40}$/.test(ref)) return { ok: true, record: null };
  const inQueue = (function () {
    try {
      const raw = PropertiesService.getScriptProperties().getProperty(CK.QUEUE_PREFIX + ref);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      logEvent_('error', 'guardian_lookup_queue_unreadable', { code: 'QUEUE_READ' });
      return { unreadable: true };
    }
  })();
  if (inQueue && inQueue.unreadable) return { ok: false, message: 'تعذر قراءة الطلب الآن. حاولوا مرة أخرى بعد قليل.' };
  if (inQueue && samePhone_(inQueue.phone, phone)) {
    return { ok: false, message: 'الطلب محفوظ مؤقتًا أثناء انقطاع السجل؛ حاولوا لاحقًا أو تواصلوا هاتفيًا مع العيادة.' };
  }
  const record = findRequest_(ref);
  if (!record) return { ok: true, record: null };
  // A DELETED row keeps its phone empty: nobody can prove ownership of it again, and the
  // answer to a repeat request is an honest "nothing left under this reference".
  return { ok: true, record: samePhone_(record.phone, phone) ? record : null };
}

/**
 * Erase the contact data of one request: the name and the phone become empty, the status
 * becomes DELETED, and only the administrative audit trail (reference, dates, statuses,
 * who) survives. A live appointment is refused here because it is still a clinic
 * obligation — cancel it first, then delete.
 */
function deleteOwnRequestData(reference, phone, reason) {
  if (!String(phone || '').trim()) return { ok: false, message: 'أدخلوا رقم الهاتف المسجل في الطلب.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك طلب آخر قيد المعالجة. حاولوا بعد لحظات.' };
  try {
    const owned = findOwnedRequest_(reference, phone);
    if (!owned.ok) return owned;
    if (!owned.record) return { ok: false, message: 'لا يوجد طلب مطابق لهذا الرقم المرجعي وهذا الهاتف.' };
    const ref = owned.record.reference;
    if (owned.record.status === 'DELETED') {
      return { ok: true, alreadyDeleted: true, booking: { reference: ref, status: 'DELETED' } };
    }
    const located = findRequestLocation_(ref);
    if (!located) return { ok: false, message: 'لا يوجد طلب مطابق لهذا الرقم المرجعي وهذا الهاتف.' };
    if (located.queueKey) return { ok: false, message: 'الطلب محفوظ مؤقتًا أثناء انقطاع السجل؛ حاولوا لاحقًا.' };
    const record = located.record;
    // A confirmed appointment that still sits in the clinic calendar is a commitment, not
    // a record: deleting the contact details would leave a slot reserved for nobody.
    let liveEvent = null;
    try {
      liveEvent = findCalendarEvent_(getCalendar_(), record.reference, record.day, record.time);
    } catch (error) {
      return { ok: false, message: 'تعذر الوصول إلى تقويم العيادة للتحقق من الموعد؛ حاولوا لاحقًا.' };
    }
    if (liveEvent) {
      return { ok: false, message: 'هذا الموعد ما زال محفوظًا في تقويم العيادة. اطلبوا إلغاءه أولًا ثم احذفوا البيانات.' };
    }
    const oldStatus = record.status;
    record.guardianName = '';
    record.phone = '';
    record.status = 'DELETED';
    record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    const auditStored = auditBestEffort_(record.reference, 'guardian', 'GUARDIAN_DATA_DELETED', oldStatus, 'DELETED',
      String(reason || 'طلب ولي الأمر حذف بياناته').slice(0, 80));
    logEvent_('info', 'guardian_data_deleted', { audit_stored: auditStored });
    return {
      ok: true,
      booking: { reference: record.reference, status: 'DELETED' },
      warning: auditStored ? '' : 'حُذفت البيانات، لكن تعذر تسجيل الحذف في سجل التدقيق. أبلغوا مسؤول النظام.'
    };
  } catch (error) {
    return { ok: false, message: error.message || 'تعذر حذف البيانات.' };
  } finally {
    lock.releaseLock();
  }
}

/* --------------------------------------------------------- reset / export --- */

/** Restore a group (or everything) to the shipped defaults. */
function resetClinicSettings(groupKey, pin) {
  const guard = requirePermission_(pin, 'settings:write');
  if (!guard.ok) return guard;
  const props = PropertiesService.getScriptProperties();
  const targetKeys = [];
  CK_SETTINGS_CATALOG.forEach(function (group) {
    if (groupKey && group.group !== groupKey) return;
    group.fields.forEach(function (field) { if (!field.secret) targetKeys.push(field.key); });
  });
  if (!targetKeys.length) return { ok: false, message: 'لا يوجد ما يُستعاد.' };
  targetKeys.forEach(function (key) { props.deleteProperty(key); });
  dropSettingsCaches_();
  const auditStored = auditBestEffort_('', staffActor_(), 'SETTINGS_RESET', '', '', groupKey || 'all');
  const settings = getClinicSettings(pin);
  return {
    ok: true,
    warning: auditStored ? '' : 'تمت الاستعادة لكن تعذر تسجيلها في سجل التدقيق.',
    settings: settings.ok ? settings : null
  };
}
