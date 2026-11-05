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

const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
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

// 4 — a broken gate must surface as an action, not as a pass.
{
  const original = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const file = writeProps('gates.json', {
    CLINIC_NAME: 'عيادة النور للأطفال', CLINIC_PHONE: '01001234567',
    DOCTOR_NAME: 'د. سارة', DOCTOR_LICENSE: 'EG-1',
    VISIT_SERVICES: 'كشف جديد = 60 = 250'
  });
  try {
    // Break the parity gate on purpose: the demo label no longer matches the live one.
    fs.writeFileSync(path.join(ROOT, 'app.js'),
      fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
        .replace("label: 'أنواع الزيارات وأسعارها'", "label: 'أنواع الزيارات'"));
    const result = run(['--offline', '--profile', file]);
    check('a broken gate turns the verdict to "needs action"', result.status === 1, `exit ${result.status}`);
    check('the failing gate is named', /تطابق الإعدادات/.test(result.stdout));
  } finally {
    fs.writeFileSync(path.join(ROOT, 'Code.gs'), original);
    spawnSync('git', ['checkout', '--', 'app.js'], { cwd: ROOT });
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Go-live report suite passed: ${passed} checks (template, complete clinic, placeholder, broken gate).`);
