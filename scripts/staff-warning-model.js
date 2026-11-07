'use strict';

// Pure local presentation prototype. It neither renders the actual staff UI nor
// reads Google, authorizes a session, persists a hold, or provides recovery.
const MESSAGES = Object.freeze({
  TIMING: 'يوجد اشتباه في اختلاف توقيت أو إعدادات محاولة حجز. لا تحرّروا الفترة أو تعيدوا المحاولة. يلزم فحص الجدول والتقويم وسجل البروفة بواسطة مسؤول مخوّل.',
  CRITICAL: 'تعذر حسم حالة محاولة الحجز. لا تحرّروا الفترة أو تعيدوا المحاولة. يلزم فحص الجدول والتقويم وسجل البروفة بواسطة مسؤول مخوّل.',
  REVIEW: 'تحتاج محاولة الحجز إلى مراجعة بشرية؛ لا تُعد هذه القراءة إثباتًا لنجاح الحجز أو أمان تحرير الفترة.',
  UNKNOWN: 'تعذر التحقق من حالة النظام. لا تعتبروا الفترة متاحة ولا تحرّروها؛ تواصلوا مع مسؤول النظام.',
  NONCE_DUPLICATE: 'رُفضت محاولة مكررة؛ نتيجة المحاولة الأصلية غير محسومة. لا تعيدوا المحاولة وراجعوا مسؤول النظام.',
  NONCE_CONSUMED: 'تسجيل المحاولة لا يثبت تأكيد الحجز؛ يلزم مراجعة بشرية قبل أي إجراء.'
});
function warningForAudit(input) {
  // Never interpolate nonce, request identifiers, payloads, exceptions or secrets.
  let kind = 'UNKNOWN';
  const a = input && input.audit;
  const valid = input && input.snapshotReadable === true && a && typeof a === 'object' && !Array.isArray(a) &&
    a.manualReviewRequired === true && a.allowAvailability === false && a.allowBooking === false &&
    a.allowRepair === false && a.allowRelease === false && a.allowRetry === false &&
    a.quarantinePersisted === false && a.relationship === 'UNPROVEN' && Array.isArray(a.reasons);
  if (valid) {
    if (a.decision === 'LEDGER_TIMING_DRIFT_SUSPECT' && a.timingState === 'STALE_OBSERVED' &&
        a.nonceState === 'PRESENT' && a.claimState === 'CLAIM_PRESENT' &&
        a.reasons.includes('TIMING_DRIFT_SUSPECT') && a.requiredQuarantine === 'GLOBAL_OR_PROVEN_NARROWER') kind = 'TIMING';
    else if (a.decision === 'RECONCILIATION_CRITICAL_AMBIGUITY' && a.reasons.length > 0 &&
        a.requiredQuarantine === 'GLOBAL_OR_PROVEN_NARROWER') kind = 'CRITICAL';
    else if (a.decision === 'HUMAN_REVIEW_REQUIRED' && a.reasons.length === 0 && a.requiredQuarantine === null) kind = 'REVIEW';
  }
  return { kind, severity: kind === 'REVIEW' ? 'warning' : 'critical', message: MESSAGES[kind],
    manualReviewRequired: true, allowAvailability: false, allowBooking: false, allowRelease: false,
    allowRepair: false, allowRetry: false, actions: [], persisted: false };
}
// Presents a synthetic guard outcome only; no nonce, exception or raw input is
// rendered. A consumed nonce says nothing about the original booking outcome.
function warningForNonce(input) {
  const r = input && input.result;
  const valid = input && input.snapshotReadable === true && r && typeof r === 'object' && !Array.isArray(r) &&
    r.originalResult === 'UNKNOWN' && r.allowBooking === false && r.allowRetry === false &&
    r.allowRelease === false && r.manualReviewRequired === true && r.quarantinePersisted === false;
  let kind = 'UNKNOWN';
  if (valid && r.code === 'REJECTED_DUPLICATE_NONCE') kind = 'NONCE_DUPLICATE';
  else if (valid && r.code === 'NONCE_CONSUMED') kind = 'NONCE_CONSUMED';
  return { kind, severity: kind === 'NONCE_CONSUMED' ? 'warning' : 'critical', message: MESSAGES[kind],
    manualReviewRequired: true, allowAvailability: false, allowBooking: false, allowRelease: false,
    allowRepair: false, allowRetry: false, actions: [], persisted: false };
}
module.exports = { warningForAudit, warningForNonce };
