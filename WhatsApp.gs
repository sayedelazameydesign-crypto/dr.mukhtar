/**
 * Celia Kids — WhatsApp adapter boundary (provider-agnostic, OFF by default).
 *
 * Domain code (Code.gs) must never build a provider URL, name a Graph version, or read a
 * token. It calls `whatsappNotify_(kind, record)` and nothing else; swapping provider or
 * adding a Business Solution Provider means editing this file alone (AGENTS.md rule 5).
 *
 * Policy mapping:
 *  - `WHATSAPP_MODE` is `off` (default) | `dry-run` | `live`. An unknown value is treated as
 *    `off` and reported in `whatsappStatus().problems` — config never guesses silently (rule 7).
 *  - `dry-run` builds the exact request and returns it; it performs **no network call**.
 *    This is the mode approved for this phase: WhatsApp Cloud API bills business-initiated
 *    messages, which would introduce a payment method (rule 8 — Zero-Card). See
 *    docs/prd/whatsapp-cloud-api.md (D1 = ز٢ + dry-run).
 *  - No medical data ever leaves this file: messages carry a reference, a date and a time.
 *    The guardian's text is never stored or forwarded (rule 2, design decision D2 = و١).
 *  - Failures are typed and logged as structured JSON without the token or the full phone
 *    number, and they must never block a booking (rule 9).
 *  - Secrets stay in Script Properties; this file only names the properties (rule 4).
 */
const WHATSAPP = {
  MODE_PROPERTY: 'WHATSAPP_MODE',
  TOKEN_PROPERTY: 'WHATSAPP_TOKEN',
  PHONE_ID_PROPERTY: 'WHATSAPP_PHONE_NUMBER_ID',
  MODES: ['off', 'dry-run', 'live'],
  DEFAULT_MODE: 'off',
  // E.164 needs the clinic's country code. This is the CLINIC's code (Egypt), not the parent's:
  // every number the clinic will message is Egyptian.
  COUNTRY_CODE: '20',
  GRAPH_VERSION_PROPERTY: 'WHATSAPP_GRAPH_VERSION',
  // Meta's own send-message example uses v23.0; override per account without a code change.
  // The version that was hard-coded here (v21.0) is older than every example in Meta's current
  // documentation, and Meta publishes no support window for it — see docs/free-tiers.json.
  GRAPH_VERSION: 'v23.0',
  GRAPH_HOST: 'https://graph.facebook.com',
  SENT_PREFIX: 'WHATSAPP_SENT_',
  SENT_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  MAX_TRACKED: 200,
  MAX_TEXT_CHARS: 900
};

/**
 * Typed error: callers switch on `code`, never on message text.
 * @param {string} code
 * @param {string} message
 * @param {Object=} extra
 * @return {Error}
 */
function whatsappError_(code, message, extra) {
  const error = new Error(message);
  error.code = code;
  if (extra) Object.keys(extra).forEach(function (key) { error[key] = extra[key]; });
  return error;
}

/** @return {string} the configured mode, or 'off' when unset/invalid. */
function whatsappMode_() {
  const raw = String(PropertiesService.getScriptProperties().getProperty(WHATSAPP.MODE_PROPERTY) || '').trim();
  if (!raw) return WHATSAPP.DEFAULT_MODE;
  return WHATSAPP.MODES.indexOf(raw) >= 0 ? raw : WHATSAPP.DEFAULT_MODE;
}

/**
 * Operator-facing status. Never returns a token or a phone id, only whether they exist.
 * @return {{mode: string, configured: boolean, canSendLive: boolean, problems: string[]}}
 */
function whatsappStatus() {
  const props = PropertiesService.getScriptProperties();
  const raw = String(props.getProperty(WHATSAPP.MODE_PROPERTY) || '').trim();
  const mode = whatsappMode_();
  const configured = !!String(props.getProperty(WHATSAPP.TOKEN_PROPERTY) || '').trim()
    && !!String(props.getProperty(WHATSAPP.PHONE_ID_PROPERTY) || '').trim();
  const problems = [];
  if (raw && WHATSAPP.MODES.indexOf(raw) < 0) {
    problems.push('WHATSAPP_MODE غير معروف («' + raw + '») — يُعامَل كـ off. القيم المسموحة: ' + WHATSAPP.MODES.join(' | '));
  }
  if (mode === 'live' && !configured) {
    problems.push('الوضع live يتطلب WHATSAPP_TOKEN وWHATSAPP_PHONE_NUMBER_ID في Script Properties.');
  }
  return {
    mode: mode,
    graphVersion: whatsappGraphVersion_(props),
    configured: configured,
    // This is a configuration check, not proof of consent, policy compliance or delivery.
    // The live branch is technically reachable if both properties and mode are configured.
    canSendLive: mode === 'live' && configured,
    problems: problems
  };
}

/**
 * Egyptian numbers only, published form: local digits starting with 0.
 * Accepts +20 / 0020 / 20 prefixes; anything else is returned digit-only.
 * @param {*} value
 * @return {string}
 */
function whatsappNormalizePhone_(value) {
  let digits = String(value == null ? '' : value).replace(/[^0-9+]/g, '').replace(/^\+/, '');
  if (digits.indexOf('0020') === 0) digits = digits.slice(4);
  else if (digits.indexOf('20') === 0 && digits.length >= 12) digits = digits.slice(2);
  return digits ? '0' + digits.replace(/^0+/, '') : '';
}

/**
 * The number in the form Meta expects: E.164 with the country calling code and a plus sign.
 *
 * Meta's phone-number documentation is explicit: if the plus sign is omitted, the *business*
 * number's country calling code is prepended to what you sent. Sending the local Egyptian form
 * `01113593643` therefore becomes `+2001113593643` — an extra zero, i.e. a misdelivered message.
 * @param {*} value
 * @return {string} +<country><number>, or '' when the input has no digits
 */
function whatsappE164_(value) {
  const local = whatsappNormalizePhone_(value);
  if (!local) return '';
  if (local.charAt(0) === '0') return '+' + WHATSAPP.COUNTRY_CODE + local.slice(1);
  return '+' + local;
}

/** Graph version, validated: an unparsable override must not build a nonsense URL. */
function whatsappGraphVersion_(props) {
  const raw = String((props || PropertiesService.getScriptProperties()).getProperty(WHATSAPP.GRAPH_VERSION_PROPERTY) || '').trim();
  if (!raw) return WHATSAPP.GRAPH_VERSION;
  return /^v[0-9]{1,2}\.[0-9]{1,2}$/.test(raw) ? raw : WHATSAPP.GRAPH_VERSION;
}

/** Logs and results never carry a full number: keep the last three digits. */
function whatsappRedact_(phone) {
  const digits = String(phone || '');
  return digits.length <= 3 ? '•••' : '•••••' + digits.slice(-3);
}

/**
 * Human-readable Arabic message. No symptoms, no diagnosis, no free text from the guardian.
 * @param {string} kind confirmation | cancellation | reminder
 * @param {Object} record
 * @return {string}
 */
function whatsappText_(kind, record, clinicName) {
  const reference = String(record.reference || '').trim();
  const day = String(record.day || '').trim();
  const time = String(record.time || '').trim();
  const clinic = String(clinicName || record.clinicName || 'العيادة').trim();
  if (kind === 'confirmation') {
    return 'تم تأكيد موعدكم في ' + clinic + '.\nالرقم المرجعي: ' + reference + '\nالموعد: ' + day + ' — ' + time
      + '\nللاستفسار أو التعديل راسلونا على هذا الرقم.';
  }
  if (kind === 'cancellation') {
    return 'تم إلغاء الموعد رقم ' + reference + ' في ' + clinic
      + '.\nللتنسيق على موعد جديد راسلونا على هذا الرقم.';
  }
  if (kind === 'reminder') {
    return 'تذكير بموعدكم في ' + clinic + '.\nالموعد: ' + day + ' — ' + time
      + '\nالرقم المرجعي: ' + reference + '.';
  }
  throw whatsappError_('WHATSAPP_INVALID_KIND', 'نوع إشعار غير معروف: ' + String(kind));
}

/**
 * Build the exact request that `live` would send. Pure: no properties, no network.
 * @param {string} kind
 * @param {Object} record
 * @return {{to: string, url: string, body: Object, text: string}}
 */
function whatsappPlan_(kind, record) {
  const phone = whatsappNormalizePhone_(record && record.phone);
  if (!phone) throw whatsappError_('WHATSAPP_MISSING_PHONE', 'لا يوجد رقم تواصل صالح في الطلب.');
  // Meta requires the country calling code and the plus sign on the wire; the local form stays
  // the display/validation form used by the rest of the system.
  const wirePhone = whatsappE164_(phone);
  if (!String(record.reference || '').trim()) throw whatsappError_('WHATSAPP_MISSING_REFERENCE', 'لا يمكن إرسال إشعار بلا رقم مرجعي.');
  const props = PropertiesService.getScriptProperties();
  // The clinic name is display-only configuration: a missing value never becomes an invented brand.
  const clinicName = String(props.getProperty('CLINIC_NAME') || '').trim();
  const text = whatsappText_(kind, record, clinicName);
  if (text.length > WHATSAPP.MAX_TEXT_CHARS) throw whatsappError_('WHATSAPP_TEXT_TOO_LONG', 'نص الرسالة يتجاوز الحد.');
  const phoneId = String(props.getProperty(WHATSAPP.PHONE_ID_PROPERTY) || '').trim();
  return {
    to: wirePhone,
    local: phone,
    url: WHATSAPP.GRAPH_HOST + '/' + whatsappGraphVersion_(props) + '/' + (phoneId || '{WHATSAPP_PHONE_NUMBER_ID}') + '/messages',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: wirePhone,
      type: 'text',
      text: { preview_url: false, body: text }
    },
    text: text
  };
}

/** @return {boolean} true when this reference+kind was already sent inside the TTL. */
function whatsappAlreadySent_(reference, kind) {
  const props = PropertiesService.getScriptProperties();
  const key = WHATSAPP.SENT_PREFIX + String(reference) + '_' + String(kind);
  const raw = props.getProperty(key);
  if (!raw) return false;
  const at = Date.parse(raw);
  if (!isFinite(at) || (Date.now() - at) > WHATSAPP.SENT_TTL_MS) {
    props.deleteProperty(key);
    return false;
  }
  return true;
}

/** Record one successful send and keep the key space bounded. */
function whatsappRemember_(reference, kind) {
  const props = PropertiesService.getScriptProperties();
  const keys = props.getKeys().filter(function (key) { return key.indexOf(WHATSAPP.SENT_PREFIX) === 0; });
  if (keys.length >= WHATSAPP.MAX_TRACKED) {
    keys.sort(function (a, b) { return Date.parse(props.getProperty(a) || 0) - Date.parse(props.getProperty(b) || 0); });
    keys.slice(0, keys.length - WHATSAPP.MAX_TRACKED + 1).forEach(function (key) { props.deleteProperty(key); });
  }
  props.setProperty(WHATSAPP.SENT_PREFIX + String(reference) + '_' + String(kind), new Date().toISOString());
}

/**
 * Send (or plan) one notification.
 * @param {string} kind confirmation | cancellation | reminder
 * @param {Object} record a request row
 * @return {{sent: boolean, mode: string, reason: string, status?: number, dryRun?: boolean, target?: string}}
 */
function whatsappSend_(kind, record) {
  const props = PropertiesService.getScriptProperties();
  const mode = whatsappMode_();
  if (mode === 'off') return { sent: false, mode: mode, reason: 'disabled' };

  const plan = whatsappPlan_(kind, record);
  const target = whatsappRedact_(plan.to);

  if (mode === 'dry-run') {
    return { sent: false, mode: mode, reason: 'dry-run', dryRun: true, target: target, local: plan.local, url: plan.url, body: plan.body };
  }

  // This branch can send if live mode and credentials are configured. It is not yet
  // a complete consent/template policy and must not be enabled without separate approval.
  const token = String(props.getProperty(WHATSAPP.TOKEN_PROPERTY) || '').trim();
  const phoneId = String(props.getProperty(WHATSAPP.PHONE_ID_PROPERTY) || '').trim();
  if (!token || !phoneId) throw whatsappError_('WHATSAPP_NOT_CONFIGURED', 'الوضع live بلا WHATSAPP_TOKEN أو WHATSAPP_PHONE_NUMBER_ID.');
  if (whatsappAlreadySent_(String(record.reference), kind)) {
    return { sent: false, mode: mode, reason: 'duplicate', target: target };
  }
  const response = UrlFetchApp.fetch(plan.url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(plan.body),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw whatsappError_('WHATSAPP_SEND_FAILED', 'رفض مزوّد واتساب الطلب (HTTP ' + status + ').', { status: status });
  }
  whatsappRemember_(String(record.reference), kind);
  return { sent: true, mode: mode, reason: 'sent', status: status, target: target };
}

/**
 * The only entry point domain code is allowed to call. Never throws: a notification problem
 * is logged and reported, and the confirmed appointment is never downgraded because of it.
 * @param {string} kind
 * @param {Object} record
 * @return {{ok: boolean, sent: boolean, mode: string, reason: string, code?: string}}
 */
function whatsappNotify_(kind, record) {
  const mode = whatsappMode_();
  try {
    const result = whatsappSend_(kind, record);
    logEvent_('info', 'whatsapp_notify', {
      kind: kind,
      mode: result.mode,
      sent: !!result.sent,
      reason: String(result.reason || ''),
      target: String(result.target || '')
    });
    return { ok: true, sent: !!result.sent, mode: result.mode, reason: String(result.reason || '') };
  } catch (error) {
    const code = String((error && error.code) || 'WHATSAPP_FAILED');
    logEvent_('warn', 'whatsapp_notify_failed', { kind: kind, mode: mode, code: code });
    return { ok: false, sent: false, mode: mode, reason: 'error', code: code };
  }
}

/**
 * Operator utility: show exactly what `live` would send, without sending anything.
 * Callable from the Apps Script editor after S1 (see docs/google-rehearsal.md).
 * @param {string=} kind
 * @return {Object}
 */
function whatsappDryRunSample(kind) {
  const sample = {
    reference: 'CK-DEMO-0000',
    phone: '01000000000',
    day: '2026-01-01',
    time: '10:00',
    clinicName: 'Celia Kids'
  };
  const resolved = kind || 'confirmation';
  try {
    const plan = whatsappPlan_(resolved, sample);
    const status = whatsappStatus();
    return {
      mode: status.mode,
      status: status,
      wouldSendTo: whatsappRedact_(plan.to),
      url: plan.url,
      body: plan.body,
      note: 'dry-run: لا يُرسل شيء. الوضع الحالي هو ' + status.mode + '.'
    };
  } catch (error) {
    return { mode: whatsappMode_(), error: String((error && error.code) || ''), message: String(error && error.message || error) };
  }
}
