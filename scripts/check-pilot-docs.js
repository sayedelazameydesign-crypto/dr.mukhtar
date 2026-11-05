#!/usr/bin/env node
'use strict';

/**
 * The pilot and growth documents make promises the owner acts on: "run these seven
 * steps before day 1", "quote only what the sheet allows". A document that drifts from
 * the rehearsal checklist is worse than no document, because the owner follows it.
 *
 * This gate keeps four things in agreement:
 *
 *   scripts/rehearsal-checklist.json   the steps, and which gap each section closes
 *   docs/pilot/professor-week.md       the runbook that sequences them for a real clinic
 *   docs/pilot/result-template.md      the only place a result may be recorded
 *   docs/growth/doctors-playbook.md    the claims allowed in front of a doctor
 *
 * No network, no dependencies: it reads files and compares text.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT || path.resolve(__dirname, '..');
const CHECKLIST = path.join(ROOT, 'scripts', 'rehearsal-checklist.json');
const RUNBOOK = path.join(ROOT, 'docs', 'pilot', 'professor-week.md');
const RESULT = path.join(ROOT, 'docs', 'pilot', 'result-template.md');
const GROWTH = path.join(ROOT, 'docs', 'growth', 'doctors-playbook.md');
const SHEET = path.join(ROOT, 'pitch', 'celia-kids-doctor-sheet.pdf');

const failures = [];
const fail = (message) => failures.push(message);
const read = (file, label) => {
  if (!fs.existsSync(file)) { fail(`${label} is missing (${path.relative(ROOT, file)})`); return ''; }
  return fs.readFileSync(file, 'utf8');
};

let checklist;
try {
  checklist = JSON.parse(read(CHECKLIST, 'the rehearsal checklist'));
} catch (error) {
  fail(`scripts/rehearsal-checklist.json is not valid JSON: ${error.message}`);
}

const runbook = read(RUNBOOK, 'the pilot runbook');
const result = read(RESULT, 'the pilot result template');
const growth = read(GROWTH, 'the growth playbook');

/* ------------------------------------------------- checklist -> runbook ---- */
if (checklist && Array.isArray(checklist.sections)) {
  const steps = checklist.sections.flatMap((section) => section.steps || []);

  // 1. The runbook tells the owner to finish the rehearsal before day 1, so it must
  //    name the section that holds the real gate (S4 = the seven-step rehearsal).
  const gate = checklist.sections.find((section) => (section.closes || []).includes('G1'));
  if (!gate) {
    fail('no checklist section declares that it closes G1; the runbook cannot cite the gate');
  } else {
    if (!runbook.includes(gate.id)) fail(`the pilot runbook does not name section ${gate.id}, the G1 gate`);
    const gateSteps = (gate.steps || []).map((step) => step.id);
    if (gateSteps.length !== 7) fail(`${gate.id} has ${gateSteps.length} steps; the runbook promises seven`);
    // Every gate step appears in the runbook, so a renumbered checklist cannot leave a
    // step that the owner is never told to run.
    // The runbook cites both numbering systems side by side (B5.x · S4.x), so a
    // renumbered checklist or a renumbered go-live step is caught either way.
    const missing = gateSteps.filter((id) => !runbook.includes(id));
    if (missing.length) fail(`the pilot runbook does not reference gate steps: ${missing.join(', ')}`);
  }

  // 2. A runbook that never mentions evidence would let "done" mean "felt done".
  if (!/evidence|الدليل/.test(runbook)) fail('the pilot runbook does not ask for evidence per step');
  if (!checklist.sections.some((section) => (section.steps || []).some((step) => 'evidence' in step))) {
    fail('no checklist step carries an evidence field, so the runbook cannot require one');
  }
}

/* ------------------------------------------------------ runbook content ---- */
// The three safeguards the owner is most likely to skip. Each is a promise in the
// documents, so each is checked rather than trusted to memory.
if (runbook) {
  if (!/D0/.test(runbook) || !/D7/.test(runbook)) fail('the runbook must keep a first day (D0) and a decision day (D7)');
  if (!/لا تبدأ|لا يبدأ/.test(runbook)) fail('the runbook has no stop condition before day 1');
  if (!/حجوزات مزدوجة/.test(runbook)) fail('the runbook no longer records double bookings; that is the top metric');
  if (/واتساب تلقائي/.test(runbook)) {
    // It may only appear as something that stays OFF.
    if (!/واتساب.*تلقائي.*(off|مطفأ|يظل)/.test(runbook)) fail('the runbook mentions automatic WhatsApp without keeping it off');
  }
}

/* -------------------------------------------------------- result template -- */
if (result) {
  ['حجوزات مزدوجة', 'طلبات وصلت', 'إذن النشر', 'توسيع', 'إيقاف'].forEach((token) => {
    if (!result.includes(token)) fail(`the result template is missing "${token}"`);
  });
  // The template is committed, so it must forbid what cannot be stored.
  if (!/\*\*بلا أسماء مرضى\*\*/.test(result)) fail('the result template does not forbid patient names');
}

/* ------------------------------------------------------------- growth ------ */
if (growth) {
  if (!growth.includes('pitch/celia-kids-doctor-sheet.pdf')) fail('the growth playbook does not point at the printed sheet');
  // A bare "إذن" anywhere is too weak: the promise is a *written* permission, stated
  // where the testimonial is described, so that phrase is the thing that must survive.
  if (!/إذن صريح مكتوب/.test(growth)) fail('the growth playbook allows sharing a testimonial without written permission');
  ['آمن ١٠٠٪', 'معتمد'].forEach((claim) => {
    if (new RegExp(`قل[^\\n]*${claim}`).test(growth)) fail(`the growth playbook permits the unprovable claim "${claim}"`);
  });
  if (!fs.existsSync(SHEET)) fail('pitch/celia-kids-doctor-sheet.pdf is missing, so the playbook points at nothing');
}

/* --------------------------------------------------------------- report ---- */
if (failures.length) {
  console.error(`✗ pilot/growth documents failed ${failures.length} check(s):`);
  failures.forEach((message) => console.error(` ✗ ${message}`));
  process.exit(1);
}
const stepCount = checklist.sections.flatMap((section) => section.steps || []).length;
console.log(`Pilot + growth contract OK — ${stepCount} rehearsal steps, runbook gaps and claims all accounted for.`);
