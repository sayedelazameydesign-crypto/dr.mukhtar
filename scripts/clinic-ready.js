#!/usr/bin/env node
'use strict';

/**
 * Release gate for clinic.json.
 *
 *   node scripts/clinic-ready.js            # check (exit 1 when facts are missing)
 *   node scripts/clinic-ready.js --json     # machine-readable verdict
 *
 * Two modes, decided by one flag in the data — not by a comment someone can forget:
 *
 *   demo       `demoMode: true`  the site is allowed to publish with gaps, but it must keep
 *                                the demo badge visible on the page and every empty field
 *                                must keep its neutral placeholder. Gaps are reported, not
 *                                hidden, and the verdict says «ليس جاهزًا للتشغيل».
 *   production no `demoMode`     the required facts (name, phone, doctor) must be present and
 *                                valid, or the gate fails and the deploy stops. A field in
 *                                schema.PENDING (currently the licence, exempted on 2026-11-06)
 *                                does NOT block — but it is always printed as an open item and
 *                                never counted as filled or satisfied.
 *
 * Why a file flag instead of an environment variable: the badge on the page and the gate
 * in CI must read the same source. If they can disagree, the badge is decoration.
 */

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./clinic-schema.js');

const ROOT = path.resolve(__dirname, '..');
const CLINIC = path.join(ROOT, 'clinic.json');
const PAGE = path.join(ROOT, 'index.html');
const asJson = process.argv.includes('--json');

function fail(title, lines) {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, title, lines }, null, 2));
  } else {
    console.error(`\n✗ ${title}`);
    lines.forEach((line) => console.error(`   ${line}`));
  }
  process.exit(1);
}

if (!fs.existsSync(CLINIC)) fail('clinic.json مفقود', ['الملف يُنشر مع الموقع؛ غيابه يعني أن الصفحة لا تحمل أي بيان عيادة.']);
let clinic;
try {
  clinic = JSON.parse(fs.readFileSync(CLINIC, 'utf8'));
} catch (error) {
  fail('clinic.json ليس JSON صالحًا', [error.message, 'لن تُقرأ الصفحة أي بيان — والصفحة لن تكسر، لكن البوابة لا تمر.']);
}

const demoMode = clinic.demoMode === true;
const result = schema.validate(clinic);
const missing = schema.REQUIRED.filter((key) => !String(clinic[key] == null ? '' : clinic[key]).trim());
const pending = schema.PENDING.filter((key) => !String(clinic[key] == null ? '' : clinic[key]).trim());

// The badge is not optional in demo mode: a page that shows example data as if it were a
// real clinic's data is a misrepresentation, not a placeholder.
const app = fs.readFileSync(PAGE, 'utf8');
// The badge must be the element the app actually toggles, and it must still carry the text.
const hasBadge = /data-demo-badge/.test(app) && /نسخة عرض توضيحية/.test(app);

const report = {
  mode: demoMode ? 'demo' : 'production',
  ok: false,
  valid: result.ok,
  errors: result.errors,
  warnings: result.warnings,
  filled: schema.FIELDS.filter((key) => String(clinic[key] == null ? '' : clinic[key]).trim()),
  missing: missing.map((key) => schema.LABELS[key]),
  pending: pending.map((key) => schema.LABELS[key]),
  demoBadgePresent: hasBadge
};

if (!result.ok) {
  const lines = Object.entries(result.errors).map(([key, message]) => `${schema.LABELS[key] || key}: ${message}`);
  report.ok = false;
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.error('\n✗ clinic.json يحتوي قيمًا مرفوضة — لا تُنشر:');
    lines.forEach((line) => console.error(`   ✗ ${line}`));
  }
  process.exit(1);
}

if (demoMode) {
  // Demo mode passes the gate on purpose: the page is allowed to ship with gaps. What it
  // may not do is hide them.
  if (!hasBadge) {
    const lines = ['index.html لم يحتوِ شارة «نسخة عرض توضيحية» — الوضع التجريبي بلا شارة تضليل.'];
    if (asJson) console.log(JSON.stringify({ ...report, ok: false }, null, 2));
    else { console.error('\n✗ الوضع التجريبي بلا شارة'); lines.forEach((l) => console.error(`   ${l}`)); }
    process.exit(1);
  }
  report.ok = true;
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log('\n· clinic-ready: الوضع التجريبي (demoMode: true)');
  console.log(`  الحقول المعبّأة: ${report.filled.length ? report.filled.map((key) => schema.LABELS[key]).join(' · ') : '(لا شيء)'}`);
  if (missing.length) {
    console.log(`  الحقول الفارغة: ${report.missing.join(' · ')}`);
    console.log('  ← تبقى فارغة على الصفحة ببديل محايد، والشارة التجريبية ظاهرة. هذا مسموح في العرض فقط.');
  }
  if (pending.length) {
    console.log(`  بند مفتوح (إعفاء مؤقت): ${report.pending.join(' · ')}`);
  }
  result.warnings.forEach((warning) => console.log(`  ! ${warning}`));
  console.log('\n✓ البوابة تمرّ للعرض التجريبي — وليست شهادة جهوزية للتشغيل.');
  process.exit(0);
}

if (missing.length) {
  report.ok = false;
  fail('بوابة النشر الإنتاجي لا تمرّ: بيانات العيادة ناقصة', [
    `الفارغ: ${report.missing.join(' · ')}`,
    'املأها من clinic.json أو من واجهة العيادة — لا تُخترع من الكود.',
    'إن كان الموقع عرضًا تجريبيًا فأضف "demoMode": true صراحةً ليبقى مع الشارة التجريبية.'
  ]);
}

report.ok = true;
if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
console.log('\n✓ clinic-ready: النشر الإنتاجي — الحقول المطلوبة مكتملة وصالحة.');
if (pending.length) {
  console.log(`  بند مفتوح (إعفاء مؤقت): ${report.pending.join(' · ')} — لا يُنشر ولا يُعدّ مستوفى.`);
  console.log('  ← يُراجع قبل فتح الخدمة للجمهور (docs/go-live.md §2).');
}
process.exit(0);
