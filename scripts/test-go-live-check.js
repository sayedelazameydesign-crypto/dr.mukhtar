#!/usr/bin/env node
'use strict';

/**
 * The go-live report decides whether someone is told "not ready". That verdict must be
 * proven, not assumed — a report that always says "not ready" is as useless as one that
 * always says "ready".
 *
 * These cases feed the script real Script Properties fixtures and assert on its exit code
 * and verdict, using --offline so the result never depends on the network.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'go-live-check.js');
const template = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'clinic.example.json'), 'utf8')).properties;
const defaults = Object.fromEntries(Object.entries(template).map(([key, spec]) => [key, spec.value]));

// The report runs the repository's gates, so its verdict depends on this machine. Pin the
// browser gate to an explicit skip so the suite tests the report's logic, not whether the
// sandbox happens to have jsdom installed.
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, CELIA_ALLOW_SKIP_UI: '1', NODE_PATH: '' }
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'go-live-'));
const writeProps = (name, overrides) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, JSON.stringify({ ...defaults, ...overrides }));
  return file;
};

let passed = 0;
const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

// 1 — no export: the report can only describe the template, and must say so.
{
  const result = run(['--offline']);
  check('a template-only run is not called ready', result.status === 1, `exit ${result.status}`);
  check('it names the missing clinic identity', /اسم العيادة الحقيقي/.test(result.stdout));
  check('it says the source is the template, not the clinic',
    /القالب \(بلا تصدير حقيقي\)/.test(result.stdout), 'source note missing');
  check('network checks are reported as unverified, not as failures',
    /غير مُتحقَّق[\s\S]{0,80}الموقع المنشور/.test(result.stdout));
  check('the verdict explains the unverified items cannot be closed locally',
    /لا بأي فحص محلي/.test(result.stdout));
}

// 1b — stage A: the four facts published in clinic.json must count as ready even though the
// server template is still empty. This is the only path that reaches a stranger's browser,
// so a report that ignored it would tell the clinic to fill the wrong screen.
{
  const original = fs.readFileSync(path.join(ROOT, 'clinic.json'), 'utf8');
  try {
    fs.writeFileSync(path.join(ROOT, 'clinic.json'), JSON.stringify({
      demoMode: false, clinicName: 'عيادة النور للأطفال', phone: '01001234567',
      doctorName: 'د. سارة محمود', license: 'EG-12345'
    }));
    const result = run(['--offline']);
    ['اسم العيادة الحقيقي', 'هاتف العيادة', 'اسم الطبيب', 'رقم الترخيص'].forEach((label) => {
      const line = result.stdout.split('\n').find((item) => item.includes(label)) || '';
      check(`published fact counts as ready: ${label}`, line.includes('جاهز'), line.trim().slice(0, 80));
    });
    check('the report names clinic.json as the source', /clinic\.json/.test(result.stdout));
  } finally {
    fs.writeFileSync(path.join(ROOT, 'clinic.json'), original);
  }
}

// 2 — a complete clinic: identity filled, nothing else broken.
{
  const file = writeProps('complete.json', {
    CLINIC_NAME: 'عيادة النور للأطفال',
    CLINIC_PHONE: '01001234567',
    CLINIC_ADDRESS: 'الجيزة',
    DOCTOR_NAME: 'د. سارة أحمد',
    DOCTOR_TITLE: 'استشاري طب الأطفال',
    DOCTOR_LICENSE: 'EG-12345',
    VISIT_SERVICES: 'كشف جديد = 60 = 250\nمتابعة = 30 = 150'
  });
  const result = run(['--offline', '--profile', file]);
  check('a fully configured clinic clears every identity item',
    !/يحتاج إجراء\s+اسم العيادة/.test(result.stdout), 'clinic name still flagged');
  check('the phone is never printed in full', !/01001234567/.test(result.stdout), 'full phone leaked');
  check('a customised service list is reported as configured',
    /مضبوطة حسب العيادة/.test(result.stdout));
  check('a configured clinic has no "needs action" items', result.status === 0, `exit ${result.status}`);
}

// 3 — a placeholder name must not pass as configured.
{
  const file = writeProps('placeholder.json', { CLINIC_NAME: 'Celia Kids', CLINIC_PHONE: '' });
  const result = run(['--offline', '--profile', file]);
  check('the shipped placeholder name is not treated as the clinic name',
    /يحتاج إجراء\s+اسم العيادة/.test(result.stdout), 'placeholder accepted');
  check('a missing phone blocks readiness', result.status === 1);
}

// 3b — a skipped browser gate must not be reported as ready.
{
  const file = writeProps('skip.json', {
    CLINIC_NAME: 'عيادة النور للأطفال', CLINIC_PHONE: '01001234567',
    DOCTOR_NAME: 'د. سارة', DOCTOR_LICENSE: 'EG-1',
    VISIT_SERVICES: 'كشف جديد = 60 = 250'
  });
  const strict = spawnSync(process.execPath, [SCRIPT, '--offline', '--profile', file], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CELIA_ALLOW_SKIP_UI: '', NODE_PATH: '' }
  });
  const saysSkipIsAnAction = /يحتاج إجراء\s+الواجهة في متصفح/.test(strict.stdout);
  const noJsdomHere = /SKIPPED-WITH-FAILURE/.test(strict.stdout);
  check('a skipped browser gate is an action, never a pass',
    !noJsdomHere || (saysSkipIsAnAction && strict.status === 1),
    'the report called a skipped gate ready');
}

// 4 — a broken gate must surface as an action, not as a pass.
{
  // Snapshot the exact bytes and restore them in finally. The previous version used
  // `git checkout -- app.js`, which silently discarded any uncommitted work on that file —
  // a test that destroys the change it is meant to protect.
  const appPath = path.join(ROOT, 'app.js');
  const original = fs.readFileSync(appPath, 'utf8');
  const file = writeProps('gates.json', {
    CLINIC_NAME: 'عيادة النور للأطفال', CLINIC_PHONE: '01001234567',
    DOCTOR_NAME: 'د. سارة', DOCTOR_LICENSE: 'EG-1',
    VISIT_SERVICES: 'كشف جديد = 60 = 250'
  });
  try {
    // Break the parity gate on purpose: the demo label no longer matches the live one.
    fs.writeFileSync(appPath, original.replace("label: 'أنواع الزيارات وأسعارها'", "label: 'أنواع الزيارات'"));
    const result = run(['--offline', '--profile', file]);
    check('a broken gate turns the verdict to "needs action"', result.status === 1, `exit ${result.status}`);
    check('the failing gate is named', /تطابق الإعدادات/.test(result.stdout));
  } finally {
    fs.writeFileSync(appPath, original);
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Go-live report suite passed: ${passed} checks (template, published clinic.json, complete clinic, placeholder, broken gate).`);
