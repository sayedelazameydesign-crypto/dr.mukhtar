/**
 * Celia Kids MVP — Google Apps Script backend.
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
  MAX_OUTAGE_REQUESTS: 25,
  MAX_OUTAGE_AUDITS: 100
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Celia Kids | حجز مواعيد الأطفال')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
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
  ensureSheet_(ss, CK.REQUESTS, CK.REQUEST_HEADERS);
  ensureSheet_(ss, CK.AUDIT, CK.AUDIT_HEADERS);
  ensureSheet_(ss, CK.CLOSURES, CK.CLOSURE_HEADERS);
  [CK.REQUESTS, CK.AUDIT, CK.CLOSURES].forEach((name) => {
    const sheet = ss.getSheetByName(name);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold').setBackground('#e3f2ec');
  });
  const calendar = ensureClinicCalendar_(props);
  return 'تم تجهيز أوراق Requests وAudit وClosures وربط تقويم: ' + calendar.getName() + '. أضف ADMIN_PIN وأوقات الدوام قبل النشر.';
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

function ensureSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getAvailableSlots(day, visitType) {
  try {
    if (!isValidDay_(day)) return { ok: false, message: 'التاريخ غير صحيح.' };
    const config = getConfig_();
    const date = makeDate_(day, config.start);
    if (!config.workDays.includes(date.getDay())) return { ok: true, slots: [] };
    const minutes = config.duration;
    const visitMinutes = visitDuration_(visitType || 'كشف جديد');
    const startMinutes = timeToMinutes_(config.start);
    const endMinutes = timeToMinutes_(config.end);
    const slots = [];
    for (let minute = startMinutes; minute + visitMinutes <= endMinutes; minute += minutes) {
      const time = minutesToTime_(minute);
      if (isSlotAvailable_(day, time, visitMinutes, '')) slots.push(time);
    }
    return { ok: true, slots: slots };
  } catch (error) {
    return { ok: false, message: 'تعذر التحقق من تقويم العيادة الآن. يمكن إرسال وقت مفضل للمراجعة دون تأكيد.' };
  }
}

/** Public intake: creates a pending request, never a Calendar event. */
function createRequest(payload) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك طلب آخر قيد المعالجة. حاولوا مرة أخرى بعد لحظات.' };
  try {
    const clean = validateRequest_(payload);
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
    return { ok: true, booking: publicBooking_(record), savedLocally: savedLocally, warning: warning };
  } catch (error) {
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
    return { ok: true, booking: { reference: record.reference, day: record.day, time: record.time, status: record.status } };
  } catch (error) {
    return { ok: false, message: 'تعذر قراءة حالة الطلب حالياً. احتفظوا بالرقم المرجعي وتواصلوا مع العيادة.' };
  }
}

/** Every staff operation checks the secret stored in Script Properties. */
function getDashboard(pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح أو لم يُضبط بعد.' };
  const warnings = [];
  try { syncOutageQueue_(); }
  catch (error) { warnings.push('تعذر مزامنة سجل الطلبات مع Sheets؛ الطلبات الاحتياطية محفوظة للمراجعة عند عودة الخدمة.'); }
  let bookings = [];
  try { bookings = readAllRequests_(); }
  catch (error) { warnings.push('تعذر الوصول إلى Google Sheets. راجعوا الاتصال قبل اتخاذ إجراء.'); }
  const closures = [];
  try { closures.push.apply(closures, readClosures_()); }
  catch (error) { warnings.push('تعذر قراءة إغلاقات الدوام.'); }
  const queued = readOutageQueue_();
  if (queued.length) warnings.push('توجد طلبات محفوظة مؤقتاً في طابور الانقطاع ولم تُزامن بعد. لا تؤكدوا هذه الطلبات حتى عودة Sheets.');
  const pendingAuditCount = Object.keys(PropertiesService.getScriptProperties().getProperties()).filter((key) => key.indexOf(CK.AUDIT_QUEUE_PREFIX) === 0).length;
  if (pendingAuditCount) warnings.push('توجد تغييرات بانتظار مزامنة سجل التدقيق.');
  queued.forEach((item) => { if (!bookings.some((b) => b.reference === item.reference)) bookings.push(item); });
  bookings.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { ok: true, bookings: bookings, closures: closures, warnings: warnings };
}

function approveRequest(reference, pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح.' };
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
    const auditStored = auditBestEffort_(record.reference, 'staff', 'APPROVED_AND_SAVED', oldStatus, 'CONFIRMED', 'calendar event id stored');
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم حفظ الموعد لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) {
    return { ok: false, message: error.message || 'تعذرت الموافقة. لم يُعرض تأكيد.' };
  } finally { lock.releaseLock(); }
}

function proposeAlternative(reference, day, time, pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح.' };
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
    const auditStored = auditBestEffort_(record.reference, 'staff', 'ALTERNATIVE_PROPOSED', oldStatus, 'RESCHEDULED', day + ' ' + time);
    return { ok: true, booking: publicBooking_(record), message: 'تم تسجيل الاقتراح فقط؛ لم يُنشأ حدث ولم يتأكد الموعد.', warning: auditStored ? '' : 'تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تسجيل الوقت البديل.' }; }
  finally { lock.releaseLock(); }
}

function moveConfirmedAppointment(reference, day, time, reason, pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح.' };
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
    record.day = day; record.time = time; record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    const auditStored = auditBestEffort_(record.reference, 'staff', 'CONFIRMED_APPOINTMENT_MOVED', 'CONFIRMED', 'CONFIRMED', `${oldDay} ${oldTime} -> ${day} ${time}; ${String(reason || '').slice(0, 80)}`);
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم تحديث الموعد لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تعديل الموعد.' }; }
  finally { lock.releaseLock(); }
}

function cancelRequest(reference, reason, pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح.' };
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
    const auditStored = auditBestEffort_(record.reference, 'staff', 'CANCELLED', oldStatus, 'CANCELLED', String(reason || '').slice(0, 100));
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم الإلغاء لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر إلغاء الطلب.' }; }
  finally { lock.releaseLock(); }
}

function completeRequest(reference, pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    const located = findRequestLocation_(reference);
    if (!located || located.queueKey) return { ok: false, message: 'تعذر العثور على طلب محفوظ في Sheets.' };
    const record = located.record;
    if (record.status !== 'CONFIRMED') return { ok: false, message: 'يمكن إكمال زيارة مؤكدة فقط.' };
    record.status = 'COMPLETED'; record.updatedAt = new Date().toISOString();
    updateRequestRow_(located.row, record);
    const auditStored = auditBestEffort_(record.reference, 'staff', 'VISIT_COMPLETED', 'CONFIRMED', 'COMPLETED', '');
    return { ok: true, booking: publicBooking_(record), warning: auditStored ? '' : 'تم تحديث الحالة لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تحديث حالة الزيارة.' }; }
  finally { lock.releaseLock(); }
}

function closeDay(day, label, pin) {
  if (!isStaff_(pin)) return { ok: false, message: 'رمز الموظف غير صحيح.' };
  if (!isValidDay_(day)) return { ok: false, message: 'التاريخ غير صحيح.' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, message: 'هناك إجراء آخر قيد المعالجة. حاولوا مجدداً.' };
  try {
    const sheet = closuresSheet_();
    const existing = readClosures_().some((item) => item.day === day && item.start === '' && item.end === '');
    if (!existing) sheet.appendRow([day, '', '', String(label || 'إغلاق يوم').slice(0, 80), new Date().toISOString()]);
    const auditStored = auditBestEffort_('', 'staff', 'DAY_CLOSED', '', '', day + ' ' + String(label || '').slice(0, 80));
    return { ok: true, warning: auditStored ? '' : 'تم إغلاق اليوم لكن تعذر حفظ سجل التدقيق؛ أُبلغوا مسؤول النظام.' };
  } catch (error) { return { ok: false, message: error.message || 'تعذر تسجيل الإغلاق.' }; }
  finally { lock.releaseLock(); }
}

/** Optional administrative FAQ only. This endpoint is isolated from booking/calendar decisions. */
function askGeneralQuestion(question) {
  const text = String(question || '').trim().slice(0, 500);
  if (!text) return { ok: false, message: 'اكتبوا سؤالاً إدارياً قصيراً.' };
  if (/(أعراض|اعراض|حرارة|حمى|سخونية|دواء|علاج|جرعة|تشخيص|طفح|سعال|كحة|قيء|إسهال|اسهال|ألم|الم|نزيف|طوارئ|تنفس|حساسية|emergency|fever|symptom|medicine|medication|diagnos|dose|rash|vomit|pain|treatment|breathing|allerg)/i.test(text)) {
    return { ok: true, answer: 'لا أقدم إرشادات طبية أو تشخيصاً. يرجى التواصل مع طبيب مؤهل، وفي الحالات الطارئة توجهوا فوراً إلى خدمات الطوارئ المحلية.' };
  }
  if (/@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?\d[\d\s().-]{8,}\d)/i.test(text)) return { ok: false, message: 'لا ترسلوا بريداً إلكترونياً أو رقم هاتف في سؤال Gemini. يمكنكم متابعة الحجز دونها.' };
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, message: 'مساعدة Gemini غير مفعلة. يمكنكم متابعة الحجز دونها.' };
  if (!reserveGeminiQuota_()) return { ok: false, message: 'وصلت مساعدة Gemini إلى حد الاستخدام اليومي أو أنها مشغولة. يمكنكم متابعة الحجز دونها.' };
  const model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const payload = {
    systemInstruction: { parts: [{ text: 'أنت مساعد إداري لعيادة أطفال، لا تقدم أي تشخيص أو علاج أو نصيحة صحية أو طبية. أجب فقط عن إجراءات الحجز، حالة الطلب، ساعات العمل المذكورة في السؤال، والتواصل الإداري. لا تطلب بيانات شخصية أو صحية. إذا سئلت عن أعراض أو دواء أو حالة عاجلة، ارفض الإرشاد الطبي ووجّه المستخدم إلى طبيب مؤهل أو خدمات الطوارئ المحلية. إذا كانت المعلومة غير متاحة فقل ذلك بوضوح. أجب بالعربية بإيجاز.' }] },
    contents: [{ role: 'user', parts: [{ text: text }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 220 }
  };
  try {
    const response = UrlFetchApp.fetch(endpoint, { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key }, payload: JSON.stringify(payload), muteHttpExceptions: true });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) return { ok: false, message: 'تعذرت مساعدة Gemini الآن؛ استمروا بالحجز أو تواصلوا مع العيادة.' };
    const body = JSON.parse(response.getContentText());
    const answer = body.candidates && body.candidates[0] && body.candidates[0].content && body.candidates[0].content.parts && body.candidates[0].content.parts.map((part) => part.text || '').join('').trim();
    return answer ? { ok: true, answer: answer } : { ok: false, message: 'لم تصل إجابة. يمكنكم متابعة الحجز دون Gemini.' };
  } catch (error) {
    return { ok: false, message: 'مساعدة Gemini غير متاحة الآن. يمكنكم متابعة الحجز دونها.' };
  }
}

function reserveGeminiQuota_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(4000)) return false;
  try {
    const properties = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), getConfig_().timezone, 'yyyy-MM-dd');
    const previousDay = properties.getProperty('GEMINI_USAGE_DAY') || '';
    const used = previousDay === today ? Number(properties.getProperty('GEMINI_USAGE_COUNT') || 0) : 0;
    const limit = Math.min(500, positiveNumber_(properties.getProperty('GEMINI_DAILY_LIMIT'), 25));
    if (used >= limit) return false;
    properties.setProperties({ GEMINI_USAGE_DAY: today, GEMINI_USAGE_COUNT: String(used + 1) });
    return true;
  } finally { lock.releaseLock(); }
}

function getConfig_() {
  const properties = PropertiesService.getScriptProperties();
  return {
    start: properties.getProperty('WORK_START') || CK.DEFAULT_START,
    end: properties.getProperty('WORK_END') || CK.DEFAULT_END,
    duration: positiveNumber_(properties.getProperty('SLOT_MINUTES'), CK.DEFAULT_MINUTES),
    workDays: (properties.getProperty('WORK_DAYS') || CK.DEFAULT_WORK_DAYS).split(',').map((v) => Number(v.trim())).filter((v) => v >= 0 && v <= 6),
    timezone: properties.getProperty('TIMEZONE') || Session.getScriptTimeZone() || 'Africa/Cairo'
  };
}
function visitDuration_(visitType) {
  const props = PropertiesService.getScriptProperties();
  const property = visitType === 'متابعة' ? 'FOLLOWUP_MINUTES' : 'NEW_VISIT_MINUTES';
  return positiveNumber_(props.getProperty(property), positiveNumber_(props.getProperty('SLOT_MINUTES'), CK.DEFAULT_MINUTES));
}
function positiveNumber_(value, fallback) { const number = Number(value); return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback; }
function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('CELIA_SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('لم يتم إعداد Google Sheets. شغّل initializeCeliaKids() أولاً.');
}
function requestsSheet_() { return getSpreadsheet_().getSheetByName(CK.REQUESTS) || ensureSheet_(getSpreadsheet_(), CK.REQUESTS, CK.REQUEST_HEADERS); }
function closuresSheet_() { return getSpreadsheet_().getSheetByName(CK.CLOSURES) || ensureSheet_(getSpreadsheet_(), CK.CLOSURES, CK.CLOSURE_HEADERS); }
function auditSheet_() { return getSpreadsheet_().getSheetByName(CK.AUDIT) || ensureSheet_(getSpreadsheet_(), CK.AUDIT, CK.AUDIT_HEADERS); }
function getCalendar_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID') || 'primary';
  const calendar = id === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(id);
  if (!calendar) throw new Error('تعذر العثور على تقويم العيادة. راجع CALENDAR_ID.');
  return calendar;
}
function isStaff_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  const candidate = String(pin || '');
  return !!expected && expected.length >= 20 && candidate.length === expected.length && constantTimeEquals_(candidate, expected);
}
function constantTimeEquals_(a, b) { let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
function validateRequest_(payload) {
  if (!payload || payload.consent !== true) throw new Error('يلزم تأكيد الموافقة على استخدام بيانات التواصل لإدارة الطلب.');
  const visitType = String(payload.visitType || '').trim();
  if (!['كشف جديد', 'متابعة'].includes(visitType)) throw new Error('نوع الزيارة غير صحيح.');
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
function makeDate_(day, time) {
  if (!isValidDay_(day) || !isValidTime_(time)) throw new Error('التاريخ أو الوقت غير صحيح.');
  const d = String(day).split('-').map(Number); const t = String(time).split(':').map(Number);
  const date = new Date(d[0], d[1] - 1, d[2], t[0], t[1], 0, 0);
  if (Utilities.formatDate(date, getConfig_().timezone, 'yyyy-MM-dd') !== day) throw new Error('التاريخ غير صالح.');
  return date;
}
function timeToMinutes_(time) { const p = time.split(':').map(Number); return p[0] * 60 + p[1]; }
function minutesToTime_(minutes) { return ('0' + Math.floor(minutes / 60)).slice(-2) + ':' + ('0' + (minutes % 60)).slice(-2); }
function isSlotAvailable_(day, time, duration, excludeEventId) {
  const config = getConfig_();
  if (!isValidDay_(day) || !isValidTime_(time)) return false;
  const start = makeDate_(day, time); const end = new Date(start.getTime() + duration * 60000);
  if (start <= new Date() || !config.workDays.includes(start.getDay()) || timeToMinutes_(time) < timeToMinutes_(config.start) || (timeToMinutes_(time) - timeToMinutes_(config.start)) % config.duration !== 0 || timeToMinutes_(time) + duration > timeToMinutes_(config.end)) return false;
  if (readClosures_().some((item) => item.day === day && intervalsOverlap_(time, duration, item.start, item.end))) return false;
  const events = getCalendar_().getEvents(start, end);
  return !events.some((event) => event.getId() !== excludeEventId && event.getStartTime() < end && event.getEndTime() > start);
}
function intervalsOverlap_(time, duration, otherStart, otherEnd) {
  if (!otherStart || !otherEnd) return true;
  const start = timeToMinutes_(time); const end = start + duration;
  return start < timeToMinutes_(otherEnd) && end > timeToMinutes_(otherStart);
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
  const map = new Map(); result.forEach((item) => map.set(item.reference, item));
  readOutageQueue_().forEach((item) => { if (!map.has(item.reference)) map.set(item.reference, item); });
  return Array.from(map.values());
}
function readOutageQueue_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(props).filter((key) => key.indexOf(CK.QUEUE_PREFIX) === 0).map((key) => { try { return JSON.parse(props[key]); } catch (_) { return null; } }).filter(Boolean);
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
  Object.keys(all).filter((key) => key.indexOf(CK.AUDIT_QUEUE_PREFIX) === 0).forEach((key) => { try { sheet.appendRow(JSON.parse(all[key])); properties.deleteProperty(key); } catch (_) { /* leave queued for a later staff review */ } });
}
