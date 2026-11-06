(() => {
  'use strict';

  /* ============================================================
     Celia Kids — 2026 front-end
     Demo mode writes to this browser only. Live mode talks to the
     Google Apps Script backend through google.script.run.
     ============================================================ */

  const DEMO_KEY = 'celia-kids-demo-v1';
  const IS_GAS = typeof google !== 'undefined' && !!(google.script && google.script.run);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const can = (permission) => (state.permissions || []).indexOf(String(permission)) !== -1;
  const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * Demonstration mode has no server, so it runs as the owner: every permission on. The
   * live deployment replaces these the moment `login` answers (ADR 0007). The page may
   * hide a control with `can()`, and must still expect the server to refuse the call:
   * hiding a button is never a permission.
   */
  const ALL_PERMISSIONS = ['booking:read:clinic', 'booking:approve', 'booking:reschedule',
    'booking:no_show', 'settings:write', 'staff:manage', 'audit:read', 'analytics:clinic'];
  const ROLE_LABELS = { CLINIC_ADMIN: 'مالك العيادة', DOCTOR: 'الطبيب', RECEPTION: 'الاستقبال' };
  const state = {
    view: 'booking',
    staffPin: '',
    permissions: ALL_PERMISSIONS.slice(),
    role: 'CLINIC_ADMIN',
    staffName: '',
    selectedTime: '',
    selectedDay: '',
    slots: [],
    workDays: [],
    filled: {},
    demoMode: false,
    availabilityVerified: false,
    bookings: [],
    closures: [],
    busy: false
  };

  const DEMO_PIN = '2468';
  const DEMO_PIN_KEY = 'celia-kids-staff-pin-v1';
  const FALLBACK_SLOTS = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
  const WORK_DAYS = [0, 1, 2, 3, 4];
  // One source of truth for visit duration — the site, the demo backend and the
  // copy all read this table (Code.gs visitDuration_ is the live equivalent).
  // Rebuilt from the clinic's configured services (settings), never hardcoded in markup.
  // Visit durations live in SERVICES only. A second frozen table used to shadow it,
  // so changing a service's duration in settings did not change the booking maths.
  let SERVICES = [{ label: 'كشف جديد', minutes: 60 }, { label: 'متابعة', minutes: 30 }];
  // A price is displayed only when the clinic set one. There is no "0 EGP": an unset
  // price shows nothing, so the page never invents a fee (or a free visit).
  const priceLabel = (price) => {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) return '';
    return `${arabicNumber(value)} ج.م`;
  };
  const servicePrice = (label) => {
    const match = SERVICES.find((service) => service.label === label);
    return match ? Number(match.price) || 0 : 0;
  };
  const visitMinutes = (type) => {
    const match = SERVICES.find((service) => service.label === type);
    return (match && match.minutes) || (SERVICES[0] && SERVICES[0].minutes) || 60;
  };
  const arabicDigits = (value) => String(value).replace(/[0-9]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]);
  const minutesLabel = (minutes) => `${arabicDigits(minutes)} دقيقة`;
  const statusText = {
    REQUESTED: 'طلب مستلم',
    PENDING_APPROVAL: 'بانتظار موافقة العيادة',
    CONFIRMED: 'مؤكد من العيادة',
    RESCHEDULED: 'وقت بديل مقترح',
    CANCELLED: 'ملغي',
    COMPLETED: 'مكتمل'
  };

  /* ---------------- helpers ---------------- */
  const localISO = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  /* ---------------- clinic calendar (Africa/Cairo, not the visitor's) ---------------- */
  // A parent in Riyadh, London or New York must see the *clinic's* tomorrow. Reading the
  // date from the browser clock meant "غدًا · الأحد" could point at the wrong day, and a
  // time near midnight could shift the whole list by one.
  const CLINIC_TIME_ZONE = 'Africa/Cairo';
  const CLINIC_CLOCK = (() => {
    try {
      const format = new Intl.DateTimeFormat('en-CA', {
        timeZone: CLINIC_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
      });
      // en-CA yields YYYY-MM-DD, which is exactly the shape the rest of the app uses.
      const probe = format.format(new Date());
      return /^\d{4}-\d{2}-\d{2}$/.test(probe) ? format : null;
    } catch (_) { return null; }
  })();
  // Today at the clinic, as YYYY-MM-DD. Falls back to the browser clock only when the
  // runtime has no time-zone support (old WebView) — and says so through the same value.
  function clinicTodayISO() {
    if (CLINIC_CLOCK) return CLINIC_CLOCK.format(new Date());
    return localISO(new Date());
  }
  // Weekday of an ISO day, computed from the calendar date itself (no time zone maths,
  // so it is right regardless of where the visitor is).
  function isoWeekday(iso) {
    const parts = String(iso || '').split('-').map(Number);
    const probe = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return Number.isNaN(probe.getTime()) ? new Date().getDay() : probe.getUTCDay();
  }
  function isoToDate(iso) {
    const parts = String(iso || '').split('-').map(Number);
    return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12));
  }
  function shiftISO(iso, days) {
    const date = isoToDate(iso);
    date.setUTCDate(date.getUTCDate() + days);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }
  // Days between two ISO days.
  function daysBetweenISO(from, to) {
    return Math.round((isoToDate(to).getTime() - isoToDate(from).getTime()) / 86400000);
  }
  // A relative name for a day, counted from the clinic's today. Positional labels
  // ("tomorrow", "day 3") used to be glued to the chip index, so after a closed weekend
  // Sunday — three days away — was still announced as «غدًا».
  function relativeDayLabel(iso) {
    const gap = daysBetweenISO(clinicTodayISO(), iso);
    if (gap === 0) return 'اليوم';
    if (gap === 1) return 'غدًا';
    if (gap === 2) return 'بعد غد';
    if (gap > 2) return `بعد ${arabicDigits(gap)} أيام`;
    return 'موعد سابق';
  }
  function isoLabel(iso, options) {
    // The label is a calendar date, so it must not be rendered in the visitor's zone.
    try {
      return new Intl.DateTimeFormat('ar-EG', Object.assign({ timeZone: 'UTC' }, options)).format(isoToDate(iso));
    } catch (_) { return iso; }
  }

  // The Nth *open* day from today at the clinic. It used to jump every offset to the
  // same next open day, so the first chips all showed one date and couldn't be picked apart.
  // `openDays` is passed in by the caller (state.workDays), so this stays a pure function.
  function nextWorkdayISO(offset = 1, openDays = WORK_DAYS) {
    let iso = clinicTodayISO();
    let found = 0;
    for (let step = 1; step <= 90; step += 1) {
      iso = shiftISO(iso, 1);
      if (!openDays.includes(isoWeekday(iso))) continue;
      found += 1;
      if (found >= offset) break;
    }
    return iso;
  }
  // Kept as a Date for callers that format weekdays themselves.
  function nextWorkday(offset = 1, openDays = WORK_DAYS) {
    const iso = nextWorkdayISO(offset, openDays);
    const date = isoToDate(iso);
    date.setHours(12, 0, 0, 0);
    return date;
  }
  function prettyDate(iso) {
    if (!iso) return '—';
    const parts = String(iso).split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return '—';
    // Formatted in UTC on a date-only value: reading it as local time is what shifted the
    // weekday for visitors west of Cairo.
    return isoLabel(iso, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function prettyTime(time) {
    if (!time) return '';
    const [h, m] = time.split(':').map(Number);
    return new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit', hour12: true })
      .format(new Date(2020, 0, 1, h, m));
  }
  function digits(value) { return String(value || '').replace(/\D/g, ''); }
  function newRef() {
    const chunk = () => Math.random().toString(36).slice(2, 8).toUpperCase();
    return `CK-${chunk()}${chunk()}`;
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }
  function arabicNumber(value) {
    return Number(value || 0).toLocaleString('ar-EG');
  }
  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 3600);
  }

  /* ---------------- staff credentials ---------------- */
  // The PIN is never stored in clear text: the browser keeps a SHA-256 hash and
  // sends the hash, exactly like the Apps Script backend (Settings.gs).
  async function sha256Hex(text) {
    const value = String(text || '');
    // TextEncoder is looked up globally on purpose: jsdom and some older WebViews
    // expose it there rather than on `window`.
    const Encoder = (typeof TextEncoder !== 'undefined') ? TextEncoder : (window.TextEncoder || null);
    if (window.crypto && window.crypto.subtle && Encoder) {
      const digest = await window.crypto.subtle.digest('SHA-256', new Encoder().encode(value));
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    // Fallback for non-secure contexts: a small synchronous SHA-256.
    return sha256Fallback(value);
  }
  function sha256Fallback(text) {
    const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const Encoder = (typeof TextEncoder !== 'undefined') ? TextEncoder : (window.TextEncoder || null);
    const bytes = Encoder
      ? Array.from(new Encoder().encode(String(text)))
      : Array.from(unescape(encodeURIComponent(String(text)))).map((ch) => ch.charCodeAt(0));
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i -= 1) bytes.push((bitLength / Math.pow(2, 8 * i)) & 0xff);
    const rot = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
    for (let chunk = 0; chunk < bytes.length; chunk += 64) {
      const w = new Array(64).fill(0);
      for (let i = 0; i < 16; i += 1) w[i] = (bytes[chunk + i * 4] << 24) | (bytes[chunk + i * 4 + 1] << 16) | (bytes[chunk + i * 4 + 2] << 8) | bytes[chunk + i * 4 + 3];
      for (let i = 16; i < 64; i += 1) {
        const s0 = (rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i += 1) {
        const S1 = (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) >>> 0;
        const mj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  }
  function demoPinHash() {
    try { return localStorage.getItem(DEMO_PIN_KEY) || ''; } catch (_) { return ''; }
  }
  let sessionHash = '';
  // The demo mirrors a fresh deployment: until the documented demo PIN is replaced
  // through the settings screen, the dashboard keeps asking for a new one.
  const PIN_CHANGED_KEY = 'celia-kids-pin-changed-v1';
  function demoPinChanged() {
    try { return localStorage.getItem(PIN_CHANGED_KEY) === '1'; } catch (_) { return false; }
  }
  // Accepts the raw PIN (typed by the user) and turns it into the session hash.
  async function staffSession(rawPin) {
    const hash = await sha256Hex(rawPin);
    sessionHash = hash;
    return hash;
  }
  function configuredPinHash() { return demoPinHash(); }

  /* ---------------- settings catalog (demo mirror) ---------------- */
  // In the live deployment the catalog comes from getClinicSettings (Settings.gs).
  // The demo keeps the same shape so the screen is identical, and a saved value
  // behaves like the real one: it changes the page immediately.
  const SETTINGS_KEY = 'celia-kids-settings-v1';
  const DEMO_CATALOG = [
    { group: 'clinic', title: 'هوية العيادة', help: 'تظهر أعلى الصفحة وفي نتائج البحث.', fields: [
      { key: 'CLINIC_NAME', label: 'اسم العيادة', type: 'text', max: 60, required: true, help: 'كما يظهر لولي الأمر' },
      { key: 'CLINIC_PHONE', label: 'هاتف العيادة', type: 'phone', max: 22, help: 'اتركوه فارغًا إن لم يكن هناك رقم معلن' },
      { key: 'CLINIC_ADDRESS', label: 'العنوان', type: 'text', max: 120, help: 'العنوان الذي يظهر لولي الأمر' },
      { key: 'CLINIC_TIMELINE', label: 'سطر تعريفي قصير', type: 'text', max: 80, help: 'مثال: نخدم أطفال الجيزة منذ ٢٠١٤' }
    ] },
    { group: 'doctor', title: 'هوية الطبيب', help: 'أي حقل فارغ يُعرض على الصفحة كـ«غير منشور».', fields: [
      { key: 'DOCTOR_NAME', label: 'الاسم واللقب العلمي', type: 'text', max: 80 },
      { key: 'DOCTOR_TITLE', label: 'اللقب الوظيفي', type: 'text', max: 80, help: 'مثال: استشاري طب الأطفال وحديثي الولادة' },
      { key: 'DOCTOR_SUBSPECIALTY', label: 'التخصص الدقيق', type: 'text', max: 80 },
      { key: 'DOCTOR_LICENSE', label: 'رقم ترخيص مزاولة المهنة', type: 'text', max: 40, help: 'عند تعبئته تختفي شارة «لم يُتحقق بعد»' }
    ] },
    { group: 'hours', title: 'الدوام والمواعيد', help: 'ساعات العرض على الصفحة تُبنى من هذه القيم.', fields: [
      { key: 'WORK_DAYS', label: 'أيام العمل', type: 'weekdays', help: 'الأحد = ٠ … السبت = ٦' },
      { key: 'WEEKEND_DAYS', label: 'أيام الإغلاق الأسبوعي', type: 'weekdays', help: 'لا تتقاطع مع أيام العمل' },
      { key: 'WORK_START', label: 'بداية الدوام', type: 'time' },
      { key: 'WORK_END', label: 'نهاية الدوام', type: 'time' },
      { key: 'SLOT_MINUTES', label: 'الفاصل بين بدايات المواعيد', type: 'int', min: 5, max: 120, help: 'بالدقائق' }
    ] },
    { group: 'services', title: 'أنواع الزيارات ومدتها', help: 'تُبنى منها قائمة «نوع الزيارة» على الصفحة ومدة كل موعد.', fields: [
      { key: 'VISIT_SERVICES', label: 'أنواع الزيارات وأسعارها', type: 'services', help: 'سطر لكل نوع: الاسم = المدة بالدقائق = السعر (السعر اختياري، واتركوه فارغًا إن لم يكن معلنًا)' }
    ] },
    { group: 'retention', title: 'الخصوصية والاحتفاظ', help: 'تُعرض على صفحة الخصوصية المنشورة؛ تغييرها هنا يغيّر ما يقرأه ولي الأمر.', fields: [
      { key: 'RETENTION_MONTHS', label: 'مدة الاحتفاظ ببيانات الطلبات (بالأشهر)', type: 'int', min: 1, max: 60, help: 'بعدها تُحذف بيانات التواصل من الطلبات القديمة. القيمة نفسها تظهر على صفحة الخصوصية.' }
    ] },
    { group: 'security', title: 'رمز الدخول', help: 'لا يُخزَّن الرمز كما هو: يُخزَّن بصمته فقط.', fields: [
      { key: 'STAFF_PIN', label: 'رمز دخول جديد', type: 'pin', secret: true, help: '16 حرفًا على الأقل؛ لا يُعرض الرمز الحالي أبدًا' }
    ] }
  ];
  const SETTINGS_DEFAULTS = {
    CLINIC_NAME: 'Celia Kids', CLINIC_PHONE: '', CLINIC_ADDRESS: '', CLINIC_TIMELINE: '',
    DOCTOR_NAME: '', DOCTOR_TITLE: '', DOCTOR_SUBSPECIALTY: '', DOCTOR_LICENSE: '',
    WORK_DAYS: '0,1,2,3,4', WEEKEND_DAYS: '5,6', WORK_START: '09:00', WORK_END: '14:00', SLOT_MINUTES: '30',
    VISIT_SERVICES: 'كشف جديد = 60\nمتابعة = 30',
    RETENTION_MONTHS: '12'
  };
  function readSettingsStore() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return Object.assign({}, SETTINGS_DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    } catch (_) { return Object.assign({}, SETTINGS_DEFAULTS); }
  }
  function writeSettingsStore(values) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(values)); } catch (_) { /* private mode */ }
  }
  // «الاسم = المدة» or «الاسم = المدة = السعر». The demo mirrors the backend's rules, or a
  // price typed in the settings screen would vanish here. Same explicit split as
  // Settings.gs: a negative price must not be mistaken for a separator.
  function parseServices(text) {
    return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/\s*[=\-–—:]\s*/).map((part) => part.trim());
      if (parts.length < 2 || parts.length > 3) return null;
      if (!parts[0] || !/^\d{1,3}$/.test(parts[1])) return null;
      if (parts.length === 3 && !/^\d{1,6}$/.test(parts[2])) return null;
      return { label: parts[0], minutes: Number(parts[1]), price: parts.length === 3 ? Number(parts[2]) : 0 };
    }).filter(Boolean);
  }
  function servicesFromSettings(values) {
    const parsed = parseServices(values.VISIT_SERVICES);
    return parsed.length ? parsed : parseServices(SETTINGS_DEFAULTS.VISIT_SERVICES);
  }
  function formatServicesText(services) {
    return services.map((item) => `${item.label} = ${item.minutes}${item.price ? ` = ${item.price}` : ''}`).join('\n');
  }
  function demoProfile() {
    const values = readSettingsStore();
    return {
      ok: true,
      name: values.CLINIC_NAME,
      phone: values.CLINIC_PHONE,
      address: values.CLINIC_ADDRESS,
      license: values.DOCTOR_LICENSE,
      licenseVerified: !!values.DOCTOR_LICENSE,
      doctorName: values.DOCTOR_NAME,
      doctorRole: values.DOCTOR_TITLE,
      subspecialty: values.DOCTOR_SUBSPECIALTY,
      timeline: values.CLINIC_TIMELINE,
      services: servicesFromSettings(values),
      hours: {
        workDays: values.WORK_DAYS.split(',').filter(Boolean).map(Number),
        weekendDays: values.WEEKEND_DAYS.split(',').filter(Boolean).map(Number),
        start: values.WORK_START,
        end: values.WORK_END
      }
    };
  }

  /* ---------------- demo store ---------------- */
  function seedDemo() {
    try {
      const current = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (current && Array.isArray(current.bookings)) return current;
    } catch (_) { /* damaged demo data is rebuilt below */ }
    const initial = {
      bookings: [
        { reference: 'CK-DEMO-8K2P', createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL', visitType: 'كشف جديد', guardianName: 'مريم تجريبية', phone: '0000000000', day: nextWorkdayISO(1), time: '10:00', eventId: '', consent: true },
        { reference: 'CK-DEMO-4M7Q', createdAt: new Date().toISOString(), status: 'CONFIRMED', visitType: 'متابعة', guardianName: 'عمر تجريبي', phone: '0000000001', day: nextWorkdayISO(2), time: '11:00', eventId: '', consent: true }
      ],
      closures: []
    };
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(initial)); } catch (_) { /* private mode */ }
    return initial;
  }
  const demoStore = () => seedDemo();
  function saveDemo(store) {
    try { localStorage.setItem(DEMO_KEY, JSON.stringify(store)); } catch (_) { toast('تعذر حفظ العرض محليًا في هذا المتصفح.'); }
  }

  /* ---------------- backend bridge ---------------- */

  // A server call that never settles is the "sudden stop" the clinic actually feels:
  // Apps Script queues the request, the browser waits, and every button that was disabled
  // for it stays disabled while the guardian sees a spinner forever. The adapter keeps the
  // waits it can control short (Code.gs tryLock(25000), Llm.gs deadline), so anything past
  // this does not belong to us any more and must be reported, not waited on.
  // A deployment on a slow connection may need a longer window, so the value is a knob
  // (window.CELIA_CALL_TIMEOUT_MS) rather than a constant buried in the code — and a knob
  // is what lets the browser test assert the timeout behaviour without waiting 45 seconds.
  const CALL_TIMEOUT_MS = Math.max(1000, Number(window.CELIA_CALL_TIMEOUT_MS) || 45000);
  // Methods that change something. A timeout on one of these is ambiguous — the write may
  // have landed — so the copy never invites a blind retry; a read-only timeout is safe.
  const MUTATING_METHODS = new Set([
    'createRequest', 'approveRequest', 'proposeAlternative', 'moveConfirmedAppointment',
    'cancelRequest', 'completeRequest', 'closeDay', 'saveClinicSettings', 'saveStaffPin',
    'resetClinicSettings'
  ]);

  function callTimedOutError(method) {
    const error = new Error(MUTATING_METHODS.has(method)
      ? 'لم يصل ردّ الخادم خلال ' + Math.round(CALL_TIMEOUT_MS / 1000) + ' ثانية. لا تعيدوا الإرسال فورًا: افتحوا «طلب سابق» بالرقم المرجعي بعد قليل، أو راجعوا لوحة العيادة، قبل تكرار الإجراء.'
      : 'تأخر الاتصال بخدمة العيادة. تحققوا من الشبكة ثم أعيدوا المحاولة؛ لم يتغير شيء.');
    error.code = 'TIMEOUT';
    error.method = method;
    return error;
  }

  /**
   * Race a server call against a deadline. Only the first outcome counts: a late success
   * must not re-enable a button the user has already seen time out on.
   */
  function withDeadline(method, promise, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Logged without any payload: a booking carries a name and a phone number.
        try { console.warn(JSON.stringify({ app: 'celia-kids', component: 'ui', event: 'server_call_timeout', method, ms: timeoutMs })); } catch (_) { /* no console */ }
        reject(callTimedOutError(method));
      }, timeoutMs);
      promise.then((value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
    });
  }

  function callServer(method, ...args) {
    return withDeadline(method, new Promise((resolve, reject) => {
      try {
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler((error) => reject(new Error(error && error.message ? error.message : 'تعذر الاتصال بخدمة العيادة.')))
          [method](...args);
      } catch (error) { reject(error); }
    }));
  }
  function isStaffSession(pin) {
    const configured = demoPinHash();
    return !!configured && String(pin || '') === configured;
  }
  async function api(method, ...args) {
    if (IS_GAS) return callServer(method, ...args);
    // Demo mode answers from localStorage, but a denial-of-service from the screen is the
    // same defect either way (a hung demo hides the same bug), so the deadline is kept.
    if (method === 'getClinicProfile') { state.demoMode = true; return demoProfile(); }
    const store = demoStore();
    if (method === 'getAvailableSlots') {
      const day = args[0];
      // Work in whole minutes: `visitType` here is the *service* visit type.
      const values = readSettingsStore();
      const visitType = args[1] || servicesFromSettings(values)[0].label;
      const visitDuration = visitMinutes(visitType);
      if (store.closures.some((item) => item.day === day)) return { ok: true, slots: [] };
      const parts = String(day).split('-').map(Number);
      const weekday = isoWeekday(day);
      const workDays = values.WORK_DAYS.split(',').filter(Boolean).map(Number);
      if (!workDays.includes(weekday)) return { ok: true, slots: [] };
      const toMin = (t) => Number(String(t).split(':')[0]) * 60 + Number(String(t).split(':')[1]);
      const start = toMin(values.WORK_START);
      const end = toMin(values.WORK_END);
      const step = Number(values.SLOT_MINUTES) || 30;
      const duration = visitDuration;
      const toTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const toMinutes = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + m; };
      const busy = store.bookings
        .filter((item) => item.day === day && ['CONFIRMED', 'COMPLETED'].includes(item.status))
        .map((item) => ({ start: toMinutes(item.time), end: toMinutes(item.time) + visitMinutes(item.visitType) }));
      const slots = [];
      // A start is only offered when the visit ends inside the last block that actually
      // begins during opening hours (see paddedStartIndex_ in Code.gs for the rule and
      // the 45-minute/30-minute example it fixes).
      const pause = (end - start) % duration;
      const lastStart = end - duration - pause;
      for (let minute = start; minute <= lastStart; minute += step) {
        const clash = busy.some((span) => minute < span.end && span.start < minute + duration);
        if (!clash) slots.push(toTime(minute));
      }
      return { ok: true, slots };
    }
    if (method === 'createRequest') {
      const payload = args[0];
      const booked = store.bookings.some((item) => item.day === payload.day && item.time === payload.time && item.status === 'CONFIRMED');
      if (booked) return { ok: false, message: 'اختير هذا الوقت للتو. يرجى اختيار وقت آخر.' };
      // Same rule as findOpenDuplicate_ in Code.gs: one open request per phone per day.
      const wanted = String(payload.phone || '').replace(/\D/g, '');
      const open = ['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'];
      const duplicate = store.bookings.find((item) => open.includes(item.status)
        && item.day === payload.day
        && String(item.phone || '').replace(/\D/g, '') === wanted && wanted.length >= 8);
      if (duplicate) {
        return { ok: false, duplicate: true, reference: duplicate.reference,
          message: `لديكم طلب قائم لهذا اليوم بالرقم ${duplicate.reference}. تابعوه من «طلب سابق» أو انتظروا تأكيد العيادة.` };
      }
      const phoneKey = String(payload.phone || '').replace(/\D/g, '');
      const sentToday = store.bookings.filter((item) => item.day === payload.day
        && String(item.phone || '').replace(/\D/g, '') === phoneKey).length;
      // Mirrors CK.MAX_REQUESTS_PER_PHONE_DAY in Code.gs.
      if (sentToday >= 3) {
        return { ok: false, rateLimited: true,
          message: 'وصلتم إلى الحد الأقصى للطلبات لهذا اليوم من هذا الرقم. تواصلوا مع العيادة هاتفيًا لتعديل موعدكم.' };
      }
      const verified = state.availabilityVerified;
      const booking = { ...payload, reference: newRef(), createdAt: new Date().toISOString(),
        status: verified ? 'PENDING_APPROVAL' : 'REQUESTED', slotVerified: verified, eventId: '', consent: true };
      store.bookings.unshift(booking);
      saveDemo(store);
      return { ok: true, booking, savedLocally: true };
    }
    if (method === 'lookupBooking') {
      const ref = String(args[0] || '').trim().toUpperCase();
      const booking = store.bookings.find((item) => item.reference.toUpperCase() === ref);
      return booking
        ? { ok: true, booking: { reference: booking.reference, day: booking.day, time: booking.time, status: booking.status } }
        : { ok: false, message: 'لم نعثر على طلب بهذا الرقم.' };
    }
    if (method === 'getPrivacyNotice') {
      const values = readSettingsStore();
      return {
        ok: true,
        clinicName: values.CLINIC_NAME || '',
        phone: String(values.CLINIC_PHONE || '').replace(/[^0-9+]/g, ''),
        address: values.CLINIC_ADDRESS || '',
        retentionMonths: Number(values.RETENTION_MONTHS) > 0 ? Number(values.RETENTION_MONTHS) : 12,
        deletionChannels: String(values.CLINIC_PHONE || '').replace(/\D/g, '').length >= 6 ? ['phone'] : []
      };
    }
    if (method === 'lookupOwnRequest' || method === 'deleteOwnRequestData') {
      // The demo mirrors the live rule: a reference alone never reveals a request.
      const ref = String(args[0] || '').trim().toUpperCase();
      const phone = String(args[1] || '').replace(/\D/g, '');
      const record = store.bookings.find((item) => item.reference.toUpperCase() === ref);
      if (!record || phone.length < 8 || String(record.phone || '').replace(/\D/g, '') !== phone) {
        return { ok: false, message: 'لا يوجد طلب مطابق لهذا الرقم المرجعي وهذا الهاتف.' };
      }
      if (method === 'lookupOwnRequest') {
        return { ok: true, booking: { reference: record.reference, status: record.status,
          visitType: record.visitType, day: record.day, time: record.time,
          slotVerified: !!record.slotVerified, retentionMonths: Number(readSettingsStore().RETENTION_MONTHS) || 12 } };
      }
      // Demo mode has no calendar, so a confirmed visit is the equivalent commitment.
      if (record.status === 'CONFIRMED') {
        return { ok: false, message: 'هذا الموعد ما زال مؤكدًا في جدول العيادة. اطلبوا إلغاءه أولًا ثم احذفوا البيانات.' };
      }
      record.guardianName = '';
      record.phone = '';
      record.status = 'DELETED';
      record.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking: { reference: record.reference, status: 'DELETED' } };
    }
    if (method === 'getHealthReport') {
      if (!isStaffSession(args[0])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const months = Number(readSettingsStore().RETENTION_MONTHS) || 12;
      return { ok: true, report: {
        ok: true,
        started: new Date().toISOString(),
        checks: [
          { id: 'config', ok: true, detail: '' },
          { id: 'sheets', ok: true, detail: 'وضع تجريبي: الطلبات محفوظة في هذا المتصفح فقط' },
          { id: 'calendar', ok: true, detail: 'وضع تجريبي: لا يتصل بتقويم حقيقي' },
          { id: 'queues', ok: true, detail: '0/25 · 0/100' },
          { id: 'staff_pin', ok: true, detail: '' },
          { id: 'retention', ok: months >= 1, detail: `${months} شهر` },
          { id: 'last_purge', ok: true, detail: 'لا ينطبق في العرض التجريبي' }
        ],
        counters: { requests: store.bookings.length, queued_requests: 0, queued_audits: 0, retention_months: months },
        last_staff_action: '',
        staff_action_age_days: null
      } };
    }
    if (method === 'getDashboard') {
      if (!isStaffSession(args[0])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      return { ok: true, bookings: store.bookings, closures: store.closures, warnings: [] };
    }
    if (method === 'approveRequest') {
      if (!isStaffSession(args[1])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking || !['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(booking.status)) return { ok: false, message: 'تعذر اعتماد هذا الطلب.' };
      const collision = store.bookings.some((item) => item.reference !== booking.reference && item.day === booking.day && item.time === booking.time && item.status === 'CONFIRMED');
      if (collision) return { ok: false, message: 'هذا الوقت لم يعد متاحًا.' };
      booking.status = 'CONFIRMED';
      booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'proposeAlternative') {
      if (!isStaffSession(args[3])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      const conflict = store.bookings.some((item) => item.reference !== args[0] && item.day === args[1] && item.time === args[2] && item.status === 'CONFIRMED');
      if (!booking || conflict) return { ok: false, message: conflict ? 'الوقت البديل مشغول.' : 'الطلب غير موجود.' };
      booking.day = args[1]; booking.time = args[2]; booking.status = 'RESCHEDULED'; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'cancelRequest') {
      if (!isStaffSession(args[2])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking) return { ok: false, message: 'الطلب غير موجود.' };
      booking.status = 'CANCELLED'; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'completeRequest') {
      if (!isStaffSession(args[1])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking) return { ok: false, message: 'الطلب غير موجود.' };
      booking.status = 'COMPLETED'; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'moveConfirmedAppointment') {
      if (!isStaffSession(args[4])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      const conflict = store.bookings.some((item) => item.reference !== args[0] && item.day === args[1] && item.time === args[2] && item.status === 'CONFIRMED');
      if (!booking || conflict) return { ok: false, message: conflict ? 'الوقت البديل مشغول.' : 'الطلب غير موجود.' };
      booking.day = args[1]; booking.time = args[2]; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'closeDay') {
      if (!isStaffSession(args[2])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      if (!store.closures.some((item) => item.day === args[0])) store.closures.push({ day: args[0], label: args[1] || 'إغلاق يوم' });
      saveDemo(store);
      return { ok: true };
    }

    if (method === 'getClinicSettings') {
      if (!isStaffSession(args[0])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const values = readSettingsStore();
      const catalog = DEMO_CATALOG.map((group) => ({ group: group.group, title: group.title, help: group.help,
        fields: group.fields.map((field) => Object.assign({}, field)) }));
      return { ok: true, version: 1, catalog, values: Object.assign({}, values, { STAFF_PIN: '' }),
        meta: { staffPinConfigured: !!demoPinHash(), staffPinHashed: true, minPinLength: 16, demo: true,
          mustChangePin: !demoPinChanged() } };
    }
    if (method === 'saveClinicSettings') {
      if (!isStaffSession(args[1])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const payload = args[0] || {};
      const input = payload.values || {};
      const known = {};
      DEMO_CATALOG.forEach((group) => group.fields.forEach((field) => { known[field.key] = field; }));
      const unknown = Object.keys(input).filter((key) => !known[key]);
      if (unknown.length) return { ok: false, message: 'حقول غير معروفة: ' + unknown.join(', ') };
      const values = readSettingsStore();
      const problems = [];
      Object.keys(input).forEach((key) => {
        const field = known[key];
        const raw = String(input[key] === null || input[key] === undefined ? '' : input[key]).trim();
        if (field.type === 'pin') { problems.push('تغيير الرمز له مسار منفصل.'); return; }
        if (field.type === 'text' || field.type === 'phone') {
          if (!raw && field.required) problems.push(field.label + ' مطلوب.');
          else if (raw.length > (field.max || 80)) problems.push(field.label + ' أطول من المسموح.');
          values[key] = field.type === 'phone' ? raw.replace(/[^0-9+]/g, '') : raw;
          return;
        }
        if (field.type === 'time') { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) problems.push(field.label + ' يجب أن تكون بصيغة HH:MM.'); else values[key] = raw; return; }
        if (field.type === 'int') {
          const number = Number(raw);
          if (!Number.isInteger(number) || number < (field.min || 1) || number > (field.max || 999)) problems.push(field.label + ' يجب أن يكون رقمًا بين ' + (field.min || 1) + ' و' + (field.max || 999) + '.');
          else values[key] = String(number);
          return;
        }
        if (field.type === 'weekdays') { values[key] = raw.split(',').map((v) => Number(v.trim())).filter((v) => Number.isInteger(v) && v >= 0 && v <= 6).sort().join(','); return; }
        if (field.type === 'services') {
          const parsed = parseServices(raw);
          if (!parsed.length) problems.push('أضيفوا نوع زيارة واحدًا على الأقل بالصيغة: الاسم = المدة.');
          else if (parsed.some((item) => item.minutes < 5 || item.minutes > 240)) problems.push('مدة الزيارة يجب أن تكون بين ٥ و٢٤٠ دقيقة.');
          else values[key] = formatServicesText(parsed);
          return;
        }
      });
      if (problems.length) return { ok: false, message: problems.join(' ') };
      const start = values.WORK_START; const end = values.WORK_END;
      const toMinutes = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
      if (toMinutes(start) >= toMinutes(end)) return { ok: false, message: 'بداية الدوام يجب أن تسبق نهايته.' };
      const work = values.WORK_DAYS.split(',').filter(Boolean);
      if (!work.length) return { ok: false, message: 'اختاروا يوم عمل واحدًا على الأقل.' };
      const overlap = work.filter((day) => values.WEEKEND_DAYS.split(',').includes(day));
      if (overlap.length) return { ok: false, message: 'أيام العمل وأيام الإغلاق تتقاطع.' };
      const longest = servicesFromSettings(values).reduce((max, item) => Math.max(max, item.minutes), 0);
      if (longest > toMinutes(end) - toMinutes(start)) return { ok: false, message: 'أطول زيارة أطول من نافذة الدوام.' };
      writeSettingsStore(values);
      applyClinicProfile(demoProfile());
      refreshVisitTypes();
      return { ok: true, saved: Object.keys(input), warning: '', settings: null };
    }
    if (method === 'saveStaffPin') {
      if (!isStaffSession(args[2])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      if (!isStaffSession(args[0])) return { ok: false, message: 'الرمز الحالي غير صحيح.' };
      const next = String(args[1] || '');
      if (next.length < 16) return { ok: false, message: 'الرمز الجديد يجب أن يكون 16 حرفًا على الأقل.' };
      try {
        localStorage.setItem(DEMO_PIN_KEY, next);
        localStorage.setItem(PIN_CHANGED_KEY, '1');
      } catch (_) { return { ok: false, message: 'تعذر حفظ الرمز في هذا المتصفح.' }; }
      return { ok: true, warning: '' };
    }
    if (method === 'resetClinicSettings') {
      if (!isStaffSession(args[1])) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const values = Object.assign({}, SETTINGS_DEFAULTS);
      writeSettingsStore(values);
      applyClinicProfile(demoProfile());
      refreshVisitTypes();
      return { ok: true, settings: null };
    }
    if (method === 'askGeneralQuestion') {
      return { ok: true, answer: 'هذا وضع عرض تجريبي بلا مساعد حقيقي: فريق العيادة هو من يجيب عن خطوات الحجز وتعديل الطلب. لا تُقدَّم هنا معلومات طبية ولا تشخيص.' };
    }
    return { ok: false, message: 'هذه الوظيفة غير متاحة في العرض.' };
  }

  /* ---------------- shell chrome ---------------- */
  function setView(view) {
    state.view = view;
    const booking = $('#bookingView');
    const staff = $('#staffView');
    booking.hidden = view !== 'booking';
    staff.hidden = view !== 'staff';
    $$('[data-view]').forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (button.classList.contains('nav-button')) {
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    });
    if (view === 'staff' && state.staffPin) refreshDashboard();
    // Keep the visible panel in view instead of jumping to the top of the page.
    const target = view === 'staff' ? staff : booking;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    }
  }
  function setMode() {
    const modeLabel = $('#modeLabel');
    if (modeLabel) modeLabel.textContent = IS_GAS ? 'الطلبات تصل إلى العيادة' : 'وضع تجريبي';
    if ($('#modePill')) $('#modePill').classList.toggle('live', IS_GAS);
    if ($('#environmentBanner')) $('#environmentBanner').hidden = IS_GAS;
    // The demo staff PIN is only ever visible in the demo build, inside the staff view.
    if ($('#demoPinHint')) $('#demoPinHint').hidden = IS_GAS;
    // Never name the model provider on a patient-facing page.
    if ($('#geminiStatus')) $('#geminiStatus').textContent = IS_GAS ? 'مساعد إداري' : 'وضع تجريبي';
    if (IS_GAS && $('#availabilityNote')) $('#availabilityNote').textContent = '';
  }

  /* ---------------- live clinic facts ---------------- */
  // The page ships with neutral placeholders; a live clinic fills them from its
  // own configuration (getClinicProfile) so no credential is ever invented here.
  // Public clinic metadata (name/domain) lives with the static site — it is not a
  // secret. The licence number is NOT in this file: it is a regulated credential
  // and must come from the clinic's own configuration (getClinicProfile).
  const CLINIC_FALLBACK = {
    name: 'Celia Kids',
    phone: 'يُضاف من إعداد العيادة',
    address: 'يُضاف من إعداد العيادة',
    subspecialty: 'طب أطفال عام',
    hours: { workDays: [0, 1, 2, 3, 4], weekendDays: [5, 6], start: '09:00', end: '14:00' },
    license: ''
  };
  const HOURS_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const arabicDate = (value) => String(value).replace(/[0-9]/g, (digit) => '٠١٢٣٤٥٦٧٨٩'[Number(digit)]);
  function formatClock(time) {
    const parts = String(time || '09:00').split(':');
    const hour = Number(parts[0]);
    const minute = parts[1] || '00';
    const suffix = hour < 12 ? 'ص' : 'م';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${arabicDate(hour12)}:${arabicDate(minute)} ${suffix}`;
  }
  // Mirrors formatClinicHours_ in Code.gs: a range is only claimed when the
  // working days really are consecutive.
  function formatHours(spec) {
    const work = (spec.workDays || []).slice().sort((a, b) => a - b);
    const weekend = (spec.weekendDays || []).slice().sort((a, b) => a - b);
    const consecutive = work.every((day, index) => index === 0 || day === work[index - 1] + 1);
    const dayLabel = !work.length ? ''
      : consecutive && work.length > 1 ? `${HOURS_DAYS[work[0]]} – ${HOURS_DAYS[work[work.length - 1]]}`
        : work.map((day) => HOURS_DAYS[day]).join('، ');
    const closed = !weekend.length ? ''
      : weekend.length === 2 && weekend[1] === weekend[0] + 1
        ? ` · ${HOURS_DAYS[weekend[0]]} و${HOURS_DAYS[weekend[1]]} مغلقان`
        : ` · مغلق: ${weekend.map((day) => HOURS_DAYS[day]).join('، ')}`;
    return `${dayLabel ? `${dayLabel} · ` : ''}${formatClock(spec.start)} – ${formatClock(spec.end)}${closed}`;
  }
  function setFact(key, value) {
    $$(`[data-config="${key}"]`).forEach((node) => { node.textContent = value; });
  }
  // A parent on a phone should not have to copy a number by hand: every "call the
  // clinic" instruction on the page becomes a tappable tel: link. No number, no link.
  const PHONE_LINK = /^\+?[0-9\s-]{6,22}$/;
  function telHref(phone) {
    const raw = String(phone || '').trim();
    if (!PHONE_LINK.test(raw)) return '';
    const digits = raw.replace(/[^0-9+]/g, '');
    return digits.replace(/\D/g, '').length >= 6 ? `tel:${digits}` : '';
  }
  // A neutral opener: no name, no symptom, no appointment details. The parent decides
  // what to write; we only save them the step of finding the number.
  const WHATSAPP_OPENER = 'السلام عليكم، أرغب في الاستفسار عن موعد.';
  function setWhatsApp(phone) {
    const digitsOnly = String(phone || '').replace(/\D/g, '');
    const usable = digitsOnly.length >= 8;
    const links = $$('#whatsappLink, #whatsappLinkAccess');
    links.forEach((link) => {
      const holder = link.closest('p');
      if (!usable) { if (holder) holder.hidden = true; link.removeAttribute('href'); return; }
      link.href = `https://wa.me/${digitsOnly}?text=${encodeURIComponent(WHATSAPP_OPENER)}`;
      link.setAttribute('aria-label', `مراسلة العيادة على واتساب على ${phone}`);
      if (holder) holder.hidden = false;
    });
  }
  function setPhone(phone) {
    setWhatsApp(phone);
    const href = telHref(phone);
    $$('[data-config="phone"]').forEach((node) => {
      if (!href) { node.textContent = phone || 'يُضاف من إعداد العيادة'; return; }
      const link = document.createElement('a');
      link.href = href;
      link.className = 'phone-link ltr';
      link.textContent = phone;
      link.setAttribute('dir', 'ltr');
      // Screen readers read the digits; the label says what tapping it does.
      link.setAttribute('aria-label', `اتصل بالعيادة على ${phone}`);
      node.replaceChildren(link);
    });
  }

  /* ---------------- published clinic facts (stage A) ---------------- */
  // Until a clinic runs the full Apps Script deployment, the public site can still carry
  // its real phone and name — otherwise "the site is ready" only means "a form exists".
  // clinic.json is a plain, non-secret file next to this script. Every field is optional:
  // an empty value stays empty, the page never invents a number, and a missing or broken
  // file changes nothing at all.
  function applyPublishedClinic(data) {
    if (!data || typeof data !== 'object') return;
    const text = (value) => String(value === undefined || value === null ? '' : value).trim();
    const name = text(data.clinicName);
    const phone = text(data.phone) || text(data.whatsapp);
    const address = text(data.address);
    const doctor = text(data.doctorName);
    const licence = text(data.license);
    if (!name && !phone && !address && !doctor && !licence) return;
    // Announced facts only: the visit services and hours keep coming from the settings,
    // because a published file must never be able to invent a booking slot.
    if (name) { setFact('clinicName', name); state.clinicName = name; }
    if (phone) { setPhone(phone); state.filled = Object.assign({}, state.filled, { phone: true }); }
    if (address) { setFact('address', address); state.filled = Object.assign({}, state.filled, { address: true }); }
    // The doctor's identity travels in the same file: in stage A there is no deployment
    // behind the page, so a fact that is not published here does not exist at all.
    if (doctor) { setFact('doctorName', doctor); state.filled = Object.assign({}, state.filled, { doctorName: true }); }
    if (licence) { setLicence(licence, true); state.filled = Object.assign({}, state.filled, { license: true, licenseVerified: true }); }
    // A name supplied here counts as announced for the onboarding banner, which otherwise
    // keeps claiming the page "still shows examples" after the clinic filled this file.
    if (name) state.filled = Object.assign({}, state.filled, { name: true });
    renderPlaceholders();
    renderOnboarding();
  }
  async function loadPublishedClinicFacts() {
    try {
      const response = await fetch('clinic.json', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      // `demoMode: false` means the clinic claims this as its real page: the demo badge must
      // disappear, or the page understates itself. Absent/true keeps the badge.
      if (data && data.demoMode === false) {
        $$('[data-demo-badge]').forEach((node) => { node.hidden = true; });
      }
      applyPublishedClinic(data);
    } catch (_) { /* a static file that is optional by design: silence is correct */ }
  }

  /* ---------------- onboarding: is the page still showing examples? ---------------- */
  // A page that silently ships example names and default hours is a misrepresentation,
  // not a placeholder. These are the facts a real clinic must supply before the page
  // can introduce itself; the dashboard shows a banner until each one is filled.
  const REQUIRED_FACTS = [
    { key: 'CLINIC_NAME', label: 'اسم العيادة' },
    { key: 'CLINIC_PHONE', label: 'هاتف العيادة' },
    { key: 'DOCTOR_NAME', label: 'اسم الطبيب' },
    { key: 'DOCTOR_TITLE', label: 'اللقب العلمي' },
    { key: 'DOCTOR_LICENSE', label: 'رقم الترخيص' }
  ];
  // Driven by the profile alone, so the banner can render the moment the page loads
  // instead of waiting for staff to open the settings screen.
  const DEFAULT_CLINIC_NAME = 'Celia Kids';
  function missingFacts() {
    const filled = state.filled || {};
    const project = {
      CLINIC_NAME: filled.name && state.clinicName !== DEFAULT_CLINIC_NAME,
      CLINIC_PHONE: filled.phone,
      DOCTOR_NAME: filled.doctorName,
      DOCTOR_TITLE: filled.doctorRole,
      DOCTOR_LICENSE: filled.license
    };
    return REQUIRED_FACTS.filter((fact) => !project[fact.key]);
  }
  // Public rendering: neutral placeholders wherever the clinic has not filled a fact.
  // This runs on every profile load, whether or not staff ever open the dashboard.
  function renderPlaceholders() {
    const filled = state.filled || {};
    if (!filled.phone) setWhatsApp('');
    if (!filled.doctorName) setFact('doctorName', 'بيانات الطبيب لم تُسجَّل بعد');
    if (!filled.doctorRole) setFact('doctorRole', 'اللقب العلمي يُسجَّل من الإعداد');
    if (!filled.subspecialty) setFact('subspecialty', 'طب الأطفال');
    if (!filled.address) setFact('address', 'يُضاف من إعداد العيادة');
  }
  // Dashboard rendering: the page still introduces itself with examples.
  function renderOnboarding() {
    const banner = $('#onboardingBanner');
    if (!banner) return;
    const missing = missingFacts();
    banner.hidden = missing.length === 0;
    const list = $('#onboardingMissing');
    if (list) list.textContent = missing.length ? `الناقص: ${missing.map((fact) => fact.label).join(' · ')}` : '';
    // The one-click demo is a published sample, so it is offered in demo mode only —
    // in a real deployment it would fill a clinic's page with another clinic's details.
    const demoButton = $('#onboardingDemo');
    if (demoButton) demoButton.hidden = !(settingsState.meta.demo || state.demoMode);
  }
  function setLicence(value, verified) {
    setFact('license', value || 'غير منشور');
    $$('[data-license-state]').forEach((node) => {
      node.textContent = verified
        ? 'رقم الترخيص كما سجّلته العيادة'
        : 'لم تُسجَّل بعد — تُكتب من إعداد العيادة';
      node.classList.toggle('is-unverified', !verified);
    });
    const card = $('.doctor-card');
    if (card) card.dataset.licenseVerified = verified ? 'true' : 'false';
  }
  // Which facts did the clinic actually fill? Anything absent keeps a neutral
  // placeholder: the page must never present an example as a clinic's own data.
  const PROFILE_TEXT_KEYS = ['name', 'phone', 'address', 'doctorName', 'doctorRole', 'subspecialty', 'timeline'];
  function applyClinicProfile(profile) {
    if (!profile || !profile.ok) return;
    const filled = {};
    PROFILE_TEXT_KEYS.forEach((key) => { filled[key] = String(profile[key] || '').trim() !== ''; });
    filled.license = String(profile.license || '').trim() !== '';
    state.filled = filled;
    state.workDays = (profile.hours && Array.isArray(profile.hours.workDays) && profile.hours.workDays.length)
      ? profile.hours.workDays.slice()
      : WORK_DAYS;
    state.clinicName = profile.name || '';
    if (profile.phone) setPhone(profile.phone);
    if (profile.address) setFact('address', profile.address);
    if (profile.doctorName) setFact('doctorName', profile.doctorName);
    if (profile.doctorRole) setFact('doctorRole', profile.doctorRole);
    if (profile.subspecialty) setFact('subspecialty', profile.subspecialty);
    if (profile.hours) setFact('hours', typeof profile.hours === 'string' ? profile.hours : formatHours(profile.hours));
    if (profile.name) setFact('clinicName', profile.name);
    if (profile.timeline) setFact('timeline', profile.timeline);
    // The licence is a regulated credential: show it only when the clinic set it,
    // and say so plainly when it is still unverified.
    setLicence(profile.license, !!profile.licenseVerified);
    renderPlaceholders();
    renderOnboarding();
    const schema = $('script[type="application/ld+json"]');
    if (schema && profile.doctorName) {
      try {
        const data = JSON.parse(schema.textContent);
        const physician = (data['@graph'] || []).find((node) => node['@type'] === 'Physician');
        if (physician) {
          physician.name = profile.doctorName;
          if (profile.doctorRole) physician.jobTitle = profile.doctorRole;
          if (profile.licenseVerified && profile.license) physician.identifier = { '@type': 'PropertyValue', name: 'ترخيص مزاولة المهنة', value: profile.license };
          schema.textContent = JSON.stringify(data);
        }
      } catch (_) { /* structured data stays as served */ }
    }
  }
  async function loadClinicProfile() {
    if (!IS_GAS) return; // the demo build keeps the neutral placeholders visible
    try {
      const profile = await api('getClinicProfile');
      applyClinicProfile(profile);
    } catch (_) { /* placeholders stay; they never claim facts */ }
  }

  /* ---------------- visit types (from settings) ---------------- */
  function renderVisitTypes() {
    const grid = $('.choice-grid');
    const form = $('#bookingForm');
    if (!grid || !form || !form.elements.visitType) return;
    const current = form.elements.visitType.value;
    grid.replaceChildren();
    SERVICES.forEach((service, index) => {
      const card = document.createElement('label');
      card.className = 'choice-card';
      card.dataset.choice = `service-${index}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'visitType';
      input.value = service.label;
      input.checked = service.label === current || (!current && index === 0);
      const icon = document.createElement('span');
      icon.className = 'choice-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = `<svg><use href="#${index === 1 ? 'i-visit' : 'i-steth'}"/></svg>`;
      const text = document.createElement('span');
      text.className = 'choice-text';
      const strong = document.createElement('strong');
      strong.textContent = service.label;
      const small = document.createElement('small');
      const price = priceLabel(service.price);
      small.textContent = price
        ? `${minutesLabel(service.minutes)} للزيارة · ${price}`
        : `${minutesLabel(service.minutes)} للزيارة`;
      text.append(strong, small);
      const radio = document.createElement('span');
      radio.className = 'radio-indicator';
      radio.setAttribute('aria-hidden', 'true');
      card.append(input, icon, text, radio);
      card.classList.toggle('selected', input.checked);
      grid.appendChild(card);
    });
    syncSummary();
    syncProgress();
  }
  function applyServices(services) {
    if (!Array.isArray(services) || !services.length) return;
    SERVICES = services
      .map((item) => ({ label: String(item.label || '').trim(), minutes: Number(item.minutes), price: Number(item.price) || 0 }))
      .filter((item) => item.label && Number.isFinite(item.minutes) && item.minutes > 0);
    if (!SERVICES.length) return;
    renderVisitTypes();
  }
  async function refreshVisitTypes() {
    try {
      const profile = IS_GAS ? await api('getClinicProfile') : demoProfile();
      if (profile && profile.ok) { applyClinicProfile(profile); if (profile.services) applyServices(profile.services); }
    } catch (_) { /* keep the last known services */ }
  }

  /* ---------------- settings screen (catalog-driven) ---------------- */
  const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const settingsState = { catalog: [], values: {}, meta: {}, group: 'clinic', loaded: false, busy: false };

  function settingsFieldNode(field, value) {
    const wrap = document.createElement('label');
    wrap.className = 'settings-field';
    wrap.dataset.key = field.key;
    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = field.label;
    wrap.appendChild(label);
    let input;
    if (field.type === 'weekdays') {
      input = document.createElement('div');
      input.className = 'weekday-picker';
      const selected = String(value || '').split(',').filter(Boolean);
      DAY_NAMES.forEach((name, index) => {
        const chip = document.createElement('label');
        chip.className = 'weekday-chip';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = String(index);
        box.checked = selected.includes(String(index));
        const text = document.createElement('span');
        text.textContent = name;
        chip.append(box, text);
        input.appendChild(chip);
      });
    } else if (field.type === 'services') {
      input = document.createElement('textarea');
      input.rows = 4;
      input.value = value || '';
      input.placeholder = 'كشف جديد = 60';
      input.spellcheck = false;
    } else if (field.type === 'pin') {
      input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'new-password';
      input.minLength = 16;
      input.placeholder = 'اتركوه فارغًا للإبقاء على الرمز الحالي';
    } else {
      input = document.createElement('input');
      input.type = field.type === 'time' ? 'time' : field.type === 'int' ? 'number' : field.type === 'phone' ? 'tel' : 'text';
      if (field.type === 'int') { input.min = field.min || 1; input.max = field.max || 999; input.step = 1; }
      if (field.max) input.maxLength = field.max;
      input.value = value || '';
      if (field.type === 'phone' || field.type === 'time') input.dir = 'ltr';
    }
    input.id = `setting-${field.key}`;
    input.name = field.key;
    if (field.required) input.required = true;
    wrap.appendChild(input);
    if (field.help) {
      const help = document.createElement('span');
      help.className = 'settings-help';
      help.textContent = field.help;
      wrap.appendChild(help);
    }
    if (field.type === 'pin') {
      const extra = document.createElement('div');
      extra.className = 'settings-field settings-field-inline';
      const extraLabel = document.createElement('span');
      extraLabel.className = 'settings-label';
      extraLabel.textContent = 'الرمز الحالي (مطلوب للتغيير)';
      const current = document.createElement('input');
      current.type = 'password';
      current.id = 'setting-CURRENT_PIN';
      current.autocomplete = 'current-password';
      const help = document.createElement('span');
      help.className = 'settings-help';
      help.textContent = 'لا يمكن قراءة الرمز الحالي من الواجهة؛ يُطلب للتأكد قبل التغيير.';
      extra.append(extraLabel, current, help);
      wrap.dataset.pin = 'true';
      wrap.appendChild(extra);
    }
    return wrap;
  }

  function renderSettingsGroup(groupKey) {
    settingsState.group = groupKey;
    $$('#settingsGroups .settings-group').forEach((chip) => {
      const active = chip.dataset.group === groupKey;
      chip.classList.toggle('active', active);
      if (active) chip.setAttribute('aria-current', 'true'); else chip.removeAttribute('aria-current');
    });
    const group = settingsState.catalog.find((item) => item.group === groupKey);
    const fields = $('#settingsFields');
    if (!group || !fields) return;
    fields.replaceChildren();
    const head = document.createElement('p');
    head.className = 'settings-group-help';
    head.textContent = group.help || '';
    fields.appendChild(head);
    group.fields.forEach((field) => fields.appendChild(settingsFieldNode(field, settingsState.values[field.key])));
    const form = $('#settingsForm');
    if (form) form.hidden = false;
    hideSettingsMessages();
  }
  function hideSettingsMessages() {
    const error = $('#settingsError');
    if (error) { error.hidden = true; error.textContent = ''; }
    const saved = $('#settingsSaved');
    if (saved) saved.hidden = true;
  }
  function renderSettings(payload) {
    settingsState.catalog = payload.catalog || [];
    settingsState.values = payload.values || {};
    settingsState.meta = payload.meta || {};
    settingsState.loaded = true;
    const container = $('#settingsGroups');
    if (!container) return;
    container.replaceChildren();
    settingsState.catalog.forEach((group) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'settings-group';
      chip.dataset.group = group.group;
      chip.textContent = group.title;
      chip.addEventListener('click', () => renderSettingsGroup(group.group));
      container.appendChild(chip);
    });
    const version = $('#settingsVersion');
    if (version) version.textContent = settingsState.meta.demo ? 'وضع تجريبي' : 'مرتبط بالعيادة';
    showPinBanner(!!settingsState.meta.mustChangePin);
    renderOnboarding();
    renderSettingsGroup(settingsState.group);
  }
  function readSettingsForm() {
    const values = {};
    const fields = $('#settingsFields');
    if (!fields) return values;
    settingsState.catalog.forEach((group) => group.fields.forEach((field) => {
      const node = fields.querySelector(`#setting-${field.key}`);
      if (!node) return;
      if (field.type === 'weekdays') {
        values[field.key] = Array.from(node.querySelectorAll('input[type="checkbox"]'))
          .filter((box) => box.checked).map((box) => Number(box.value)).sort((a, b) => a - b).join(',');
        return;
      }
      values[field.key] = node.value;
    }));
    return values;
  }
  async function saveSettings(event) {
    event.preventDefault();
    if (settingsState.busy) return;
    const values = readSettingsForm();
    const pinField = values.STAFF_PIN;
    const currentPin = ($('#setting-CURRENT_PIN') || {}).value || '';
    delete values.STAFF_PIN;
    settingsState.busy = true;
    const button = $('#settingsSave');
    if (button) { button.disabled = true; button.textContent = 'جارٍ الحفظ…'; }
    hideSettingsMessages();
    try {
      if (pinField) {
        if (pinField.length < 16) throw new Error('الرمز الجديد يجب أن يكون 16 حرفًا على الأقل.');
        const newHash = await sha256Hex(pinField);
        const currentHash = currentPin ? await sha256Hex(currentPin) : '';
        const result = await api('saveStaffPin', currentHash, newHash, state.staffPin);
        if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'تعذر تغيير الرمز.');
        state.staffPin = newHash;
        sessionHash = newHash;
        showPinBanner(false);
      }
      const result = await api('saveClinicSettings', { values, reason: ($('#settingsReason') || {}).value || '' }, state.staffPin);
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'تعذر حفظ الإعدادات.');
      await refreshVisitTypes();
      if (state.selectedDay) await loadAvailability(state.selectedDay);
      const reload = await api('getClinicSettings', state.staffPin);
      if (reload && reload.ok) renderSettings(reload);
      const saved = $('#settingsSaved');
      if (saved) { saved.hidden = false; saved.textContent = result.warning || 'تم الحفظ وتطبيقه على الصفحة.'; }
      const reason = $('#settingsReason');
      if (reason) reason.value = '';
      toast(result.warning || 'تم حفظ الإعدادات وتطبيقها.');
    } catch (error) {
      const box = $('#settingsError');
      if (box) { box.textContent = error.message; box.hidden = false; }
    } finally {
      settingsState.busy = false;
      if (button) { button.disabled = false; button.textContent = 'حفظ التغييرات'; }
    }
  }
  async function resetGroup() {
    const group = settingsState.catalog.find((item) => item.group === settingsState.group);
    if (!group) return;
    if (!window.confirm(`استعادة القيم الافتراضية لمجموعة «${group.title}»؟`)) return;
    hideSettingsMessages();
    try {
      const result = await api('resetClinicSettings', settingsState.group, state.staffPin);
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'تعذرت الاستعادة.');
      await refreshVisitTypes();
      if (state.selectedDay) await loadAvailability(state.selectedDay);
      const reload = await api('getClinicSettings', state.staffPin);
      if (reload && reload.ok) renderSettings(reload);
      toast(result.warning || 'تمت استعادة القيم الافتراضية.');
    } catch (error) {
      const box = $('#settingsError');
      if (box) { box.textContent = error.message; box.hidden = false; }
    }
  }
  async function openSettings() {
    if (!settingsState.loaded) {
      const result = await api('getClinicSettings', state.staffPin);
      if (!result || !result.ok) {
        const container = $('#settingsGroups');
        if (container) container.innerHTML = '<p class="settings-loading">تعذر تحميل الإعدادات. أعد تحميل الصفحة أو أعد الدخول.</p>';
        return;
      }
      renderSettings(result);
      return;
    }
    const result = await api('getClinicSettings', state.staffPin);
    if (result && result.ok) renderSettings(result);
  }
  async function loadHealth() {
    const body = $('#healthBody');
    if (!body) return;
    const button = $('#healthRefresh');
    if (button) button.disabled = true;
    body.innerHTML = '<p class="settings-loading">جارٍ الفحص…</p>';
    try {
      const result = await api('getHealthReport', state.staffPin);
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'تعذر تشغيل الفحص.');
      const report = result.report || {};
      const labels = {
        config: 'إعداد العيادة',
        sheets: 'سجل الطلبات (Sheets)',
        calendar: 'التقويم',
        queues: 'طوابير الانقطاع',
        staff_pin: 'رمز الدخول',
        retention: 'مدة الاحتفاظ',
        last_purge: 'آخر تطبيق لقاعدة الاحتفاظ'
      };
      const counters = report.counters || {};
      const rows = (report.checks || []).map((check) => `
        <li class="${check.ok ? 'is-ok' : 'is-bad'}">
          <span class="health-dot" aria-hidden="true"></span>
          <strong>${escapeHTML(labels[check.id] || check.id)}</strong>
          <span>${check.ok ? 'سليم' : 'يحتاج إجراء'}</span>
          ${check.detail ? `<small>${escapeHTML(String(check.detail)).slice(0, 160)}</small>` : ''}
        </li>`).join('');
      const stale = Number(report.staff_action_age_days);
      const freshness = Number.isFinite(stale) && stale >= 2
        ? `<p class="health-warn">لم يُفتح لوحة العيادة منذ ${arabicNumber(stale)} يومًا. الطلبات لا تُراقب من تلقاء نفسها.</p>`
        : '';
      body.innerHTML = `
        <p class="health-headline ${report.ok ? 'is-ok' : 'is-bad'}">${report.ok ? 'النظام جاهز لاستقبال طلب الآن.' : 'النظام لا يستطيع استقبال طلب بأمان الآن — راجعوا البنود أدناه.'}</p>
        <ul class="health-list">${rows}</ul>
        <p class="health-counters">طلبات مسجلة: ${arabicNumber(counters.requests || 0)} · في الطابور: ${arabicNumber(counters.queued_requests || 0)} · تدقيق معلّق: ${arabicNumber(counters.queued_audits || 0)}</p>
        ${freshness}`;
    } catch (error) {
      body.innerHTML = `<p class="inline-error">${escapeHTML(error.message)}</p>`;
    } finally {
      if (button) button.disabled = false;
    }
  }
  function showPinBanner(show) {
    const banner = $('#pinBanner');
    if (banner) banner.hidden = !show;
  }
  function setStaffTab(tab) {
    const board = $('#staffBoard');
    const settings = $('#staffSettings');
    if (board) board.hidden = tab !== 'board';
    if (settings) settings.hidden = tab !== 'settings';
    $$('[data-staff-tab]').forEach((button) => {
      const active = button.dataset.staffTab === tab;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    if (tab === 'settings') { openSettings(); loadHealth(); }
  }

  /* ---------------- progress + summary ---------------- */
  function selectedVisitType() {
    const form = $('#bookingForm');
    return form && form.elements.visitType ? form.elements.visitType.value : 'كشف جديد';
  }
  function syncProgress() {
    const steps = $$('.booking-progress li');
    if (!steps.length) return;
    const hasTime = !!state.selectedTime;
    const states = hasTime ? ['done', 'done', 'current'] : ['done', 'current', 'todo'];
    steps.forEach((step, index) => {
      const state_ = states[index] || 'todo';
      step.dataset.state = state_;
      if (state_ === 'current') step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
    $$('.form-section').forEach((section, index) => {
      section.classList.toggle('filled', states[index] === 'done');
    });
  }
  function syncSummary() {
    const type = selectedVisitType();
    const set = (key, value, pending = false) => {
      const node = $(`[data-summary="${key}"]`);
      if (!node) return;
      node.textContent = value;
      node.classList.toggle('pending', pending);
    };
    set('visit', type);
    const summaryPrice = priceLabel(servicePrice(type));
    set('duration', summaryPrice ? `${minutesLabel(visitMinutes(type))} · ${summaryPrice}` : minutesLabel(visitMinutes(type)));
    set('day', state.selectedDay ? prettyDate(state.selectedDay) : 'لم يُحدد', !state.selectedDay);
    set('time', state.selectedTime ? prettyTime(state.selectedTime) : 'لم يُحدد', !state.selectedTime);
    $$('[data-visit-duration]').forEach((node) => { node.textContent = `${type} · ${minutesLabel(visitMinutes(type))}`; });
  }

  /* ---------------- clinic clock ---------------- */
  // Only the clinic clock survives: it is real information (Cairo time), not a
  // decorative widget, and nothing else on the page claims live availability.
  function startClock() {
    const node = $('#heroClock');
    if (!node) return;
    const format = new Intl.DateTimeFormat('ar-EG', {
      timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit', hour12: true
    });
    const tick = () => { node.textContent = format.format(new Date()); };
    tick();
    setInterval(tick, 15000);
  }

  /* ---------------- date + slots ---------------- */
  function setDateDefault() {
    const input = $('#visitDate');
    const openDays = state.workDays.length ? state.workDays : WORK_DAYS;
    const tomorrow = nextWorkdayISO(1, openDays);
    const today = clinicTodayISO();
    input.min = today;
    input.value = tomorrow;
    state.selectedDay = tomorrow;
    $('#closureDate').min = today;
    $('#closureDate').value = tomorrow;
  }
  function renderDayChips() {
    const wrap = $('#dayChips');
    if (!wrap) return;
    wrap.replaceChildren();
    for (let i = 1; i <= 5; i += 1) {
      const openDays = state.workDays.length ? state.workDays : WORK_DAYS;
      const iso = nextWorkdayISO(i, openDays);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'day-chip';
      chip.dataset.day = iso;
      chip.innerHTML = `${relativeDayLabel(iso)} · <b>${isoLabel(iso, { weekday: 'short', day: 'numeric', month: 'short' })}</b>`;
      chip.addEventListener('click', () => {
        $('#visitDate').value = iso;
        loadAvailability(iso);
        syncSummary();
      });
      wrap.appendChild(chip);
    }
    syncDayChips();
  }
  function syncDayChips() {
    $$('#dayChips .day-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.day === state.selectedDay));
  }

  function selectTime(time) {
    state.selectedTime = time;
    const hidden = $('#visitTime');
    if (hidden) hidden.value = time;
    $$('#slotsGrid .slot-button').forEach((button) => {
      const selected = button.dataset.time === time;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    syncProgress();
    syncSummary();
  }

  function renderSlots(slots, unverified = false) {
    const grid = $('#slotsGrid');
    grid.replaceChildren();
    state.slots = slots || [];
    state.availabilityVerified = !unverified;
    if (!slots || !slots.length) {
      const empty = document.createElement('span');
      empty.className = 'empty-slots';
      empty.textContent = 'لا توجد أوقات متاحة في هذا اليوم. اختاروا يومًا آخر.';
      grid.appendChild(empty);
      $('#slotStatus').textContent = 'لا توجد أوقات';
      selectTime('');
      return;
    }
    $('#slotStatus').textContent = unverified ? 'أوقات مفضلة فقط' : `${arabicNumber(slots.length)} أوقات`;
    slots.forEach((slot) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'slot-button';
      button.dataset.time = slot;
      button.textContent = prettyTime(slot);
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => selectTime(slot));
      if (!reduceMotion) {
        button.addEventListener('pointermove', (event) => {
          const box = button.getBoundingClientRect();
          button.style.setProperty('--mx', `${event.clientX - box.left}px`);
          button.style.setProperty('--my', `${event.clientY - box.top}px`);
        });
      }
      grid.appendChild(button);
    });
    if (state.selectedTime && slots.includes(state.selectedTime)) selectTime(state.selectedTime);
    else selectTime('');
  }

  async function loadAvailability(day) {
    state.selectedDay = day;
    selectTime('');
    $('#slotStatus').textContent = 'جارٍ التحقق...';
    $('#slotsGrid').innerHTML = '<span class="empty-slots">لحظة من فضلكم…</span>';
    $('#availabilityNote').hidden = true;
    syncDayChips();
    $('#slotsGrid').setAttribute('aria-busy', 'true');
    try {
      const visitType = $('#bookingForm').elements.visitType.value;
      const result = await api('getAvailableSlots', day, visitType, state.staffPin);
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'تعذر التحقق من التقويم.');
      renderSlots(result.slots || [], false);
    } catch (error) {
      renderSlots(FALLBACK_SLOTS, true);
      $('#availabilityNote').textContent = 'تعذر الاتصال بالتقويم الآن. يمكن إرسال الوقت كتفضيل فقط؛ سيبقى الطلب غير مؤكد ويحتاج مراجعة العيادة.';
      $('#availabilityNote').hidden = false;
      $('#slotStatus').textContent = 'تعذر التحقق';
    } finally {
      $('#slotsGrid').setAttribute('aria-busy', 'false');
    }
  }

  /* ---------------- booking flow ---------------- */
  function formatStatus(status) { return statusText[status] || status || 'قيد المراجعة'; }

  // A duplicate is not an error: the parent already has a request today. Say so plainly
  // and hand them the reference, instead of letting them think nothing happened.
  function showDuplicateNotice(response) {
    const result = $('#bookingResult');
    if (!result) { toast(response.message || 'لديكم طلب قائم لهذا اليوم.'); return; }
    result.innerHTML = `
      <div class="result-top">
        <span class="result-check is-info" aria-hidden="true"><svg><use href="#i-clock"/></svg></span>
        <div>
          <h3>لديكم طلب قائم لهذا اليوم</h3>
          <p>لم نُنشئ طلبًا ثانيًا. الرقم المرجعي: <strong class="ltr">${escapeHTML(response.reference || '')}</strong></p>
        </div>
      </div>
      <p class="result-note">تابعوه من «طلب سابق»، أو انتظروا تأكيد العيادة. إن أردتم يومًا آخر فاختاروا تاريخًا مختلفًا ثم أرسلوا.</p>
      <button type="button" class="secondary-button" id="duplicateTrack">تابعوا الطلب الحالي</button>`;
    result.hidden = false;
    const track = $('#duplicateTrack');
    if (track) track.addEventListener('click', () => {
      if ($('#trackReference')) $('#trackReference').value = response.reference || '';
      if ($('#trackCard') && typeof $('#trackCard').scrollIntoView === 'function') $('#trackCard').scrollIntoView({ block: 'center' });
      if ($('#trackForm')) $('#trackForm').requestSubmit();
    });
    if (typeof result.scrollIntoView === 'function') result.scrollIntoView({ block: 'center' });
  }

  // The daily cap is a deliberate "ask a human" moment, not a failure: say what to do next.
  function showRateLimitNotice(response) {
    const result = $('#bookingResult');
    if (!result) { toast(response.message); return; }
    result.innerHTML = `
      <div class="result-top">
        <span class="result-check is-info" aria-hidden="true"><svg><use href="#i-alert"/></svg></span>
        <div>
          <h3>لم نُنشئ طلبًا جديدًا</h3>
          <p>${escapeHTML(response.message || '')}</p>
        </div>
      </div>
      <p class="result-note">هذا الحد لحماية جدول الطبيب من الطلبات المتكررة بالخطأ. موعدكم الحالي لم يتغيّر.</p>`;
    result.hidden = false;
    if (typeof result.scrollIntoView === 'function') result.scrollIntoView({ block: 'center' });
  }

  function showBookingResult(booking, savedLocally = false, localDemo = false, warning = '') {
    const result = $('#bookingResult');
    const note = warning
      || (localDemo ? 'هذا سجل محلي تجريبي على هذا المتصفح ولا يصل إلى العيادة.'
        : savedLocally ? 'تم حفظ الطلب مؤقتًا في نظام العيادة أثناء تعطل Sheets. لن يتأكد الموعد حتى عودة السجل ومراجعته.'
          : booking.slotVerified === false ? 'حُفظ الوقت كتفضيل فقط لأن التقويم لم يكن متاحًا للتحقق. يلزم مراجعة العيادة قبل الموافقة.'
            : 'سيراجع فريق العيادة الطلب، وسيؤكد الموعد أو يتواصل معكم بشأن وقت بديل.');
    result.innerHTML = `
      <div class="result-top">
        <span class="result-check" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 20 20" fill="none"><path d="m4.5 10.5 3.4 3.4 7.6-8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <div><h3>وصل طلبكم إلى العيادة</h3><p>حالة الطلب: <strong>${escapeHTML(formatStatus(booking.status))}</strong>. لم يتأكد الموعد بعد.</p></div>
      </div>
      <div class="result-meta">
        <span>${escapeHTML(prettyDate(booking.day))}</span>
        <span>${escapeHTML(prettyTime(booking.time))}</span>
        <span>${escapeHTML(booking.visitType || 'زيارة')}</span>
      </div>
      <span class="reference-chip">${escapeHTML(booking.reference)}</span>
      <div class="result-actions">
        <button type="button" class="secondary-button" data-copy="${escapeHTML(booking.reference)}">نسخ الرقم المرجعي</button>
        <a class="secondary-button" href="${IS_GAS ? '#' : '#trackCard'}" data-track-ref="${escapeHTML(booking.reference)}">متابعة الحالة</a>
      </div>
      <p class="result-note">${escapeHTML(note)}</p>`;
    result.hidden = false;
    if (typeof result.scrollIntoView === 'function') result.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });

    const copyButton = result.querySelector('[data-copy]');
    if (copyButton) {
      copyButton.addEventListener('click', async () => {
        const value = copyButton.dataset.copy;
        try {
          await navigator.clipboard.writeText(value);
          copyButton.textContent = 'تم النسخ';
        } catch (_) {
          window.prompt('انسخوا الرقم المرجعي:', value);
        }
        setTimeout(() => { copyButton.textContent = 'نسخ الرقم المرجعي'; }, 2200);
      });
    }
    const trackLink = result.querySelector('[data-track-ref]');
    if (trackLink) {
      trackLink.addEventListener('click', (event) => {
        event.preventDefault();
        $('#trackReference').value = trackLink.dataset.trackRef;
        if (IS_GAS) { $('#trackForm').requestSubmit(); return; }
        if (typeof $('#trackCard').scrollIntoView === 'function') $('#trackCard').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        $('#trackForm').requestSubmit();
      });
    }
  }

  async function submitBooking(event) {
    event.preventDefault();
    if (state.busy) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!state.selectedTime) { toast('اختاروا وقتًا مفضلًا أولًا.'); return; }
    if (!$('#consent').checked) { toast('يرجى الموافقة على استخدام بيانات التواصل لإدارة الطلب.'); return; }
    const phone = $('#phone').value.trim();
    if (digits(phone).length < 8) { toast('تحققوا من رقم الهاتف.'); $('#phone').focus(); return; }

    const payload = {
      visitType: form.elements.visitType.value,
      day: state.selectedDay,
      time: state.selectedTime,
      guardianName: $('#guardianName').value.trim(),
      phone,
      consent: true
    };

    state.busy = true;
    const submit = $('#submitBooking');
    const label = submit.querySelector('span');
    submit.disabled = true;
    label.textContent = 'جارٍ إرسال الطلب…';
    try {
      const response = await api('createRequest', payload);
      if (response && response.duplicate) { showDuplicateNotice(response); return; }
      if (response && response.rateLimited) { showRateLimitNotice(response); return; }
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر حفظ الطلب. يرجى المحاولة مجددًا.');
      showBookingResult(response.booking, !!response.savedLocally, !IS_GAS, response.warning || '');
      form.reset();
      $$('.choice-card').forEach((card, index) => card.classList.toggle('selected', index === 0));
      $('#visitDate').value = state.selectedDay;
      loadAvailability(state.selectedDay);
      syncSummary();
    } catch (error) {
      toast(error.message || 'تعذر حفظ الطلب. لم نعرض تأكيدًا.');
    } finally {
      state.busy = false;
      submit.disabled = false;
      label.textContent = 'إرسال طلب الموعد';
    }
  }

  async function trackRequest(event) {
    event.preventDefault();
    const ref = $('#trackReference').value.trim().toUpperCase();
    const phone = ($('#trackPhone') || {}).value || '';
    const target = $('#trackResult');
    target.hidden = false;
    target.className = 'track-result';
    target.textContent = 'جارٍ البحث…';
    if (!ref) { target.classList.add('error'); target.textContent = 'أدخلوا الرقم المرجعي أولًا.'; return; }
    // The reference is not a credential on its own (a photographed screen leaks it), so the
    // phone that filed the request is required before any detail is shown.
    if (String(phone).replace(/\D/g, '').length < 8) {
      target.classList.add('error');
      target.textContent = 'أدخلوا رقم الهاتف الذي أرسلتم به الطلب لعرض حالته.';
      return;
    }
    try {
      const response = await api('lookupOwnRequest', ref, phone);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'لم نعثر على طلب بهذا الرقم.');
      const booking = response.booking;
      target.innerHTML = `<strong>${escapeHTML(formatStatus(booking.status))}</strong><br>${escapeHTML(prettyDate(booking.day))} · ${escapeHTML(prettyTime(booking.time))}<br><span class="request-ref">${escapeHTML(booking.reference)}</span>`;
      if (booking.status !== 'DELETED') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button danger-link';
        button.textContent = 'حذف بياناتي';
        button.addEventListener('click', () => deleteMyData(booking.reference, phone, button));
        target.appendChild(document.createElement('br'));
        target.appendChild(button);
      }
    } catch (error) {
      target.classList.add('error');
      target.textContent = error.message;
    }
  }

  /**
   * Erasing is irreversible and reaches a real spreadsheet, so it is confirmed in words
   * that say what disappears and what stays — not a generic "are you sure?".
   */
  async function deleteMyData(reference, phone, button) {
    const confirmed = window.confirm('سيُحذف اسمكم ورقم هاتفكم من هذا الطلب، ولا يمكن التراجع. يبقى الرقم المرجعي وحالة الطلب فقط في سجل العيادة. هل تريدون المتابعة؟');
    if (!confirmed) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = 'جارٍ الحذف…';
    try {
      const response = await api('deleteOwnRequestData', reference, phone, 'طلب ولي الأمر من صفحة المتابعة');
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر الحذف.');
      toast(response.warning || 'حُذفت بياناتكم من الطلب.');
      const target = document.getElementById('trackResult');
      if (target) {
        target.className = 'track-result';
        target.innerHTML = '<strong>حُذفت بيانات هذا الطلب</strong><br>لم يبقَ الاسم ولا رقم الهاتف. احتفظوا بالرقم المرجعي للاستفسار هاتفيًا.';
      }
    } catch (error) {
      toast(error.message);
      button.disabled = false;
      button.textContent = original;
    }
  }

  /* ---------------- privacy notice (public, no PIN) ---------------- */
  // The static notice in privacy.html is readable without JavaScript; this fills the two
  // facts that are configuration (clinic name/phone) and the retention window, so the page
  // cannot promise a policy the backend does not apply.
  async function loadPrivacyNotice() {
    const slot = document.querySelector('[data-privacy-notice]');
    if (!slot) return;
    try {
      const notice = await api('getPrivacyNotice');
      if (!notice || !notice.ok) return;
      const months = Number(notice.retentionMonths) > 0 ? Number(notice.retentionMonths) : 12;
      slot.querySelectorAll('[data-notice-phone]').forEach((node) => {
        if (notice.phone) {
          node.textContent = notice.phone;
          if (node.tagName === 'A') node.href = `tel:${notice.phone}`;
        } else {
          node.textContent = 'هاتف العيادة غير منشور بعد — اطلبوا الحذف عبر استقبال العيادة.';
        }
      });
      slot.querySelectorAll('[data-notice-retention]').forEach((node) => {
        node.textContent = `${arabicNumber(months)} شهرًا`;
      });
      slot.querySelectorAll('[data-notice-clinic]').forEach((node) => {
        if (notice.clinicName) node.textContent = notice.clinicName;
      });
      slot.dataset.loaded = 'true';
    } catch (error) { /* the static notice stays readable; never a blank privacy page */ }
  }

  /* ---------------- staff dashboard ---------------- */
  function statusClass(status) {
    return status === 'CONFIRMED' || status === 'COMPLETED' ? 'confirmed'
      : status === 'CANCELLED' ? 'cancelled'
        : status === 'RESCHEDULED' ? 'rescheduled' : '';
  }
  function bookingDateTime(booking) { return `${prettyDate(booking.day)} · ${prettyTime(booking.time)}`; }
  function whatsappLink(booking, proposal = false) {
    let number = digits(booking.phone);
    if (number.startsWith('0')) number = `20${number.slice(1)}`;
    else if (number.length === 10 && number.startsWith('1')) number = `20${number}`;
    const clinic = IS_GAS ? (state.clinicName || 'عيادة الأطفال') : 'عيادة Celia Kids (عرض تجريبي)';
    const prefix = proposal ? 'نقترح عليكم وقتًا بديلًا لطلب الموعد' : 'تم تأكيد موعدكم في';
    const message = `${prefix} لدى ${clinic}: ${prettyDate(booking.day)} الساعة ${prettyTime(booking.time)}. رقم الطلب: ${booking.reference}. للرد أو الاستفسار، تواصلوا مع العيادة.`;
    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  }
  function currentWeekBookings(bookings) {
    // Monday-based week, anchored on the clinic's today (not the phone's).
    const today = clinicTodayISO();
    const startISO = shiftISO(today, -((isoWeekday(today) + 6) % 7));
    const endISO = shiftISO(startISO, 7);
    return bookings
      .filter((item) => ['CONFIRMED', 'COMPLETED', 'RESCHEDULED'].includes(item.status))
      .filter((item) => String(item.day) >= startISO && String(item.day) < endISO)
      .sort((a, b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`));
  }
  function requestCard(booking, canAct) {
    const isPending = ['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(booking.status);
    const isConfirmed = booking.status === 'CONFIRMED';
    const ref = escapeHTML(booking.reference);
    const actions = canAct ? `
      <div class="request-actions">
        ${isPending ? `${can('booking:approve') ? `<button class="action-approve" data-action="approve" data-ref="${ref}">${booking.status === 'RESCHEDULED' ? 'اعتماد الوقت المقترح' : 'قبول وحجز'}</button>` : ''}${can('booking:reschedule') ? `<button data-action="reschedule" data-ref="${ref}">اقتراح وقت بديل</button><button class="action-danger" data-action="cancel" data-ref="${ref}">رفض / إلغاء</button>` : ''}` : ''}
        ${isConfirmed ? `${can('booking:reschedule') ? `<button data-action="move" data-ref="${ref}">تعديل الموعد</button>` : ''}${can('booking:no_show') ? `<button data-action="complete" data-ref="${ref}">إكمال الزيارة</button>` : ''}${can('booking:reschedule') ? `<button data-action="cancel" data-ref="${ref}" class="action-danger">إلغاء</button>` : ''}<a class="text-button" href="${whatsappLink(booking)}" target="_blank" rel="noopener noreferrer">رسالة WhatsApp</a>` : ''}
        ${booking.status === 'RESCHEDULED' ? `<a class="text-button" href="${whatsappLink(booking, true)}" target="_blank" rel="noopener noreferrer">إرسال الاقتراح يدويًا</a>` : ''}
      </div>` : '';
    // A slot the calendar could not confirm is a *preference*, not a booking. The clinic
    // must see that before approving, otherwise "unverified" is a stored flag nobody reads.
    const unchecked = booking.slotVerified === false
      ? `<p class="request-warning"><svg aria-hidden="true"><use href="#i-alert"/></svg> لم يُتحقق من التقويم وقت الطلب — راجعوا الجدول قبل القبول.</p>`
      : '';
    return `<article class="request-item${booking.slotVerified === false ? ' is-unverified' : ''}">
      <div class="request-item-top">
        <div>
          <h4>${escapeHTML(booking.guardianName)} <span class="request-ref">${ref}</span></h4>
          <div class="request-meta">${escapeHTML(booking.visitType)} · ${escapeHTML(bookingDateTime(booking))}<br>${escapeHTML(booking.phone)}</div>
        </div>
        <span class="status-pill ${statusClass(booking.status)}">${escapeHTML(formatStatus(booking.status))}</span>
      </div>${unchecked}${actions}
    </article>`;
  }

  /** Reflect the signed-in role: a label, and the controls this role may not use are hidden. */
  function applyStaffChrome() {
    const label = $('#staffRoleLabel');
    if (label) {
      const role = ROLE_LABELS[state.role] || state.role || '';
      label.textContent = state.staffName ? state.staffName + ' · ' + role : role;
      label.hidden = !label.textContent;
    }
    $$('[data-staff-tab="settings"]').forEach((button) => { button.hidden = !can('settings:write'); });
    const healthBody = $('#healthBody');
    const healthCard = healthBody && healthBody.closest ? healthBody.closest('.health-card') : null;
    if (healthCard) healthCard.hidden = !can('staff:manage');
  }

  async function loginStaff(event) {
    event.preventDefault();
    const typed = $('#staffPin').value.trim();
    $('#staffLoginError').hidden = true;
    try {
      // The browser sends the hash, never the PIN itself (matches Settings.gs).
      if (!IS_GAS && !demoPinHash()) {
        // First run of the demo: the documented demo PIN becomes the initial hash.
        try { localStorage.setItem(DEMO_PIN_KEY, await sha256Hex(DEMO_PIN)); } catch (_) { /* private mode */ }
      }
      const pin = await sha256Hex(typed);
      // The digest buys a session token; every later call carries the token, so a disabled
      // staff member stops working immediately. An older backend answers getDashboard with
      // the digest directly, so the page keeps working while the deployment is updated.
      let credential = pin;
      if (IS_GAS) {
        const loginAnswer = await api('login', pin);
        if (loginAnswer && loginAnswer.ok === false && loginAnswer.code === 'UNAUTHORIZED') {
          throw new Error(loginAnswer.message || 'رمز الدخول غير صحيح.');
        }
        if (loginAnswer && loginAnswer.ok && loginAnswer.token) {
          credential = loginAnswer.token;
          state.permissions = Array.isArray(loginAnswer.permissions) ? loginAnswer.permissions : [];
          state.role = loginAnswer.staff && loginAnswer.staff.role ? loginAnswer.staff.role : '';
          state.staffName = loginAnswer.staff && loginAnswer.staff.name ? loginAnswer.staff.name : '';
        }
      }
      const response = await api('getDashboard', credential);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر فتح لوحة الموظف.');
      state.staffPin = credential;
      sessionHash = credential;
      applyStaffChrome();
      $('#staffLogin').hidden = true;
      $('#staffDashboard').hidden = false;
      renderDashboard(response);
    } catch (error) {
      $('#staffLoginError').textContent = error.message;
      $('#staffLoginError').hidden = false;
    }
  }
  async function refreshDashboard() {
    try {
      const response = await api('getDashboard', state.staffPin);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر تحميل لوحة الموظف.');
      renderDashboard(response);
    } catch (error) {
      $('#staffAlerts').hidden = false;
      $('#staffAlerts').textContent = error.message;
    }
  }
  function renderDashboard(response) {
    const bookings = response.bookings || [];
    state.bookings = bookings;
    state.closures = response.closures || [];
    const pending = bookings.filter((item) => ['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(item.status));
    // The clinic's today — the dashboard counts visits for the clinic's date, not the
    // phone's, or a doctor reviewing after midnight sees yesterday's numbers.
    const today = clinicTodayISO();
    const todayConfirmed = bookings.filter((item) => item.day === today && ['CONFIRMED', 'COMPLETED'].includes(item.status));
    const week = currentWeekBookings(bookings);
    $('#dashboardStats').innerHTML = `
      <div class="stat-card"><span>بانتظار القرار</span><strong>${arabicNumber(pending.length)}</strong><small>الطلب لا يحجز الوقت حتى اعتماده</small></div>
      <div class="stat-card"><span>زيارات اليوم</span><strong>${arabicNumber(todayConfirmed.length)}</strong><small>${escapeHTML(prettyDate(today))}</small></div>
      <div class="stat-card"><span>مواعيد هذا الأسبوع</span><strong>${arabicNumber(week.length)}</strong><small>مؤكدة أو مكتملة</small></div>`;
    $('#pendingCount').textContent = arabicNumber(pending.length);
    $('#pendingList').innerHTML = pending.length
      ? pending.map((item) => requestCard(item, true)).join('')
      : '<div class="empty-list">لا توجد طلبات بانتظار المراجعة.</div>';
    $('#weekList').innerHTML = week.length
      ? week.map((item) => requestCard(item, true)).join('')
      : '<div class="empty-list">لا توجد مواعيد مؤكدة هذا الأسبوع.</div>';
    const alertBox = $('#staffAlerts');
    const warnings = response.warnings || [];
    if (warnings.length) { alertBox.hidden = false; alertBox.textContent = warnings.join(' — '); }
    else alertBox.hidden = true;
  }

  async function staffAction(button) {
    const ref = button.dataset.ref;
    const action = button.dataset.action;
    const booking = state.bookings.find((item) => item.reference === ref);
    if (!booking) return;
    let method;
    let args;
    if (action === 'approve') { method = 'approveRequest'; args = [ref, state.staffPin]; }
    else if (action === 'cancel') {
      if (!confirm(`هل تريد إلغاء/رفض الطلب ${ref}؟`)) return;
      method = 'cancelRequest'; args = [ref, 'تم الإلغاء من العيادة', state.staffPin];
    } else if (action === 'complete') { method = 'completeRequest'; args = [ref, state.staffPin]; }
    else if (action === 'reschedule' || action === 'move') {
      const day = prompt('أدخلوا التاريخ البديل بصيغة YYYY-MM-DD', booking.day);
      if (!day) return;
      const time = prompt('أدخلوا الوقت بصيغة HH:MM', booking.time);
      if (!time) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) { toast('صيغة التاريخ أو الوقت غير صحيحة.'); return; }
      method = action === 'move' ? 'moveConfirmedAppointment' : 'proposeAlternative';
      args = action === 'move' ? [ref, day, time, 'تعديل من لوحة العيادة', state.staffPin] : [ref, day, time, state.staffPin];
    } else return;

    button.disabled = true;
    try {
      const response = await api(method, ...args);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر تنفيذ الإجراء.');
      toast(response.warning || (action === 'approve' ? 'تمت الموافقة وحفظ الموعد.'
        : action === 'reschedule' ? 'سُجل الوقت البديل المقترح؛ لم يتأكد الموعد.'
          : 'تم تحديث الطلب.'));
      await refreshDashboard();
    } catch (error) {
      toast(error.message);
      // A timed-out write may still have landed. Re-read the dashboard so the button and
      // the rows agree with the server instead of leaving staff on a stale screen.
      if (error && error.code === 'TIMEOUT') await refreshDashboard();
    } finally {
      // The card is re-rendered after a success, so this only matters for the failure
      // paths — but it is the one line that guarantees no button stays dead.
      button.disabled = false;
    }
  }

  async function closeDay(event) {
    event.preventDefault();
    const day = $('#closureDate').value;
    const label = $('#closureLabel').value.trim() || 'إغلاق يوم';
    try {
      const response = await api('closeDay', day, label, state.staffPin);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر إغلاق اليوم.');
      toast(response.warning || 'تم تسجيل إغلاق اليوم.');
      $('#closureLabel').value = '';
      await loadAvailability(state.selectedDay);
      await refreshDashboard();
    } catch (error) {
      toast(error.message);
    }
  }

  async function askQuestion(event) {
    event.preventDefault();
    const question = $('#faqQuestion').value.trim();
    if (!question) return;
    const answer = $('#faqAnswer');
    answer.hidden = false;
    answer.textContent = 'جارٍ تجهيز الإجابة…';
    $('#faqQuestion').disabled = true;
    try {
      const result = await api('askGeneralQuestion', question);
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'المساعدة غير متاحة الآن.');
      answer.textContent = result.answer;
    } catch (error) {
      answer.textContent = `${error.message} يمكنك إكمال الحجز دون هذه الخدمة.`;
    } finally {
      $('#faqQuestion').disabled = false;
      $('#faqQuestion').value = '';
    }
  }

  /* ---------------- motion polish ---------------- */
  // Progressive enhancement, not a requirement: hidden state lives in CSS and is enabled
  // by a class added here. If this script never runs, nothing is hidden and the page is
  // simply a page — previously the script set opacity:0 inline, so a JS failure blanked
  // whole sections on a slow phone.
  function revealOnScroll() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    const targets = [...$$('.card, .side-card, .tool-card, .steps-strip')];
    const below = targets.filter((node) => node.getBoundingClientRect().top >= window.innerHeight);
    if (!below.length) return;
    document.documentElement.classList.add('js-reveal-ready');
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    below.forEach((node) => observer.observe(node));
  }

  /* ---------------- wiring + boot ---------------- */
  function init() {
    // privacy.html loads this same script but has none of the booking DOM. Bail out early
    // with the one job that page needs, instead of throwing on the first missing element
    // and leaving the notice half-rendered.
    if (!$('#bookingForm')) { loadPrivacyNotice(); return; }
    $$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    // Delegated on purpose: the service cards are rebuilt from settings, so binding
    // listeners to the initial nodes silently stopped working after a save.
    $('.choice-grid').addEventListener('change', (event) => {
      if (!event.target || event.target.name !== 'visitType') return;
      $$('.choice-card').forEach((card) => card.classList.toggle('selected', card.querySelector('input').checked));
      loadAvailability($('#visitDate').value);
    });
    $('#visitDate').addEventListener('change', (event) => loadAvailability(event.target.value));

    $('#bookingForm').addEventListener('submit', submitBooking);
    $('#trackForm').addEventListener('submit', trackRequest);
    $('#staffLoginForm').addEventListener('submit', loginStaff);
    $('#pendingList').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) staffAction(button); });
    $('#weekList').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) staffAction(button); });
    $('#closureForm').addEventListener('submit', closeDay);
    $('#faqForm').addEventListener('submit', askQuestion);
    $$('[data-staff-tab]').forEach((button) => button.addEventListener('click', () => setStaffTab(button.dataset.staffTab)));
    if ($('#settingsForm')) $('#settingsForm').addEventListener('submit', saveSettings);
    if ($('#settingsCancel')) $('#settingsCancel').addEventListener('click', () => renderSettingsGroup(settingsState.group));
    if ($('#settingsReset')) $('#settingsReset').addEventListener('click', resetGroup);
    if ($('#onboardingFix')) $('#onboardingFix').addEventListener('click', () => {
      const missing = missingFacts();
      const first = missing[0];
      if (first) {
        const group = settingsState.catalog.find((item) => item.fields.some((field) => field.key === first.key));
        if (group) renderSettingsGroup(group.group);
        const field = document.querySelector(`#setting-${first.key}`);
        if (field) { field.focus(); field.scrollIntoView({ block: 'center' }); }
      }
    });
    // Demo only: fill the page with the sample clinic published in docs/settings.md,
    // so the screen can be tried without inventing a doctor. Never shown live.
    if ($('#onboardingDemo')) $('#onboardingDemo').addEventListener('click', async () => {
      const sample = {
        CLINIC_NAME: 'عيادة أطفال — نسخة عرض',
        CLINIC_PHONE: '01000000000',
        DOCTOR_NAME: 'د. اسم تجريبي',
        DOCTOR_TITLE: 'استشاري طب الأطفال (بيانات عرض)',
        DOCTOR_LICENSE: 'DEMO-0000'
      };
      const merged = Object.assign(readSettingsStore(), sample);
      writeSettingsStore(merged);
      await refreshVisitTypes();
      if (state.selectedDay) await loadAvailability(state.selectedDay);
      const reload = await api('getClinicSettings', state.staffPin);
      if (reload && reload.ok) renderSettings(reload);
    });
    if ($('#pinBannerGo')) $('#pinBannerGo').addEventListener('click', () => {
      setStaffTab('settings');
      const group = settingsState.catalog.find((item) => item.group === 'security');
      if (group) renderSettingsGroup('security');
      const field = $('#setting-STAFF_PIN');
      if (field) field.focus();
    });
    $('#trackReference').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase(); });
    // privacy.html loads the same script: it renders the notice and nothing else.
    loadPrivacyNotice();
    if ($('#healthRefresh')) $('#healthRefresh').addEventListener('click', loadHealth);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'staff' && state.staffPin) refreshDashboard(); });

    try {
      setMode();
      setDateDefault();
      renderDayChips();
      startClock();
      // Honest defaults first (no credential implied), then the clinic's own facts.
      setLicence(CLINIC_FALLBACK.license, false);
      setFact('hours', formatHours(CLINIC_FALLBACK.hours));
      if (!IS_GAS) {
        // Demo: the page reflects the values saved in the settings screen.
        const demo = demoProfile();
        applyClinicProfile(demo);
        applyServices(demo.services);
        // Stage A: the published contact facts, without a Google deployment behind them.
        loadPublishedClinicFacts();
      }
      syncSummary();
      syncProgress();
      loadAvailability(state.selectedDay);
      loadClinicProfile();
      requestAnimationFrame(revealOnScroll);
    } catch (error) {
      console.error('Celia Kids failed to start', error);
    }
  }

  // Works whether the script is deferred in <head> or inlined at the end of <body>.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
