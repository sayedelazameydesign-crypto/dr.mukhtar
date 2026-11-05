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
  const reduceMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    view: 'booking',
    staffPin: '',
    selectedTime: '',
    selectedDay: '',
    slots: [],
    availabilityVerified: false,
    bookings: [],
    closures: [],
    busy: false
  };

  const DEMO_PIN = '2468';
  const FALLBACK_SLOTS = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
  const WORK_DAYS = [0, 1, 2, 3, 4];
  // One source of truth for visit duration — the site, the demo backend and the
  // copy all read this table (Code.gs visitDuration_ is the live equivalent).
  const VISIT_MINUTES = { 'كشف جديد': 60, 'متابعة': 30 };
  const visitMinutes = (type) => VISIT_MINUTES[type] || VISIT_MINUTES['كشف جديد'];
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
  function nextWorkday(offset = 1) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    while (!WORK_DAYS.includes(date.getDay())) date.setDate(date.getDate() + 1);
    return date;
  }
  function prettyDate(iso) {
    if (!iso) return '—';
    const parts = iso.split('-').map(Number);
    const d = new Date(parts[0], parts[1] - 1, parts[2]);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
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

  /* ---------------- demo store ---------------- */
  function seedDemo() {
    try {
      const current = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (current && Array.isArray(current.bookings)) return current;
    } catch (_) { /* damaged demo data is rebuilt below */ }
    const initial = {
      bookings: [
        { reference: 'CK-DEMO-8K2P', createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL', visitType: 'كشف جديد', guardianName: 'مريم تجريبية', phone: '0000000000', day: localISO(nextWorkday(1)), time: '10:00', eventId: '', consent: true },
        { reference: 'CK-DEMO-4M7Q', createdAt: new Date().toISOString(), status: 'CONFIRMED', visitType: 'متابعة', guardianName: 'عمر تجريبي', phone: '0000000001', day: localISO(nextWorkday(2)), time: '11:00', eventId: '', consent: true }
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
  function callServer(method, ...args) {
    return new Promise((resolve, reject) => {
      try {
        google.script.run
          .withSuccessHandler(resolve)
          .withFailureHandler((error) => reject(new Error(error && error.message ? error.message : 'تعذر الاتصال بخدمة العيادة.')))
          [method](...args);
      } catch (error) { reject(error); }
    });
  }
  async function api(method, ...args) {
    if (IS_GAS) return callServer(method, ...args);
    const store = demoStore();
    if (method === 'getAvailableSlots') {
      const day = args[0];
      // Work in whole minutes: `visitType` here is the *service* visit type.
      const visitType = args[1] || 'كشف جديد';
      const visitDuration = visitMinutes(visitType);
      if (store.closures.some((item) => item.day === day)) return { ok: true, slots: [] };
      const parts = String(day).split('-').map(Number);
      const weekday = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
      if (!WORK_DAYS.includes(weekday)) return { ok: true, slots: [] };
      const start = 9 * 60;
      const end = 14 * 60;
      const step = 30;
      const duration = visitDuration;
      const toTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
      const toMinutes = (time) => { const [h, m] = String(time).split(':').map(Number); return h * 60 + m; };
      const busy = store.bookings
        .filter((item) => item.day === day && ['CONFIRMED', 'COMPLETED'].includes(item.status))
        .map((item) => ({ start: toMinutes(item.time), end: toMinutes(item.time) + visitMinutes(item.visitType) }));
      const slots = [];
      for (let minute = start; minute + duration <= end; minute += step) {
        const clash = busy.some((span) => minute < span.end && span.start < minute + duration);
        if (!clash) slots.push(toTime(minute));
      }
      return { ok: true, slots };
    }
    if (method === 'createRequest') {
      const payload = args[0];
      const booked = store.bookings.some((item) => item.day === payload.day && item.time === payload.time && item.status === 'CONFIRMED');
      if (booked) return { ok: false, message: 'اختير هذا الوقت للتو. يرجى اختيار وقت آخر.' };
      const booking = { ...payload, reference: newRef(), createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL', eventId: '', consent: true };
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
    if (method === 'getDashboard') {
      if (args[0] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      return { ok: true, bookings: store.bookings, closures: store.closures, warnings: [] };
    }
    if (method === 'approveRequest') {
      if (args[1] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
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
      if (args[3] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      const conflict = store.bookings.some((item) => item.reference !== args[0] && item.day === args[1] && item.time === args[2] && item.status === 'CONFIRMED');
      if (!booking || conflict) return { ok: false, message: conflict ? 'الوقت البديل مشغول.' : 'الطلب غير موجود.' };
      booking.day = args[1]; booking.time = args[2]; booking.status = 'RESCHEDULED'; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'cancelRequest') {
      if (args[2] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking) return { ok: false, message: 'الطلب غير موجود.' };
      booking.status = 'CANCELLED'; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'completeRequest') {
      if (args[1] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking) return { ok: false, message: 'الطلب غير موجود.' };
      booking.status = 'COMPLETED'; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'moveConfirmedAppointment') {
      if (args[4] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      const conflict = store.bookings.some((item) => item.reference !== args[0] && item.day === args[1] && item.time === args[2] && item.status === 'CONFIRMED');
      if (!booking || conflict) return { ok: false, message: conflict ? 'الوقت البديل مشغول.' : 'الطلب غير موجود.' };
      booking.day = args[1]; booking.time = args[2]; booking.updatedAt = new Date().toISOString();
      saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'closeDay') {
      if (args[2] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      if (!store.closures.some((item) => item.day === args[0])) store.closures.push({ day: args[0], label: args[1] || 'إغلاق يوم' });
      saveDemo(store);
      return { ok: true };
    }
    if (method === 'getClinicProfile') {
      // The demo build reports the same shape but no verified credentials.
      return { ok: true, name: 'Celia Kids', phone: '', address: '', hours: '', license: '' };
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
  const CLINIC_FALLBACK = {
    name: 'Celia Kids',
    phone: 'يُضاف من إعداد العيادة',
    address: 'يُضاف من إعداد العيادة',
    hours: 'الأحد – الخميس · ٩:٠٠ ص – ٢:٠٠ م',
    license: '—'
  };
  function applyClinicProfile(profile) {
    if (!profile || !profile.ok) return;
    state.clinicName = profile.name || '';
    const facts = {};
    ['phone', 'hours', 'address', 'license', 'doctorName', 'doctorRole', 'subspecialty']
      .forEach((key) => { if (profile[key]) facts[key] = profile[key]; });
    Object.keys(facts).forEach((key) => {
      $$(`[data-config="${key}"]`).forEach((node) => { node.textContent = facts[key]; });
    });
  }
  async function loadClinicProfile() {
    if (!IS_GAS) return; // the demo build keeps the neutral placeholders visible
    try {
      const profile = await api('getClinicProfile');
      applyClinicProfile(profile);
    } catch (_) { /* placeholders stay; they never claim facts */ }
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
    set('duration', minutesLabel(visitMinutes(type)));
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
    const tomorrow = localISO(nextWorkday(1));
    input.min = localISO(new Date());
    input.value = tomorrow;
    state.selectedDay = tomorrow;
    $('#closureDate').min = localISO(new Date());
    $('#closureDate').value = tomorrow;
  }
  function renderDayChips() {
    const wrap = $('#dayChips');
    if (!wrap) return;
    wrap.replaceChildren();
    const labels = ['غدًا', 'بعد غد', 'اليوم الثالث', 'اليوم الرابع', 'اليوم الخامس'];
    for (let i = 1; i <= 5; i += 1) {
      const date = nextWorkday(i);
      const iso = localISO(date);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'day-chip';
      chip.dataset.day = iso;
      chip.innerHTML = `${labels[i - 1]} · <b>${date.toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short' })}</b>`;
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
    const ref = $('#trackReference').value.trim();
    const target = $('#trackResult');
    target.hidden = false;
    target.className = 'track-result';
    target.textContent = 'جارٍ البحث…';
    if (!ref) { target.classList.add('error'); target.textContent = 'أدخلوا الرقم المرجعي أولًا.'; return; }
    try {
      const response = await api('lookupBooking', ref);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'لم نعثر على طلب بهذا الرقم.');
      const booking = response.booking;
      target.innerHTML = `<strong>${escapeHTML(formatStatus(booking.status))}</strong><br>${escapeHTML(prettyDate(booking.day))} · ${escapeHTML(prettyTime(booking.time))}<br><span class="request-ref">${escapeHTML(booking.reference)}</span>`;
    } catch (error) {
      target.classList.add('error');
      target.textContent = error.message;
    }
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
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    return bookings
      .filter((item) => ['CONFIRMED', 'COMPLETED', 'RESCHEDULED'].includes(item.status))
      .filter((item) => {
        const day = new Date(`${item.day}T12:00:00`);
        return day >= start && day < end;
      })
      .sort((a, b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`));
  }
  function requestCard(booking, canAct) {
    const isPending = ['REQUESTED', 'PENDING_APPROVAL', 'RESCHEDULED'].includes(booking.status);
    const isConfirmed = booking.status === 'CONFIRMED';
    const ref = escapeHTML(booking.reference);
    const actions = canAct ? `
      <div class="request-actions">
        ${isPending ? `<button class="action-approve" data-action="approve" data-ref="${ref}">${booking.status === 'RESCHEDULED' ? 'اعتماد الوقت المقترح' : 'قبول وحجز'}</button><button data-action="reschedule" data-ref="${ref}">اقتراح وقت بديل</button><button class="action-danger" data-action="cancel" data-ref="${ref}">رفض / إلغاء</button>` : ''}
        ${isConfirmed ? `<button data-action="move" data-ref="${ref}">تعديل الموعد</button><button data-action="complete" data-ref="${ref}">إكمال الزيارة</button><button data-action="cancel" data-ref="${ref}" class="action-danger">إلغاء</button><a class="text-button" href="${whatsappLink(booking)}" target="_blank" rel="noopener noreferrer">رسالة WhatsApp</a>` : ''}
        ${booking.status === 'RESCHEDULED' ? `<a class="text-button" href="${whatsappLink(booking, true)}" target="_blank" rel="noopener noreferrer">إرسال الاقتراح يدويًا</a>` : ''}
      </div>` : '';
    return `<article class="request-item">
      <div class="request-item-top">
        <div>
          <h4>${escapeHTML(booking.guardianName)} <span class="request-ref">${ref}</span></h4>
          <div class="request-meta">${escapeHTML(booking.visitType)} · ${escapeHTML(bookingDateTime(booking))}<br>${escapeHTML(booking.phone)}</div>
        </div>
        <span class="status-pill ${statusClass(booking.status)}">${escapeHTML(formatStatus(booking.status))}</span>
      </div>${actions}
    </article>`;
  }

  async function loginStaff(event) {
    event.preventDefault();
    const pin = $('#staffPin').value.trim();
    $('#staffLoginError').hidden = true;
    try {
      const response = await api('getDashboard', pin);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر فتح لوحة الموظف.');
      state.staffPin = pin;
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
    const today = localISO(new Date());
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
  function revealOnScroll() {
    if (reduceMotion || !('IntersectionObserver' in window)) return;
    const targets = [...$$('.card, .side-card, .tool-card, .steps-strip')];
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.style.transition = 'opacity .6s cubic-bezier(.22,.61,.36,1), transform .6s cubic-bezier(.22,.61,.36,1)';
        entry.target.style.opacity = '1';
        entry.target.style.transform = 'none';
        observer.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    targets.forEach((node) => {
      const box = node.getBoundingClientRect();
      if (box.top < window.innerHeight) return;
      node.style.opacity = '0';
      node.style.transform = 'translateY(18px)';
      observer.observe(node);
    });
  }

  /* ---------------- wiring + boot ---------------- */
  function init() {
    $$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
    $$('.choice-card input').forEach((input) => input.addEventListener('change', () => {
      $$('.choice-card').forEach((card) => card.classList.toggle('selected', card.querySelector('input').checked));
    }));
    $('#visitDate').addEventListener('change', (event) => loadAvailability(event.target.value));
    $$('.choice-card input').forEach((input) => input.addEventListener('change', () => loadAvailability($('#visitDate').value)));
    $('#bookingForm').addEventListener('submit', submitBooking);
    $('#trackForm').addEventListener('submit', trackRequest);
    $('#staffLoginForm').addEventListener('submit', loginStaff);
    $('#pendingList').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) staffAction(button); });
    $('#weekList').addEventListener('click', (event) => { const button = event.target.closest('[data-action]'); if (button) staffAction(button); });
    $('#closureForm').addEventListener('submit', closeDay);
    $('#faqForm').addEventListener('submit', askQuestion);
    $('#trackReference').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase(); });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.view === 'staff' && state.staffPin) refreshDashboard(); });

    try {
      setMode();
      setDateDefault();
      renderDayChips();
      startClock();
      loadAvailability(state.selectedDay);
      requestAnimationFrame(revealOnScroll);
    } catch (error) {
      console.error('Celia Kids failed to start', error);
    }
  }

  // Works whether the script is deferred in <head> or inlined at the end of <body>.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
