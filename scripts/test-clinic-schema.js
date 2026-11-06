#!/usr/bin/env node
'use strict';

/**
 * Negative tests for the clinic.json schema and for the clinic-ready gate.
 *
 * Rule this suite enforces on itself: a case that merely asserts "valid input passes"
 * proves nothing about the guard. Every rule below is attacked with the *specific* value
 * it is meant to reject, and the suite also asserts that a value it should accept is not
 * rejected — otherwise "always fail" would look like a passing guard.
 *
 * Writes clinic.json in a throwaway copy of the repository (CELIA_REPO_ROOT), so the real
 * file is never touched.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const schema = require('./clinic-schema.js');

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------------- phone format, both ways */
const VALID_PHONES = [
  '01001234567', '01112345678', '01212345678', '01512345678',
  '٠١٠٠١٢٣٤٥٦٧',            // Arabic-Indic digits, same number
  '+201001234567',           // international form
  '+20 100 123 4567',        // with spaces
  '0100 123 4567',           // typed with spaces
  '0223456789', '0234567890' // landlines
];
VALID_PHONES.forEach((phone) => {
  check(`valid phone is accepted: ${phone}`, schema.phoneProblem(phone) === '');
});

const INVALID_PHONES = [
  ['', 'empty'],
  ['12345', 'too short'],
  ['0100123456', 'one digit short'],
  ['010012345678', 'one digit long'],
  ['0100123456x', 'trailing letter'],
  ['abc', 'not digits'],
  ['+1 555 0100', 'foreign number'],
  ['20100123456', 'country code without +'],
  ['   ', 'whitespace only']
];
INVALID_PHONES.forEach(([phone, why]) => {
  check(`invalid phone is rejected (${why}): ${JSON.stringify(phone)}`, schema.phoneProblem(phone) !== '');
});

// Canonical form must not change the number, only its presentation.
check('+201001234567 canonicalises to 01001234567', schema.canonicalPhone('+201001234567') === '01001234567');
check('Arabic digits canonicalise to ASCII', schema.canonicalPhone('٠١٠٠١٢٣٤٥٦٧') === '01001234567');
check('canonicalisation does not invent digits', schema.canonicalPhone('0100123456') === '0100123456');

/* ------------------------------------------------------------------- names/licence */
const NAME_CASES = [
  [{ clinicName: 'عيادة' }, 'clinicName', 'generic word'],
  [{ clinicName: 'ab' }, 'clinicName', 'too short'],
  [{ clinicName: '   ' }, null, 'whitespace only is treated as empty, not invalid'],
  [{ doctorName: 'طبيب' }, 'doctorName', 'generic word'],
  [{ license: '0' }, 'license', 'single zero'],
  [{ license: '000' }, 'license', 'zeros only'],
  [{ license: 'test' }, 'license', 'placeholder word']
];
NAME_CASES.forEach(([value, field, why]) => {
  const result = schema.validate(value);
  if (field) check(`rejects ${why}`, !!result.errors[field], JSON.stringify(result.errors));
  else check(`treats ${why} as empty (no error)`, result.ok === true, JSON.stringify(result.errors));
});

const GOOD = {
  clinicName: 'عيادة النور للأطفال',
  phone: '01001234567',
  doctorName: 'د. سارة محمود',
  license: 'EG-12345'
};
check('a complete, plausible clinic passes', schema.validate(GOOD).ok === true, JSON.stringify(schema.validate(GOOD).errors));
check('a complete clinic has no missing required field', schema.validate(GOOD).missing.length === 0);

/* ------------------------------------------------ empty file must stay empty, never invented */
const empty = schema.emptyClinic();
check('emptyClinic() publishes no name', empty.clinicName === '');
check('emptyClinic() publishes no phone', empty.phone === '');
check('emptyClinic() publishes no doctor', empty.doctorName === '');
check('emptyClinic() publishes no licence', empty.license === '');
check('emptyClinic() lists the three required facts as missing', schema.validate(empty).missing.length === 3);
check('emptyClinic() reports the licence as pending, not as required', schema.validate(empty).pending.join(',') === 'license');
check('the exemption list is exactly [license] — it cannot grow silently', schema.PENDING.length === 1 && schema.PENDING[0] === 'license');
check('the licence is no longer a release blocker', schema.REQUIRED.indexOf('license') === -1);

/* ---------------------- clinic-ready gate: production must fail, demo must pass ---------- */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-ready-'));
const writeClinic = (data) => fs.writeFileSync(path.join(sandbox, 'clinic.json'), JSON.stringify(data, null, 2));
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
fs.writeFileSync(path.join(sandbox, 'index.html'), html);
const runGate = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'clinic-ready.js'), '--json'], {
  cwd: sandbox, encoding: 'utf8', env: { ...process.env, CELIA_REPO_ROOT: sandbox }
});

// The gate resolves ROOT from its own __dirname, so point it at the sandbox by copying the
// script next to the fixture's data — otherwise the test would read the real clinic.json.
fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
['clinic-ready.js', 'clinic-schema.js'].forEach((file) => {
  fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(sandbox, 'scripts', file));
});
const runSandboxGate = () => spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'clinic-ready.js'), '--json'], {
  cwd: sandbox, encoding: 'utf8'
});

let outcome;
writeClinic({ clinicName: '', phone: '', doctorName: '', license: '' });
outcome = runSandboxGate();
check('production gate FAILS when the required facts are empty', outcome.status === 1, `exit ${outcome.status}`);
check('production gate names every empty required fact',
  /اسم العيادة/.test(outcome.stdout) && /هاتف العيادة/.test(outcome.stdout) && /اسم الطبيب/.test(outcome.stdout));
check('the exempted licence is NOT listed among the missing requirements', !/الفارغ:.*رقم الترخيص/.test(outcome.stdout), outcome.stdout.slice(0, 160));

writeClinic(GOOD);
outcome = runSandboxGate();
check('production gate PASSES when the required facts are filled', outcome.status === 0, `exit ${outcome.status}: ${outcome.stdout.slice(0, 120)}`);

// The exemption (2026-11-06): an empty licence does not stop the release, and is never
// reported as filled. Both halves are asserted, because allowing the publish is the easy
// part — silently counting it as done is the failure mode that matters.
writeClinic({ ...GOOD, license: '' });
outcome = runSandboxGate();
const exemptReport = JSON.parse(outcome.stdout);
check('production gate PASSES when only the licence is empty (temporary exemption)', outcome.status === 0, `exit ${outcome.status}`);
check('the empty licence is reported as an open item', (exemptReport.pending || []).indexOf('رقم الترخيص') !== -1, JSON.stringify(exemptReport.pending));
check('the empty licence is never counted as filled', (exemptReport.filled || []).indexOf('رقم الترخيص') === -1, JSON.stringify(exemptReport.filled));
check('the empty licence is never counted as missing either', (exemptReport.missing || []).indexOf('رقم الترخيص') === -1, JSON.stringify(exemptReport.missing));

writeClinic({ ...GOOD, doctorName: '' });
outcome = runSandboxGate();
check('a REQUIRED fact still blocks: empty doctor name fails the gate', outcome.status === 1, `exit ${outcome.status}`);

writeClinic({ ...GOOD, phone: '0100123456' });
outcome = runSandboxGate();
check('production gate FAILS on a malformed phone', outcome.status === 1, `exit ${outcome.status}`);

writeClinic({ demoMode: true, clinicName: '', phone: '', doctorName: '', license: '' });
outcome = runSandboxGate();
check('demo gate PASSES with gaps (the badge is present)', outcome.status === 0, `exit ${outcome.status}: ${outcome.stdout.slice(0, 120)}`);
check('demo gate still reports the gaps', /رقم الترخيص/.test(outcome.stdout));

// A demo badge that has been removed from the page must stop demo mode from passing.
fs.writeFileSync(path.join(sandbox, 'index.html'), html.replace('نسخة عرض توضيحية', 'عرض'));
outcome = runSandboxGate();
check('demo gate FAILS when the badge is missing from the page', outcome.status === 1, `exit ${outcome.status}`);

writeClinic({ demoMode: true, clinicName: 'عيادة', phone: '01001234567', doctorName: 'د. سارة', license: 'EG-1' });
fs.writeFileSync(path.join(sandbox, 'index.html'), html);
outcome = runSandboxGate();
check('demo mode does not excuse an invalid value', outcome.status === 1, `exit ${outcome.status}`);

fs.rmSync(sandbox, { recursive: true, force: true });

/* ------------------------------------------------------------------------ verdict */
if (failures.length) {
  failures.forEach((failure) => console.log(` ✗ ${failure}`));
  console.log(`\nClinic schema suite FAILED (${failures.length} of ${passed + failures.length} checks).`);
  process.exit(1);
}
console.log(`Clinic schema suite passed: ${passed} checks (phone both ways, names/licence, empty-file neutrality, production vs demo gate, licence exemption).`);
process.exit(0);
