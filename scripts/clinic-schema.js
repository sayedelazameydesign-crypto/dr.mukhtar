'use strict';

/**
 * Schema for `clinic.json` — the stage-A published clinic facts.
 *
 * One module, three consumers, so the rule cannot drift:
 *   scripts/build-clinic-profile.js   merges + validates, and refuses to write a broken file
 *   scripts/test-clinic-schema.js     the negative tests that prove each rule fires
 *   scripts/clinic-ready.js           the release gate that reads the merged file
 *
 * The strict rule that matters: an empty field stays empty. Nothing here derives a name,
 * a phone or a licence from another field — a plausible-looking invention is worse than a
 * visible gap, because a parent would act on it.
 */

const FIELDS = ['clinicName', 'phone', 'whatsapp', 'address', 'note', 'doctorName', 'license'];

const LABELS = {
  clinicName: 'اسم العيادة',
  phone: 'هاتف العيادة',
  whatsapp: 'واتساب العيادة',
  address: 'العنوان',
  note: 'ملاحظة الطلب',
  doctorName: 'اسم الطبيب',
  license: 'رقم الترخيص'
};

// The facts a page must carry before it can call itself a real clinic's page.
// `note`, `whatsapp` and `address` are published facts too, but they have honest
// neutral states on the page ("يُضاف من إعداد العيادة"), so they are not release blockers.
const REQUIRED = ['clinicName', 'phone', 'doctorName'];

/**
 * Temporarily exempted from REQUIRED — never from honesty.
 *
 * DECISION (2026-11-06, owner): the doctor's registration number is not available yet, and
 * waiting for it must not block publishing. So `license` moved out of REQUIRED and into
 * PENDING: the release gate passes without it, and every consumer must report it as an OPEN
 * item. Nothing may describe a pending field as filled, verified or satisfied — the page keeps
 * its neutral "لم تُسجَّل بعد" state (index.html), and `go-live-check` reports it as unverified
 * rather than ready. Review trigger: before opening the service to the public
 * (docs/go-live.md §2).
 */
const PENDING = ['license'];

/**
 * Egyptian mobile numbers are 11 digits: 010/011/012/015 followed by 8 digits.
 * Landlines are 8–10 digits with a 2–8 area code, optionally +20 and an optional
 * leading 0. Both are accepted; anything else is rejected rather than guessed at.
 * Arabic-Indic digits are accepted and normalised, because a doctor typing on an
 * Arabic keyboard should not be told their number is invalid.
 */
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function normalizeDigits(value) {
  return String(value == null ? '' : value)
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

/** Strip presentation characters, keep digits and a single leading +. */
function compactPhone(value) {
  return normalizeDigits(value).trim().replace(/[\s\-().\u00a0\u200f\u200e]/g, '');
}

const EG_MOBILE = /^01[0125][0-9]{8}$/;
const EG_LANDLINE = /^0[2-8][0-9]{6,8}$/;

/**
 * Returns '' when valid, otherwise a short reason (Arabic, shown to the doctor).
 *
 * Strictly Egyptian: a number that merely *looks* like a phone is not accepted, because
 * "0100123456" (one digit short) would publish a number nobody answers. The only
 * normalisation allowed is +20 / 0020 / 20 → leading 0, and Arabic-Indic digits.
 */
function phoneProblem(value) {
  const phone = compactPhone(value);
  if (!phone) return 'مطلوب — الحقل فارغ';
  if (!/^\+?[0-9]+$/.test(phone)) {
    return `صيغة غير صالحة — أرقام فقط، ووصل: «${String(value).trim()}»`;
  }
  const local = canonicalPhone(phone);
  if (EG_MOBILE.test(local) || EG_LANDLINE.test(local)) return '';
  const hint = /^01/.test(local) ? 'رقم محمول مصري = 11 رقمًا يبدأ بـ 010/011/012/015'
    : /^0[2-8]/.test(local) ? 'رقم أرضي مصري = 8–10 أرقام مع كود المحافظة بعد الصفر'
      : 'الهاتف يجب أن يبدأ بـ 0 أو +20';
  return `صيغة غير صالحة (${hint}) — ووصل: «${String(value).trim()}»`;
}

/** The form a phone should be published in: local digits, no spaces or dashes. */
function canonicalPhone(value) {
  const phone = compactPhone(value);
  if (!phone) return '';
  if (phone.startsWith('+20')) return `0${phone.slice(3)}`;
  if (phone.startsWith('0020')) return `0${phone.slice(4)}`;
  if (/^20[0-9]{9,10}$/.test(phone)) return `0${phone.slice(2)}`;
  return phone;
}

/**
 * Validate a clinic object.
 * @returns {{ok: boolean, errors: Object<string,string>, warnings: string[]}}
 */
function validate(clinic) {
  const errors = {};
  const warnings = [];
  const source = clinic && typeof clinic === 'object' ? clinic : {};

  FIELDS.forEach((key) => {
    const value = source[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') errors[key] = 'يجب أن يكون نصًا';
  });

  // A name made only of spaces or of lookalike placeholders is not a name.
  ['clinicName', 'doctorName'].forEach((key) => {
    if (errors[key]) return;
    const value = String(source[key] == null ? '' : source[key]).trim();
    if (!value) return;
    if (value.length < 3) {
      errors[key] = `قصير جدًا — «${value}» ليس ${key === 'clinicName' ? 'اسم عيادة' : 'اسم طبيب'}`;
      return;
    }
    if (/^(عيادة|طبيب|doctor|clinic|test|xxx|غير معروف)$/i.test(value)) {
      errors[key] = `قيمة عامة لا تصلح للنشر — «${value}»`;
    }
  });

  ['phone', 'whatsapp'].forEach((key) => {
    if (errors[key]) return;
    if (!String(source[key] == null ? '' : source[key]).trim()) return;
    const problem = phoneProblem(source[key]);
    if (problem) errors[key] = problem;
  });

  if (!errors.license) {
    const licence = String(source.license == null ? '' : source.license).trim();
    if (licence) {
      if (licence.length < 3) errors.license = `قصير جدًا — «${licence}» لا يصلح رقم ترخيص`;
      else if (/^0+$/.test(licence)) errors.license = 'أصفار فقط ليست رقم ترخيص';
      else if (/^(xxx+|test|n.a|غير معروف)$/i.test(licence)) errors.license = `قيمة عامة لا تصلح للنشر — «${licence}»`;
    }
  }

  // Clinic name equal to the demo brand is the mistake that looks like success.
  if (!errors.clinicName && /^celia kids$/i.test(String(source.clinicName || '').trim())) {
    warnings.push('clinicName ما زال اسم العرض «Celia Kids» — استبدله بالاسم الحقيقي قبل النشر');
  }
  if (!errors.phone && !errors.whatsapp) {
    const phone = String(source.phone || '').trim();
    const whatsapp = String(source.whatsapp || '').trim();
    if (phone && whatsapp && canonicalPhone(phone) === canonicalPhone(whatsapp)) {
      warnings.push('phone و whatsapp متطابقان — لا ضرر، لكن تأكد أن واتساب يعمل على هذا الرقم');
    }
  }

  const missing = REQUIRED.filter((key) => !String(source[key] == null ? '' : source[key]).trim());
  const pending = PENDING.filter((key) => !String(source[key] == null ? '' : source[key]).trim());
  return { ok: Object.keys(errors).length === 0, errors, warnings, missing, pending };
}

/** An empty publishable object with the documentation comment. */
function emptyClinic() {
  return {
    $comment: 'بيانات العيادة المعلنة على الموقع (ليست أسرارًا). أي حقل فارغ يبقى فارغًا على الصفحة — لا يُخترع رقم أو اسم. في التشغيل الكامل تُقرأ من لوحة العيادة، وهذا الملف هو جسر المرحلة A فقط. راجع docs/go-live.md §2.',
    clinicName: '',
    phone: '',
    whatsapp: '',
    address: '',
    note: 'الطلب عبر هذه الصفحة يُراجع من العيادة قبل التأكيد.',
    doctorName: '',
    license: ''
  };
}

module.exports = {
  FIELDS, LABELS, REQUIRED, PENDING,
  normalizeDigits, compactPhone, canonicalPhone, phoneProblem,
  validate, emptyClinic
};
