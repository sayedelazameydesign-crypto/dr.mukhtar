#!/usr/bin/env node
'use strict';

/**
 * Readiness report for going live — «هل العيادة جاهزة للتشغيل الحقيقي؟»
 *
 * The repository can prove a lot about itself (gates, parity, simulation) and nothing at
 * all about the one thing that decides whether a parent can actually book: has the clinic
 * filled its own data? This script answers that from the only sources that exist without
 * a Google login:
 *
 *   1. The published site      — can a stranger load it right now?
 *   2. The public clinic profile — does it still show placeholders?
 *   3. The repository gates     — are the local checks green?
 *   4. The real deployment      — Apps Script, Sheets, Calendar (reported, never invented)
 *
 * It never prints a secret, never needs credentials, and exits non-zero only when a
 * condition a human could have fixed was not fixed. Network failures are reported as
 * "unverified" — not as failures, and definitely not as passes.
 *
 * Usage:
 *   node scripts/go-live-check.js                 # full report
 *   node scripts/go-live-check.js --offline       # skip the network (repository gates only)
 *   node scripts/go-live-check.js --base <url>    # check another deployment
 *   node scripts/go-live-check.js --profile props.json  # include a Script Properties export
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
// Machine-readable output: docs/production-readiness.md is generated from this, so the
// numbers in the document cannot drift from a real run.
const AS_JSON = flag('--json');
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = valueOf('--base', 'https://sayedelazameydesign-crypto.github.io/dr.mukhtar/');
const OFFLINE = flag('--offline');
const PROPS_FILE = valueOf('--profile', '');

const results = [];
const add = (id, label, status, detail, fix) => results.push({ id, label, status, detail, fix });
// status: 'ready' | 'action' | 'unverified' | 'info'

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    return { ok: response.ok, status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- 1. the site */

async function checkSite() {
  if (OFFLINE) {
    add('site.up', 'الموقع المنشور', 'unverified', 'تم تخطي الشبكة (--offline)');
    return;
  }
  try {
    const page = await fetchText(BASE);
    if (!page.ok) {
      add('site.up', 'الموقع المنشور', 'action', `الرد ${page.status}`, 'تحقق من إعداد Pages ومن نجاح آخر Deploy');
      return;
    }
    // A page that renders the emergency notice is the real booking page, not a placeholder.
    const looksRight = /طلب موعد|عيادة/.test(page.body) && /bookingForm|bookingView/.test(page.body);
    add('site.up', 'الموقع المنشور', looksRight ? 'ready' : 'action',
      looksRight ? `يعمل (${(page.body.length / 1024).toFixed(0)} كيلوبايت)` : 'الصفحة لا تبدو صفحة الحجز',
      looksRight ? '' : 'تحقق من نجاح آخر نشر ومن الملف المنشور');

    // The demo renders its own content, so this proves more than an HTTP 200.
    const robots = await fetchText(`${BASE}robots.txt`);
    add('site.robots', 'ملفات الزحف والمشاركة', robots.ok ? 'ready' : 'info',
      robots.ok ? 'robots.txt موجود' : 'robots.txt غير موجود');
  } catch (error) {
    add('site.up', 'الموقع المنشور', 'unverified', `تعذر الوصول من هذه الشبكة: ${error.message}`);
  }
}

/* ------------------------------------------------------- 2. clinic data (repo) */

function readClinicContract() {
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/clinic.example.json'), 'utf8')).properties;
  return template;
}

function checkClinicData() {
  const template = readClinicContract();
  let properties = {};
  let source = '';

  if (PROPS_FILE) {
    try {
      properties = JSON.parse(fs.readFileSync(path.resolve(PROPS_FILE), 'utf8'));
      if (properties.properties) properties = properties.properties;
      source = path.basename(PROPS_FILE);
    } catch (error) {
      add('clinic.export', 'ملف خصائص مُصدَّر', 'action', `تعذر قراءة ${PROPS_FILE}: ${error.message}`,
        'صدّر Script Properties كـ {"KEY":"value"} ولا ترفعه للمستودع');
      return;
    }
  } else {
    // Without an export the only honest source is the template, whose identity fields are empty.
    properties = Object.fromEntries(Object.entries(template).map(([key, spec]) => [key, spec.value]));
    source = 'القالب (بلا تصدير حقيقي)';
  }

  const filled = (key) => String(properties[key] || '').trim();

  // Stage A publishes facts through clinic.json, which reaches a stranger's browser; the
  // dashboard and Script Properties do not. So a fact counts as published if EITHER source
  // carries it, and the report says which — claiming a fact from the server while the page
  // shows a placeholder would be exactly the misreport this report exists to prevent.
  const published = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'clinic.json'), 'utf8'));
    } catch (_) { return {}; }
  })();
  const pub = (key) => String(published[key] == null ? '' : published[key]).trim();
  const fromWhere = (key, propertyKey) => {
    if (pub(key)) return 'clinic.json';
    if (filled(propertyKey || key)) return 'إعدادات الخادم';
    return '';
  };

  const publishedName = pub('clinicName') || filled('CLINIC_NAME');
  const nameOk = publishedName !== '' && publishedName !== 'Celia Kids';
  add('clinic.name', 'اسم العيادة الحقيقي', nameOk ? 'ready' : 'action',
    nameOk ? `${publishedName} (${fromWhere('clinicName', 'CLINIC_NAME')})` : 'لا يزال القالب الافتراضي',
    nameOk ? '' : 'أدخله في clinic.json أو من: لوحة العيادة ← إعدادات العيادة ← هوية العيادة');

  const phone = (pub('phone') || filled('CLINIC_PHONE')).replace(/\D/g, '');
  const phoneOk = phone.length >= 8;
  add('clinic.phone', 'هاتف العيادة', phoneOk ? 'ready' : 'action',
    phoneOk ? `${phone.slice(0, 4)}… (مخفي جزئيًا) · ${fromWhere('phone', 'CLINIC_PHONE')}` : 'غير مضبوط',
    phoneOk ? '' : 'أدخله في clinic.json — بدونه لا يعمل زر الاتصال ولا واتساب');

  const doctorOk = (pub('doctorName') || filled('DOCTOR_NAME')) !== '';
  add('clinic.doctor', 'اسم الطبيب', doctorOk ? 'ready' : 'action',
    doctorOk ? `مضبوط (${fromWhere('doctorName', 'DOCTOR_NAME')})` : 'غير مضبوط — تظهر شارة «لم يُتحقق بعد»',
    doctorOk ? '' : 'أدخله في clinic.json أو «هوية الطبيب»؛ لا يُخترع من الكود');

  const licenseOk = (pub('license') || filled('DOCTOR_LICENSE')) !== '';
  add('clinic.license', 'رقم الترخيص', licenseOk ? 'ready' : 'action',
    licenseOk ? `مضبوط (${fromWhere('license', 'DOCTOR_LICENSE')})` : 'غير مضبوط',
    licenseOk ? '' : 'لا تُدخله قبل التحقق منه فعليًا — كتابته غير المحقّقة أسوأ من غيابه');

  const services = filled('VISIT_SERVICES');
  if (!PROPS_FILE) {
    add('clinic.services', 'أنواع الزيارات', 'info', 'القالب الافتراضي (كشف جديد · متابعة)',
      'راجعها وأضف أسعارها من «أنواع الزيارات وأسعارها»');
  } else {
    const customised = services && services !== (template.VISIT_SERVICES || {}).value;
    add('clinic.services', 'أنواع الزيارات', services ? 'ready' : 'action',
      customised ? 'مضبوطة حسب العيادة' : 'الافتراضي — لم تُخصَّص',
      customised ? '' : 'أضف أنواع الزيارة وأسعارها من «أنواع الزيارات وأسعارها»');
  }

  if (!PROPS_FILE) {
    add('clinic.source', 'مصدر بيانات العيادة', 'info',
      `قُرئ من ${source} — أي أن الحالة أعلاه هي حالة «لم يُضبط بعد» وليست حالة عيادتك`,
      'صدّر Script Properties إلى ملف محلي مؤقت ثم: node scripts/go-live-check.js --profile <ملف>');
  }
}

/* ------------------------------------------------------------- 3. local gates */

function runGate(label, command, cmdArgs, id) {
  try {
    const output = execFileSync(command, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = String(output).trim().split('\n').filter(Boolean);
    // Prefer the summary line over a trailing reminder ("mocked services do not establish…"),
    // which would otherwise be quoted as if it were the result.
    const line = lines.find((item) => /passed|OK|PASS/i.test(item) && !/SKIPPED|Reminder/i.test(item))
      || lines.find((item) => /SKIPPED/i.test(item))
      || lines.pop()
      || '';
    // A skipped browser test is a gap that looks green: report it as an action, because
    // the gate is expected to run. The only accepted skip is an explicit opt-out.
    const skipped = /SKIPPED/i.test(line);
    const explicitSkip = skipped && process.env.CELIA_ALLOW_SKIP_UI;
    add(id, label, explicitSkip ? 'unverified' : (skipped ? 'action' : 'ready'), line.slice(0, 120),
      skipped && !explicitSkip ? 'ثبّت الاعتماد: npm i --no-save --prefix /tmp jsdom (أو اعتمد التخطي صراحةً بـ CELIA_ALLOW_SKIP_UI=1)' : '');
  } catch (error) {
    const detail = String(error.stdout || error.stderr || error.message).trim().split('\n').slice(-3).join(' ').slice(0, 160);
    add(id, label, 'action', detail || 'فشل', 'أصلح البوابة قبل أي نشر — راجع المخرج أعلاه');
  }
}

function checkGates() {
  runGate('عقود سير العمل والأسرار', process.execPath, ['scripts/check-workflows.js'], 'gate.workflows');
  runGate('مسح الأسرار', process.execPath, ['scripts/scan-secrets.js'], 'gate.secrets');
  runGate('تطابق الإعدادات (حيّ/تجريبي)', process.execPath, ['scripts/check-settings-parity.js'], 'gate.parity');
  runGate('محاكاة الخادم', process.execPath, ['scripts/test-gas-simulated.js'], 'gate.backend');
  runGate('الواجهة في متصفح', process.execPath, ['scripts/test-ui-smoke.js'], 'gate.ui');
  // Privacy/retention/health: the parts a guardian and an owner rely on when something has
  // already gone wrong. Cheap, offline, and it fails loudly if a piece disappears.
  runGate('الخصوصية والاحتفاظ وفحص الصحة', process.execPath, ['scripts/test-privacy-health.js'], 'gate.privacy');
}

/* --------------------------------------------- 4. what only a human can close */

function checkHumanSteps() {
  add('live.appsScript', 'الخادم يعمل في حساب Google', 'unverified',
    'لم يُختبر في حساب حقيقي — المحاكاة لا تُغني عنه',
    'docs/go-live.md §3 (B-1 … B-5): أنشئ المشروع، شغّل initializeCeliaKids، ثم نفّذ خطوات البروفة السبع');
  add('live.branchProtection', 'حماية main (مطلوب PR + CI)', 'unverified',
    'لا يمكن قراءتها بلا صلاحية إدارة المستودع',
    'فعّلها من Settings ← Branches، أو sh scripts/bootstrap-github.sh من جهازك');
  add('live.secrets', 'أسرار/متغيّرات GitHub', 'unverified',
    'لا تُقرأ ولا تُطبع من هنا (الأسماء فقط في المانيفست)',
    'شغّل: Setup status من تبويب Actions، أو node scripts/setup-github.js محليًا');
}

/* ------------------------------------------------------------------- report */

function show() {
  const label = { ready: '✓ جاهز', action: '✗ يحتاج إجراء', unverified: '? غير مُتحقَّق', info: '· معلومة' };

  const count = (status) => results.filter((row) => row.status === status).length;
  const verdict = count('action') ? 'not-ready' : (count('unverified') ? 'gates-green-live-unproven' : 'ready');

  if (AS_JSON) {
    // `gaps` comes from the map, so one command answers "what does the report say" and
    // "what does the ledger say" together — the reconciliation is then a diff, not an opinion.
    let gaps = null;
    try { gaps = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'map', 'gaps.json'), 'utf8')); } catch (_) {}
    const tally = gaps ? {
      total: gaps.gaps.length,
      closed: gaps.gaps.filter((gap) => gap.status === 'resolved').length,
      open: gaps.gaps.filter((gap) => gap.status !== 'resolved').map((gap) => gap.id)
    } : null;
    console.log(JSON.stringify({
      measured_at: new Date().toISOString(),
      base: BASE,
      offline: flag('--offline'),
      counts: { ready: count('ready'), action: count('action'), unverified: count('unverified'), info: count('info') },
      verdict,
      gaps_tally: tally,
      results: results.map((row) => ({ id: row.id, label: row.label, status: row.status, detail: row.detail || '', fix: row.fix || '' }))
    }, null, 2));
    process.exitCode = verdict === 'not-ready' ? 1 : 0;
    return;
  }
  const groups = [
    ['الموقع المنشور', (r) => r.id.startsWith('site.')],
    ['بيانات العيادة', (r) => r.id.startsWith('clinic.')],
    ['بوابات المستودع', (r) => r.id.startsWith('gate.')],
    ['ما يُغلقه الإنسان فقط', (r) => r.id.startsWith('live.')]
  ];

  console.log('\n  تقرير الجهوزية للتشغيل الحقيقي');
  console.log(`  ${new Date().toISOString()} · ${BASE}`);
  console.log('  ' + '-'.repeat(72));

  groups.forEach(([title, filter]) => {
    const rows = results.filter(filter);
    if (!rows.length) return;
    console.log(`\n  ${title}`);
    rows.forEach((row) => {
      console.log(`   ${label[row.status].padEnd(14)} ${row.label}`);
      if (row.detail) console.log(`   ${' '.repeat(14)} ${row.detail}`);
      if (row.fix && row.status !== 'ready') console.log(`   ${' '.repeat(14)} ← ${row.fix}`);
    });
  });

  const ready = count('ready');
  const action = count('action');
  const unverified = count('unverified');

  console.log('\n  ' + '-'.repeat(72));
  console.log(`  جاهز ${ready} · يحتاج إجراء ${action} · غير مُتحقَّق ${unverified}`);

  // The unverified caveat is printed in every case: a green board that quietly forgets the
  // things nobody checked is how "the docs were green" gets mistaken for "it works".
  const caveat = () => {
    if (!unverified) return;
    console.log('  البنود «غير مُتحقَّق» تُغلق فقط بخطوات docs/go-live.md §3 — لا بأي فحص محلي.');
  };

  if (action) {
    console.log('\n  الحكم: ليس جاهزًا للتشغيل. أصلح بنود «يحتاج إجراء» أولًا.');
    caveat();
    console.log('  الملاحظات والحكم لا تُعاد صياغتهما: هذه نتيجة تشغيل فعلي.\n');
    process.exitCode = 1;
    return;
  }
  if (unverified) {
    console.log('\n  الحكم: البوابات الآلية سليمة، لكن التشغيل الحقيقي غير مُثبت.');
    caveat();
    console.log('');
    return;
  }
  console.log('\n  الحكم: جاهز — بما في ذلك التشغيل الحقيقي. سجّل التاريخ في docs/plan.md.\n');
}

(async () => {
  checkClinicData();
  checkGates();
  await checkSite();
  checkHumanSteps();
  show();
})().catch((error) => {
  console.error(`تعذر إكمال التقرير: ${error.message}`);
  process.exitCode = 2;
});
