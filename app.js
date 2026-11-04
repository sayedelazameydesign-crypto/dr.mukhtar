(() => {
  'use strict';
  const DEMO_KEY = 'celia-kids-demo-v1';
  const IS_GAS = typeof google !== 'undefined' && !!(google.script && google.script.run);
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const state = { view: 'booking', staffPin: '', selectedTime: '', selectedDay: '', slots: [], availabilityVerified: false, bookings: [], closures: [], busy: false };
  const DEMO_PIN = '2468';
  const FALLBACK_SLOTS = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00'];
  const statusText = { REQUESTED: 'طلب مستلم', PENDING_APPROVAL: 'بانتظار موافقة العيادة', CONFIRMED: 'مؤكد من العيادة', RESCHEDULED: 'وقت بديل مقترح', CANCELLED: 'ملغي', COMPLETED: 'مكتمل' };

  function localISO(date) { const y = date.getFullYear(); const m = String(date.getMonth() + 1).padStart(2, '0'); const d = String(date.getDate()).padStart(2, '0'); return `${y}-${m}-${d}`; }
  function nextWorkday(offset = 1) { const date = new Date(); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() + offset); while ([5, 6].includes(date.getDay())) date.setDate(date.getDate() + 1); return date; }
  function prettyDate(iso) { if (!iso) return '—'; const parts = iso.split('-').map(Number); const d = new Date(parts[0], parts[1] - 1, parts[2]); return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' }).format(d); }
  function prettyTime(time) { if (!time) return ''; const [h, m] = time.split(':').map(Number); return new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(2020, 0, 1, h, m)); }
  function digits(value) { return String(value || '').replace(/\D/g, ''); }
  function newRef() { return `CK-${Math.random().toString(36).slice(2, 12).toUpperCase()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`; }
  function escapeHTML(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
  function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 3300); }

  function seedDemo() {
    try {
      const current = JSON.parse(localStorage.getItem(DEMO_KEY));
      if (current && Array.isArray(current.bookings)) return current;
    } catch (_) { /* reset damaged local demo data */ }
    const tomorrow = localISO(nextWorkday(1));
    const later = localISO(nextWorkday(2));
    const initial = {
      bookings: [
        { reference: 'CK-DEMO-8K2P', createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL', visitType: 'كشف جديد', guardianName: 'مريم تجريبية', phone: '0000000000', day: tomorrow, time: '10:00', eventId: '', consent: true },
        { reference: 'CK-DEMO-4M7Q', createdAt: new Date().toISOString(), status: 'CONFIRMED', visitType: 'متابعة', guardianName: 'عمر تجريبي', phone: '0000000001', day: later, time: '11:00', eventId: '', consent: true }
      ], closures: []
    };
    localStorage.setItem(DEMO_KEY, JSON.stringify(initial));
    return initial;
  }
  function demoStore() { const stored = seedDemo(); return stored; }
  function saveDemo(store) { localStorage.setItem(DEMO_KEY, JSON.stringify(store)); }
  function callServer(method, ...args) {
    return new Promise((resolve, reject) => {
      try { google.script.run.withSuccessHandler(resolve).withFailureHandler((error) => reject(new Error(error && error.message ? error.message : 'تعذر الاتصال بخدمة العيادة.')))[method](...args); }
      catch (error) { reject(error); }
    });
  }
  async function api(method, ...args) {
    if (IS_GAS) return callServer(method, ...args);
    const store = demoStore();
    if (method === 'getAvailableSlots') {
      const day = args[0];
      const closed = store.closures.some((item) => item.day === day);
      if (closed) return { ok: true, slots: [] };
      const taken = new Set(store.bookings.filter((item) => item.day === day && item.status === 'CONFIRMED').map((item) => item.time));
      return { ok: true, slots: FALLBACK_SLOTS.filter((time) => !taken.has(time)) };
    }
    if (method === 'createRequest') {
      const payload = args[0];
      const booked = store.bookings.some((item) => item.day === payload.day && item.time === payload.time && item.status === 'CONFIRMED');
      if (booked) return { ok: false, message: 'اختير هذا الوقت للتو. يرجى اختيار وقت آخر.' };
      const booking = { ...payload, reference: newRef(), createdAt: new Date().toISOString(), status: 'PENDING_APPROVAL', eventId: '', consent: true };
      store.bookings.unshift(booking); saveDemo(store);
      return { ok: true, booking, savedLocally: true };
    }
    if (method === 'lookupBooking') {
      const ref = String(args[0] || '').trim().toUpperCase();
      const booking = store.bookings.find((item) => item.reference.toUpperCase() === ref);
      return booking ? { ok: true, booking: { reference: booking.reference, day: booking.day, time: booking.time, status: booking.status } } : { ok: false, message: 'لم نعثر على طلب بهذا الرقم.' };
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
      if (collision) return { ok: false, message: 'هذا الوقت لم يعد متاحاً.' };
      booking.status = 'CONFIRMED'; booking.updatedAt = new Date().toISOString(); saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'proposeAlternative') {
      if (args[3] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      const conflict = store.bookings.some((item) => item.reference !== args[0] && item.day === args[1] && item.time === args[2] && item.status === 'CONFIRMED');
      if (!booking || conflict) return { ok: false, message: conflict ? 'الوقت البديل مشغول.' : 'الطلب غير موجود.' };
      booking.day = args[1]; booking.time = args[2]; booking.status = 'RESCHEDULED'; booking.updatedAt = new Date().toISOString(); saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'cancelRequest') {
      if (args[2] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking) return { ok: false, message: 'الطلب غير موجود.' };
      booking.status = 'CANCELLED'; booking.updatedAt = new Date().toISOString(); saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'completeRequest') {
      if (args[1] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      if (!booking) return { ok: false, message: 'الطلب غير موجود.' };
      booking.status = 'COMPLETED'; booking.updatedAt = new Date().toISOString(); saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'moveConfirmedAppointment') {
      if (args[4] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      const booking = store.bookings.find((item) => item.reference === args[0]);
      const conflict = store.bookings.some((item) => item.reference !== args[0] && item.day === args[1] && item.time === args[2] && item.status === 'CONFIRMED');
      if (!booking || conflict) return { ok: false, message: conflict ? 'الوقت البديل مشغول.' : 'الطلب غير موجود.' };
      booking.day = args[1]; booking.time = args[2]; booking.updatedAt = new Date().toISOString(); saveDemo(store);
      return { ok: true, booking };
    }
    if (method === 'closeDay') {
      if (args[2] !== DEMO_PIN) return { ok: false, message: 'رمز الموظف غير صحيح.' };
      if (!store.closures.some((item) => item.day === args[0])) store.closures.push({ day: args[0], label: args[1] || 'إغلاق يوم' });
      saveDemo(store); return { ok: true };
    }
    if (method === 'askGeneralQuestion') return { ok: true, answer: 'هذا وضع عرض تجريبي. يمكن لفريق العيادة مساعدتكم في خطوات الحجز وتعديل الطلب. لا أقدم معلومات طبية أو تشخيصاً.' };
    return { ok: false, message: 'هذه الوظيفة غير متاحة في العرض.' };
  }

  function setView(view) {
    state.view = view;
    $('#bookingView').hidden = view !== 'booking'; $('#staffView').hidden = view !== 'staff';
    $$('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    if (view === 'staff' && state.staffPin) refreshDashboard();
  }
  function setMode() {
    $('#modeLabel').textContent = IS_GAS ? 'مرتبط بـ Google' : 'وضع تجريبي';
    $('#modePill').classList.toggle('live', IS_GAS);
    $('#environmentBanner').hidden = IS_GAS;
    $('#demoPinHint').hidden = IS_GAS;
    $('#geminiStatus').textContent = IS_GAS ? 'Gemini عند التفعيل' : 'أسئلة تجريبية';
    if (IS_GAS) $('#availabilityNote').textContent = '';
  }
  function setDateDefault() {
    const input = $('#visitDate'); const tomorrow = localISO(nextWorkday(1)); input.min = localISO(new Date()); input.value = tomorrow; state.selectedDay = tomorrow;
    $('#closureDate').min = localISO(new Date()); $('#closureDate').value = tomorrow;
  }
  function selectTime(time) {
    state.selectedTime = time; $('#visitTime').value = time;
    $$('#slotsGrid .slot-button').forEach((button) => { const selected = button.dataset.time === time; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  }
  function renderSlots(slots, unverified = false) {
    const grid = $('#slotsGrid'); grid.replaceChildren(); state.slots = slots || []; state.availabilityVerified = !unverified;
    if (!slots || !slots.length) { grid.innerHTML = '<span class="empty-slots">لا توجد أوقات متاحة في هذا اليوم. اختاروا يوماً آخر.</span>'; $('#slotStatus').textContent = 'لا توجد أوقات'; state.selectedTime = ''; $('#visitTime').value = ''; return; }
    $('#slotStatus').textContent = unverified ? 'أوقات مفضلة فقط' : `${slots.length.toLocaleString('ar-EG')} أوقات`;
    slots.forEach((slot) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'slot-button'; button.dataset.time = slot; button.textContent = prettyTime(slot); button.setAttribute('aria-pressed', 'false'); button.addEventListener('click', () => selectTime(slot)); grid.appendChild(button); });
    if (state.selectedTime && slots.includes(state.selectedTime)) selectTime(state.selectedTime); else { state.selectedTime = ''; $('#visitTime').value = ''; }
  }
  async function loadAvailability(day) {
    state.selectedDay = day; state.selectedTime = ''; $('#visitTime').value = ''; $('#slotStatus').textContent = 'جارٍ التحقق...'; $('#slotsGrid').innerHTML = '<span class="empty-slots">لحظة من فضلكم…</span>'; $('#availabilityNote').hidden = true;
    try {
      const visitType = $('#bookingForm').elements.visitType.value;
      const result = await api('getAvailableSlots', day, visitType);
      if (!result || !result.ok) throw new Error(result && result.message ? result.message : 'تعذر التحقق من التقويم.');
      renderSlots(result.slots || [], false);
    } catch (error) {
      renderSlots(FALLBACK_SLOTS, true);
      $('#availabilityNote').textContent = 'تعذر الاتصال بالتقويم الآن. يمكن إرسال الوقت كتفضيل فقط؛ سيبقى الطلب غير مؤكد ويحتاج مراجعة العيادة.';
      $('#availabilityNote').hidden = false; $('#slotStatus').textContent = 'تعذر التحقق';
    }
  }
  function formatStatus(status) { return statusText[status] || status || 'قيد المراجعة'; }
  function showBookingResult(booking, savedLocally = false, localDemo = false, warning = '') {
    const result = $('#bookingResult');
    const note = warning || (localDemo ? 'هذا سجل محلي تجريبي على هذا المتصفح ولا يصل إلى العيادة.' : savedLocally ? 'تم حفظ الطلب مؤقتاً في نظام العيادة أثناء تعطل Sheets. لن يتأكد الموعد حتى عودة السجل ومراجعته.' : booking.slotVerified === false ? 'حُفظ الوقت كتفضيل فقط لأن التقويم لم يكن متاحاً للتحقق. يلزم مراجعة العيادة قبل الموافقة.' : 'سيراجع فريق العيادة الطلب، وسيؤكد الموعد أو يتواصل معكم بشأن وقت بديل.');
    result.innerHTML = `<div class="result-top"><span class="result-check" aria-hidden="true">✓</span><div><h3>وصل طلبكم إلى العيادة</h3><p>حالة الطلب: <strong>${escapeHTML(formatStatus(booking.status))}</strong>. لم يتأكد الموعد بعد.</p></div></div><span class="reference-chip">${escapeHTML(booking.reference)}</span><div class="result-meta"><span>اليوم: ${escapeHTML(prettyDate(booking.day))}</span><span>الوقت المفضل: ${escapeHTML(prettyTime(booking.time))}</span></div><p class="result-note">${note}</p>`;
    result.hidden = false; result.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  async function submitBooking(event) {
    event.preventDefault(); if (state.busy) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    if (!state.selectedTime) { toast('اختاروا وقتاً مفضلاً أولاً.'); return; }
    if (!$('#consent').checked) { toast('يرجى الموافقة على استخدام بيانات التواصل لإدارة الطلب.'); return; }
    const phone = $('#phone').value.trim(); if (digits(phone).length < 8) { toast('تحققوا من رقم الهاتف.'); $('#phone').focus(); return; }
    const payload = { visitType: form.elements.visitType.value, day: state.selectedDay, time: state.selectedTime, guardianName: $('#guardianName').value.trim(), phone, consent: true };
    state.busy = true; const submit = $('#submitBooking'); submit.disabled = true; submit.querySelector('span').textContent = 'جارٍ إرسال الطلب…';
    try {
      const response = await api('createRequest', payload);
      if (!response || !response.ok) throw new Error(response && response.message ? response.message : 'تعذر حفظ الطلب. يرجى المحاولة مجدداً.');
      showBookingResult(response.booking, !!response.savedLocally, !IS_GAS, response.warning || '');
      form.reset(); $$('.choice-card').forEach((card, index) => card.classList.toggle('selected', index === 0));
      selectTime(''); await loadAvailability(state.selectedDay);
    } catch (error) { toast(error.message || 'تعذر حفظ الطلب. لم نعرض تأكيداً.'); }
    finally { state.busy = false; submit.disabled = false; submit.querySelector('span').textContent = 'إرسال طلب الموعد'; }
  }
  async function trackRequest(event) {
    event.preventDefault(); const ref = $('#trackReference').value.trim(); const target = $('#trackResult'); target.hidden = false; target.className = 'track-result'; target.textContent = 'جارٍ البحث…';
    try { const response = await api('lookupBooking', ref); if (!response || !response.ok) throw new Error(response && response.message || 'لم نعثر على طلب بهذا الرقم.'); target.innerHTML = `<strong>${escapeHTML(formatStatus(response.booking.status))}</strong><br>${escapeHTML(prettyDate(response.booking.day))} · ${escapeHTML(prettyTime(response.booking.time))} · ${escapeHTML(response.booking.reference)}`; }
    catch (error) { target.classList.add('error'); target.textContent = error.message; }
  }
  function statusClass(status) { return status === 'CONFIRMED' || status === 'COMPLETED' ? 'confirmed' : status === 'CANCELLED' ? 'cancelled' : status === 'RESCHEDULED' ? 'rescheduled' : ''; }
  function bookingDateTime(booking) { return `${prettyDate(booking.day)} · ${prettyTime(booking.time)}`; }
  function whatsappLink(booking, proposal = false) {
    let number = digits(booking.phone); if (number.startsWith('0')) number = `20${number.slice(1)}`; else if (number.length === 10 && number.startsWith('1')) number = `20${number}`;
    const clinic = IS_GAS ? 'عيادة الأطفال' : 'عيادة Celia Kids التجريبية';
    const prefix = proposal ? 'نقترح عليكم وقتاً بديلاً لطلب الموعد' : 'تم تأكيد موعدكم في';
    const message = `${prefix} لدى ${clinic}: ${prettyDate(booking.day)} الساعة ${prettyTime(booking.time)}. رقم الطلب: ${booking.reference}. للرد أو الاستفسار، تواصلوا مع العيادة.`;
    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
  }
  function currentWeekBookings(bookings) {
    const now = new Date(); const start = new Date(now); start.setHours(0,0,0,0); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return bookings.filter((item) => ['CONFIRMED','COMPLETED','RESCHEDULED'].includes(item.status)).filter((item) => { const day = new Date(`${item.day}T12:00:00`); return day >= start && day < end; }).sort((a,b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`));
  }
  function requestCard(booking, canAct) {
    const isPending = ['REQUESTED','PENDING_APPROVAL','RESCHEDULED'].includes(booking.status);
    const isConfirmed = booking.status === 'CONFIRMED';
    const actions = canAct ? `<div class="request-actions">${isPending ? `<button class="action-approve" data-action="approve" data-ref="${escapeHTML(booking.reference)}">${booking.status === 'RESCHEDULED' ? 'اعتماد الوقت المقترح' : 'قبول وحجز'}</button><button data-action="reschedule" data-ref="${escapeHTML(booking.reference)}">اقتراح وقت بديل</button><button class="action-danger" data-action="cancel" data-ref="${escapeHTML(booking.reference)}">رفض / إلغاء</button>` : ''}${isConfirmed ? `<button data-action="move" data-ref="${escapeHTML(booking.reference)}">تعديل الموعد</button><button data-action="complete" data-ref="${escapeHTML(booking.reference)}">إكمال الزيارة</button><button data-action="cancel" data-ref="${escapeHTML(booking.reference)}" class="action-danger">إلغاء</button><a class="text-button" href="${whatsappLink(booking)}" target="_blank" rel="noopener noreferrer">رسالة WhatsApp</a>` : ''}${booking.status === 'RESCHEDULED' ? `<a class="text-button" href="${whatsappLink(booking,true)}" target="_blank" rel="noopener noreferrer">إرسال الاقتراح يدوياً</a>` : ''}</div>` : '';
    return `<article class="request-item"><div class="request-item-top"><div><h4>${escapeHTML(booking.guardianName)} <span class="request-ref">${escapeHTML(booking.reference)}</span></h4><div class="request-meta">${escapeHTML(booking.visitType)} · ${escapeHTML(bookingDateTime(booking))}<br>${escapeHTML(booking.phone)}</div></div><span class="status-pill ${statusClass(booking.status)}">${escapeHTML(formatStatus(booking.status))}</span></div>${actions}</article>`;
  }
  async function loginStaff(event) {
    event.preventDefault(); const pin = $('#staffPin').value.trim(); $('#staffLoginError').hidden = true;
    try { const response = await api('getDashboard', pin); if (!response || !response.ok) throw new Error(response && response.message || 'تعذر فتح لوحة الموظف.'); state.staffPin = pin; $('#staffLogin').hidden = true; $('#staffDashboard').hidden = false; renderDashboard(response); }
    catch (error) { $('#staffLoginError').textContent = error.message; $('#staffLoginError').hidden = false; }
  }
  async function refreshDashboard() {
    try { const response = await api('getDashboard', state.staffPin); if (!response || !response.ok) throw new Error(response && response.message || 'تعذر تحميل لوحة الموظف.'); renderDashboard(response); }
    catch (error) { $('#staffAlerts').hidden = false; $('#staffAlerts').textContent = error.message; }
  }
  function renderDashboard(response) {
    const bookings = response.bookings || []; state.bookings = bookings; state.closures = response.closures || [];
    const pending = bookings.filter((item) => ['REQUESTED','PENDING_APPROVAL','RESCHEDULED'].includes(item.status));
    const today = localISO(new Date()); const todayConfirmed = bookings.filter((item) => item.day === today && ['CONFIRMED','COMPLETED'].includes(item.status)); const week = currentWeekBookings(bookings);
    $('#dashboardStats').innerHTML = `<div class="stat-card"><span>بانتظار القرار</span><strong>${pending.length.toLocaleString('ar-EG')}</strong><small>الطلب لا يحجز الوقت حتى اعتماده</small></div><div class="stat-card"><span>زيارات اليوم</span><strong>${todayConfirmed.length.toLocaleString('ar-EG')}</strong><small>${prettyDate(today)}</small></div><div class="stat-card"><span>مواعيد هذا الأسبوع</span><strong>${week.length.toLocaleString('ar-EG')}</strong><small>مؤكدة أو مكتملة</small></div>`;
    $('#pendingCount').textContent = pending.length.toLocaleString('ar-EG');
    $('#pendingList').innerHTML = pending.length ? pending.map((item) => requestCard(item, true)).join('') : '<div class="empty-list">لا توجد طلبات بانتظار المراجعة.</div>';
    $('#weekList').innerHTML = week.length ? week.map((item) => requestCard(item, true)).join('') : '<div class="empty-list">لا توجد مواعيد مؤكدة هذا الأسبوع.</div>';
    const alertBox = $('#staffAlerts'); const warnings = response.warnings || [];
    if (warnings.length) { alertBox.hidden = false; alertBox.textContent = warnings.join(' — '); } else alertBox.hidden = true;
  }
  async function staffAction(button) {
    const ref = button.dataset.ref; const action = button.dataset.action; const booking = state.bookings.find((item) => item.reference === ref); if (!booking) return;
    let method; let args;
    if (action === 'approve') { method = 'approveRequest'; args = [ref, state.staffPin]; }
    else if (action === 'cancel') { if (!confirm(`هل تريد إلغاء/رفض الطلب ${ref}؟`)) return; method = 'cancelRequest'; args = [ref, 'تم الإلغاء من العيادة', state.staffPin]; }
    else if (action === 'complete') { method = 'completeRequest'; args = [ref, state.staffPin]; }
    else if (action === 'reschedule' || action === 'move') {
      const day = prompt('أدخلوا التاريخ البديل بصيغة YYYY-MM-DD', booking.day); if (!day) return;
      const time = prompt('أدخلوا الوقت بصيغة HH:MM', booking.time); if (!time) return;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) { toast('صيغة التاريخ أو الوقت غير صحيحة.'); return; }
      method = action === 'move' ? 'moveConfirmedAppointment' : 'proposeAlternative';
      args = action === 'move' ? [ref, day, time, 'تعديل من لوحة العيادة', state.staffPin] : [ref, day, time, state.staffPin];
    } else return;
    button.disabled = true;
    try { const response = await api(method, ...args); if (!response || !response.ok) throw new Error(response && response.message || 'تعذر تنفيذ الإجراء.'); toast(response.warning || (action === 'approve' ? 'تمت الموافقة وحفظ الموعد.' : action === 'reschedule' ? 'سُجل الوقت البديل المقترح؛ لم يتأكد الموعد.' : 'تم تحديث الطلب.')); await refreshDashboard(); }
    catch (error) { toast(error.message); button.disabled = false; }
  }
  async function closeDay(event) {
    event.preventDefault(); const day = $('#closureDate').value; const label = $('#closureLabel').value.trim() || 'إغلاق يوم';
    try { const response = await api('closeDay', day, label, state.staffPin); if (!response || !response.ok) throw new Error(response && response.message || 'تعذر إغلاق اليوم.'); toast(response.warning || 'تم تسجيل إغلاق اليوم.'); $('#closureLabel').value = ''; await loadAvailability(state.selectedDay); await refreshDashboard(); }
    catch (error) { toast(error.message); }
  }
  async function askQuestion(event) {
    event.preventDefault(); const question = $('#faqQuestion').value.trim(); if (!question) return;
    const answer = $('#faqAnswer'); answer.hidden = false; answer.textContent = 'جارٍ تجهيز الإجابة…'; $('#faqQuestion').disabled = true;
    try { const result = await api('askGeneralQuestion', question); if (!result || !result.ok) throw new Error(result && result.message || 'المساعدة غير متاحة الآن.'); answer.textContent = result.answer; }
    catch (error) { answer.textContent = `${error.message} يمكنك إكمال الحجز دون هذه الخدمة.`; }
    finally { $('#faqQuestion').disabled = false; $('#faqQuestion').value = ''; }
  }

  $$('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  $$('.choice-card input').forEach((input) => input.addEventListener('change', () => $$('.choice-card').forEach((card) => card.classList.toggle('selected', card.contains(document.activeElement) || card.querySelector('input').checked))));
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
  setMode(); setDateDefault(); loadAvailability(state.selectedDay);
})();
