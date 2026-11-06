#!/usr/bin/env node
'use strict';

/**
 * The audit gate.
 *
 * A threat model is only worth its lines if every line points at something real. This
 * checker refuses:
 *   - a `file:line` reference whose file does not exist or whose line is past the end of it
 *   - a threat row with no reference at all
 *   - a claim of "controlled" that no test asserts
 *
 * The last rule is the important one. "Mitigated" is a claim, and in this repository a claim
 * needs a test whose name can be found. Rows marked as open risks are allowed to have no
 * test — they are the honest ones — but they must say so in their evaluation column.
 *
 *   node scripts/check-audit-doc.js [--self-test]
 *
 * Exit 0 = every citation resolves and every "controlled" row is backed by a test name.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const DOCS = [path.join('docs', 'audit', 'threat-model-2026-11.md')];
/** What a row may write in the evaluation cell. */
const EVALUATION_CELLS = 1;
const REF = /\b([A-Za-z0-9_.\/-]+\.(?:js|gs|html|json|yml|yaml|md|py)):(\d+)\b/g;
const CONTROLLED = /مُسيطَر|مُسيطَر جزئيًا|controlled|mitigated/i;
/** Phrases that mean "this row is not claiming a defence". */
const OPEN_MARKERS = /مخاطرة قائمة|حرج|ثغرة|open risk|accepted|مقبول|مُسيطَر جزئيًا|partial/i;

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/** Every test name that exists anywhere in scripts/, for the "mitigated needs a test" rule. */
function assertionIndex(root) {
  const names = new Set();
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!/\.js$/.test(entry.name)) return;
      const text = fs.readFileSync(full, 'utf8');
      // Test names appear in two shapes in this repository: the `check('…')` harness and
      // plain `assert.equal(actual, expected, '…')` messages. Both are assertions a reader
      // can find by grep, so both count as evidence.
      for (const match of text.matchAll(/check\(\s*'([^']{8,})'/g)) names.add(match[1].toLowerCase());
      for (const match of text.matchAll(/check\(\s*"([^"]{8,})"/g)) names.add(match[1].toLowerCase());
      for (const match of text.matchAll(/assert\.\w+\([\s\S]{0,400}?['"]([^'"]{12,})['"]\s*\)/g)) names.add(match[1].toLowerCase());
    });
  };
  const scripts = path.join(root || ROOT, 'scripts');
  if (fs.existsSync(scripts)) walk(scripts);
  return names;
}

/** Resolve one file:line reference against the repository. */
function resolve(reference, line, root) {
  const file = path.join(root || ROOT, reference);
  if (reference.startsWith('..') || path.isAbsolute(reference)) return { ok: false, why: 'reference escapes the repository' };
  if (!fs.existsSync(file)) return { ok: false, why: 'file does not exist' };
  const total = fs.readFileSync(file, 'utf8').split('\n').length;
  const number = Number(line);
  if (!Number.isInteger(number) || number < 1) return { ok: false, why: 'line is not a positive integer' };
  if (number > total) return { ok: false, why: `line ${number} is past the end of the file (${total} lines)` };
  return { ok: true };
}

/**
 * Audit one document text against a repository root.
 *
 * `override` is either undefined (read the real document) or `{ text }` for a fixture.
 * `root` default is the repository; the self-test passes a temp tree so the resolver is
 * exercised for real instead of mocked.
 *
 * @returns {{citations:number, rows:number, findings:string[]}}
 */
function auditAt(root, override) {
  const findings = [];
  let citations = 0;
  let rows = 0;
  const tests = assertionIndex(root);

  const document = override && typeof override.text === 'string' ? override.text : null;
  const relative = DOCS[0];
  if (document === null) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return { citations: 0, rows: 0, findings: [`${relative}: missing`] };
  }
  const text = document === null ? fs.readFileSync(path.join(root, relative), 'utf8') : document;

  // 1. every file:line resolves
  for (const match of text.matchAll(REF)) {
    citations += 1;
    const result = resolve(match[1], match[2], root);
    if (!result.ok) findings.push(`${relative}: ${match[1]}:${match[2]} — ${result.why}`);
  }

  // 2. threat rows: an ID needs a citation and an evaluation
  text.split('\n').forEach((line) => {
    if (!/^\|\s*(?:[^|]*\|\s*)?T-\d+/.test(line)) return;
    rows += 1;
    const cells = line.split('|').map((cell) => cell.trim());
    const id = (line.match(/T-\d+/) || ['T-?'])[0];
    REF.lastIndex = 0;
    if (!REF.test(line)) findings.push(`${relative}: ${id} cites no file:line`);
    REF.lastIndex = 0;
    if (!cells.some((cell) => CONTROLLED.test(cell) || OPEN_MARKERS.test(cell))) {
      findings.push(`${relative}: ${id} has no evaluation (controlled / open risk)`);
    }
    // 3. a claim of control must quote a test assertion that exists
    if (CONTROLLED.test(line) && !OPEN_MARKERS.test(line)) {
      const quoted = [...line.matchAll(/'([^']{10,})'/g)].map((match) => match[1].toLowerCase());
      if (!quoted.length) {
        findings.push(`${relative}: ${id} claims control without quoting a test assertion`);
      } else {
        quoted.forEach((name) => {
          if (!tests.has(name)) findings.push(`${relative}: ${id} quotes a test that does not exist: ${name}`);
        });
      }
    }
  });

  if (!citations) findings.push('no citations at all — an audit document without references is a rumour');
  if (!rows) findings.push('no threat rows found — the table shape changed or the audit is empty');
  return { citations: citations, rows: rows, findings: findings };
}

function audit(override) {
  return auditAt(ROOT, override);
}

/* ---------------------------------------------------------------- self-test */

/** Fixtures are written to a temp root so the self-test exercises the real resolver. */
function fixtureRoot(files) {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  Object.entries(files).forEach(([relative, content]) => {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  });
  return dir;
}

function selfTest() {
  const src = (lineCount) => Array.from({ length: lineCount }, () => '// line').join('\n') + '\n';
  const root = fixtureRoot({
    'Code.gs': src(1000),
    'scripts/test-x.js': "check('health turns red when the request sheet is unreachable', () => {});\n"
  });
  const header = '| ID | STRIDE | threat | site | control | evidence | evaluation |\n| --- | --- | --- | --- | --- | --- | --- |\n';
  const good = header
    + "| T-01 | Spoofing | threat | `Code.gs:988` | control | `Code.gs:988` | **مُسيطَر** : 'health turns red when the request sheet is unreachable' |\n"
    + '| T-99 | DoS | threat | `Code.gs:124` | nothing | `Code.gs:124` | **مخاطرة قائمة** |';

  const cases = [
    { name: 'a citation that resolves and a test that exists passes', text: good, expect: 0 },
    { name: 'a missing file fails', text: good.replace('`Code.gs:988`', '`docs/nope.md:1`'), expect: 1 },
    { name: 'a line past the end of the file fails', text: good.replace('`Code.gs:988`', '`Code.gs:99999`'), expect: 1 },
    { name: 'a threat row with no citation fails', text: header + '| T-01 | Spoofing | threat | none | control | none | **مخاطرة قائمة** |', expect: 1 },
    { name: 'a controlled row without a quoted test fails', text: good.replace(" : 'health turns red when the request sheet is unreachable'", ''), expect: 1 },
    { name: 'a quoted test that does not exist fails', text: good.replace("'health turns red when the request sheet is unreachable'", "'a test nobody wrote'"), expect: 1 },
    { name: 'a document with no threat rows fails', text: 'no table here', expect: 1 }
  ];

  let failed = 0;
  cases.forEach((testCase) => {
    const result = auditAt(root, { text: testCase.text });
    const code = result.findings.length === 0 ? 0 : 1;
    if (code === testCase.expect) console.log(`✓ self-test: ${testCase.name}`);
    else {
      console.error(`✗ self-test: ${testCase.name} (exit ${code}, expected ${testCase.expect}) ${result.findings.join('; ')}`);
      failed += 1;
    }
  });
  fs.rmSync(root, { recursive: true, force: true });

  if (failed) {
    console.error(`\nAudit-doc gate self-test FAILED (${failed} of ${cases.length}).`);
    return 1;
  }
  console.log(`\nAudit-doc gate self-test passed: ${cases.length} cases.`);
  return 0;
}

if (process.argv.includes('--self-test')) process.exit(selfTest());

const report = audit();
if (report.findings.length) {
  report.findings.forEach((finding) => console.error(`✗ ${finding}`));
  console.error(`\nAudit gate FAILED: ${report.findings.length} problem(s) across ${report.rows} threat row(s) and ${report.citations} citation(s).`);
  process.exit(1);
}
console.log(`Audit gate passed: ${report.rows} threat rows, ${report.citations} file:line citations, all resolvable.`);
