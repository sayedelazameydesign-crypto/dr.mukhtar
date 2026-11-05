#!/usr/bin/env node
'use strict';

/**
 * The rehearsal tells the owner to copy files out of `gas/`. A document that names the wrong
 * set is worse than no document: the bundle compiles in the editor and fails at runtime, or a
 * file is silently skipped. This suite proves that check-rehearsal.js fails on any drift
 * between three things that must agree:
 *
 *   what the build produces  ·  what the checklist lists  ·  what the document names
 *
 * Each case builds a synthetic repository (CELIA_REPO_ROOT) so no real file is touched.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK = path.join(ROOT, 'scripts', 'check-rehearsal.js');
const BUILD = path.join(ROOT, 'scripts', 'build-gas-package.py');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-'));

let passed = 0;
const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

const BUNDLE = ['Index.html', 'Fonts.html', 'Code.gs', 'Llm.gs', 'Settings.gs', 'WhatsApp.gs', 'appsscript.json'];
// The build always emits the two HTML files; the rest exist only if the source file exists.
const SOURCE_FILES = ['Code.gs', 'Llm.gs', 'Settings.gs', 'WhatsApp.gs', 'appsscript.json'];

let counter = 0;
/**
 * @param {Object} spec built: source files to create, listed: checklist files (null = omit),
 *                      docNames: names the document mentions
 */
function makeRoot(spec) {
  counter += 1;
  const root = path.join(tmp, `case-${counter}`);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.copyFileSync(BUILD, path.join(root, 'scripts', 'build-gas-package.py'));
  (spec.built || SOURCE_FILES).forEach((name) => fs.writeFileSync(path.join(root, name), '// fixture\n'));

  const steps = [
    { id: 'S1.1', action: 'أنشئ المشروع', expected: 'يفتح', evidence: '' }
  ];
  if (spec.listed !== null) {
    steps.push({
      id: 'S1.2',
      action: 'انسخ ملفات gas/',
      expected: 'كل الملفات',
      files: spec.listed || BUNDLE,
      evidence: ''
    });
  }
  const checklist = {
    $comment: 'fixture',
    version: 1,
    owner: 'owner',
    sections: [{ id: 'S1', title: 'المشروع', closes: [], steps }]
  };
  fs.writeFileSync(path.join(root, 'scripts', 'rehearsal-checklist.json'), JSON.stringify(checklist, null, 2));

  const names = spec.docNames || BUNDLE;
  fs.writeFileSync(path.join(root, 'docs', 'google-rehearsal.md'),
    `# بروفة\n\nالملفات: ${names.join(' · ')}\n`);
  return root;
}

const run = (root) => spawnSync(process.execPath, [CHECK], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, CELIA_REPO_ROOT: root }
});

// 0 — the build list is readable without writing anything, and it is the source of truth.
{
  const listed = spawnSync('python3', [BUILD, '--list'], { cwd: ROOT, encoding: 'utf8' });
  check('build --list exits cleanly', listed.status === 0, listed.stderr);
  const names = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  check('build --list names all seven bundle files', names.length === 7 && BUNDLE.every((n) => names.includes(n)), names.join(','));
  // --list must be read-only: it is called by a check, and a check that writes is not a check.
  const scratch = makeRoot({});
  spawnSync('python3', [path.join(scratch, 'scripts', 'build-gas-package.py'), '--list'], { cwd: scratch, encoding: 'utf8' });
  check('build --list writes nothing', !fs.existsSync(path.join(scratch, 'gas')));
}

// 1 — agreement passes.
{
  const root = makeRoot({});
  check('a checklist that matches the build passes', run(root).status === 0);
}

// 2 — the checklist forgot a file the build produces.
{
  const root = makeRoot({ listed: BUNDLE.filter((n) => n !== 'WhatsApp.gs') });
  const result = run(root);
  check('a file produced but not listed fails', result.status === 1, String(result.status));
  check('the failure names the missing file', /WhatsApp\.gs/.test(result.stderr), result.stderr.slice(0, 200));
}

// 3 — the checklist invented a file the build never produces.
{
  const root = makeRoot({ listed: [...BUNDLE, 'Ghost.gs'] });
  const result = run(root);
  check('a listed file the build does not produce fails', result.status === 1);
  check('the failure names the invented file', /Ghost\.gs/.test(result.stderr), result.stderr.slice(0, 200));
}

// 4 — the build dropped a file (source removed) while the checklist still lists it.
{
  const root = makeRoot({ built: SOURCE_FILES.filter((n) => n !== 'Llm.gs') });
  const result = run(root);
  check('a listed file the build no longer produces fails', result.status === 1);
  check('the failure names Llm.gs', /Llm\.gs/.test(result.stderr), result.stderr.slice(0, 200));
}

// 5 — the document never names a file, so the owner cannot know to copy it.
{
  const root = makeRoot({ docNames: BUNDLE.filter((n) => n !== 'appsscript.json') });
  const result = run(root);
  check('a document that omits a file fails', result.status === 1);
  check('the failure names the document and the file', /google-rehearsal\.md/.test(result.stderr) && /appsscript\.json/.test(result.stderr));
}

// 6 — no bundle list at all is drift too (silence is not agreement).
{
  const root = makeRoot({ listed: null });
  const result = run(root);
  check('a checklist with no files array fails', result.status === 1);
  check('the failure asks for exactly one files array', /files/.test(result.stderr), result.stderr.slice(0, 160));
}

// 7 — a duplicated entry is a typo, not a second copy.
{
  const root = makeRoot({ listed: [...BUNDLE, 'Code.gs'] });
  check('a duplicated file entry fails', run(root).status === 1);
}

console.log(`Rehearsal bundle contract passed: ${passed} checks (build, checklist and document must agree).`);
