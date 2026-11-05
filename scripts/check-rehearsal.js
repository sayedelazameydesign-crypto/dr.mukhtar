#!/usr/bin/env node
'use strict';

/**
 * Validate scripts/rehearsal-checklist.json — the file the clinic owner fills in.
 *
 *   node scripts/check-rehearsal.js           # report progress (never fails on empty evidence)
 *   node scripts/check-rehearsal.js --strict  # a step claimed done must carry real evidence
 *
 * Two jobs:
 *   1. Structure: every step has an id, an action, and an expected result, and ids are unique.
 *   2. Safety: the file is committed, so it must never contain a secret value or a patient
 *      detail. This is checked by pattern, and the finding is reported without echoing the
 *      value back into the log.
 *
 * "--strict" is what a reviewer runs once evidence has been supplied: an empty evidence field
 * means the step is not done, and a completed step must say what was actually observed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// CELIA_REPO_ROOT lets scripts/test-rehearsal-files.js point the checks at a synthetic tree,
// which is how the "a checklist that drifts from the build must fail" rule gets tested.
const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'scripts', 'rehearsal-checklist.json');
const DOC = path.join(ROOT, 'docs', 'google-rehearsal.md');
const BUILD = path.join(ROOT, 'scripts', 'build-gas-package.py');
const strict = process.argv.includes('--strict');

if (!fs.existsSync(FILE)) {
  console.error('✗ scripts/rehearsal-checklist.json is missing');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch (error) {
  console.error(`✗ rehearsal-checklist.json is not valid JSON: ${error.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const steps = [];
const ids = new Set();

(data.sections || []).forEach((section) => {
  if (!section.id) errors.push('a section has no id');
  (section.steps || []).forEach((step) => {
    if (!step.id) errors.push(`a step in ${section.id} has no id`);
    else if (ids.has(step.id)) errors.push(`${step.id} is duplicated`);
    else ids.add(step.id);
    if (!step.action) errors.push(`${step.id}: action is empty`);
    if (!step.expected) errors.push(`${step.id}: expected is empty`);
    if (!('evidence' in step)) errors.push(`${step.id}: evidence field is missing (it must exist and may be empty)`);
    if (step.evidence && String(step.evidence).trim().length > 0 && String(step.evidence).trim().length < 8) {
      warnings.push(`${step.id}: evidence is very short — say what you actually saw`);
    }
    steps.push({ id: step.id, section: section.id, done: !!(step.evidence && String(step.evidence).trim()), evidence: step.evidence || '' });
  });
});

if (!steps.length) errors.push('no steps found');

/* ------------------------------------------------------------- bundle contract */
// A rehearsal that tells the owner to copy "the files" is how a file gets forgotten. The step
// that ships the bundle must name every file, and that list must match what the build actually
// produces — both directions, so a stale name and a missing name are both failures.
const fileSteps = [];
(data.sections || []).forEach((section) => {
  (section.steps || []).forEach((step) => { if (Array.isArray(step.files)) fileSteps.push(step); });
});

if (fileSteps.length !== 1) {
  errors.push(`exactly one step must carry a "files" array (found ${fileSteps.length}) — the bundle list needs one home`);
} else {
  const declared = fileSteps[0].files.map((name) => String(name).trim()).filter(Boolean);
  if (!declared.length) errors.push(`${fileSteps[0].id}: files array is empty`);
  if (new Set(declared).size !== declared.length) errors.push(`${fileSteps[0].id}: files array has duplicates`);

  const listed = spawnSync('python3', [BUILD, '--list'], { cwd: ROOT, encoding: 'utf8' });
  if (listed.status !== 0) {
    errors.push(`cannot read the bundle list (python3 scripts/build-gas-package.py --list): ${String(listed.stderr || listed.stdout).trim().slice(0, 160)}`);
  } else {
    const built = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    declared.forEach((name) => {
      if (!built.includes(name)) errors.push(`${fileSteps[0].id}: «${name}» is listed in the checklist but the build does not produce it`);
    });
    built.forEach((name) => {
      if (!declared.includes(name)) errors.push(`${fileSteps[0].id}: the build produces «${name}» but the checklist does not list it`);
    });
  }

  const doc = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
  if (!doc) errors.push('docs/google-rehearsal.md is missing — S1.2 cannot be followed');
  else declared.forEach((name) => {
    if (!doc.includes(name)) errors.push(`docs/google-rehearsal.md never names «${name}» — the owner would copy an incomplete bundle`);
  });
}

/* --------------------------------------------------------------- secret safety */
// The checklist is committed. A pasted key is the most likely accident, so look for the
// shapes rather than the names: a name is fine ("GEMINI_API_KEY: مضبوط"), a value is not.
const raw = fs.readFileSync(FILE, 'utf8');
const SECRET_SHAPES = [
  // Google API keys start with AIza and run 35–39 characters; matching loosely on purpose,
  // because a detector that only knows the exact length misses the near-miss paste.
  [/\bAIza[0-9A-Za-z_-]{30,}\b/, 'a Google API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'a GitHub token'],
  [/\bya29\.[0-9A-Za-z_-]{20,}\b/, 'a Google OAuth refresh token'],
  [/\b[0-9a-f]{32,}\b/i, 'a long hex string (possible key or hash)'],
  [/\b\d{11}\b(?=\s*\bهاتف|\s*$)/m, 'a raw 11-digit phone number']
];
SECRET_SHAPES.forEach(([pattern, label]) => {
  if (pattern.test(raw)) errors.push(`the checklist appears to contain ${label} — remove it; this file is committed`);
});

/* ------------------------------------------------------------------- progress */
const done = steps.filter((step) => step.done);
const bySection = {};
steps.forEach((step) => {
  bySection[step.section] = bySection[step.section] || { done: 0, total: 0 };
  bySection[step.section].total += 1;
  if (step.done) bySection[step.section].done += 1;
});

console.log('— بروفة Google —');
Object.entries(bySection).forEach(([section, counts]) => {
  const mark = counts.done === counts.total ? '✓' : counts.done ? '~' : '·';
  console.log(`  ${mark} ${section}: ${counts.done}/${counts.total}`);
});
console.log(`  المجموع: ${done.length}/${steps.length} خطوة بدليل`);

if (done.length === steps.length) {
  const unresolved = steps.filter((step) => step.evidence.trim().length < 8);
  if (unresolved.length) warnings.push(`${unresolved.length} step(s) claim completion with near-empty evidence`);
}

warnings.forEach((warning) => console.log(`  ! ${warning}`));

if (errors.length) {
  console.error(`\n✗ CHECKLIST INVALID (${errors.length}):`);
  errors.forEach((error) => console.error(`   ✗ ${error}`));
  process.exit(1);
}

if (strict && done.length !== steps.length) {
  console.error(`\n✗ --strict: ${steps.length - done.length} خطوة بلا دليل — البروفة لم تكتمل، والفجوات تبقى «غير مُتحقَّق».`);
  process.exit(1);
}

if (done.length === steps.length) {
  console.log('\n✓ كل الخطوات لها دليل. الخطوة التالية: شغّل clinic-ready وgo-live-check، وأرفق هذا الملف.');
} else {
  console.log('\n· لم تكتمل البروفة بعد. هذا هو الوضع المتوقع ما لم تُنفَّذ في حسابك.');
  console.log('  الفجوات G1 وG14 تبقى «غير مُتحقَّق» حتى تُملأ الأدلة.');
}
process.exit(0);
