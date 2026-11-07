#!/usr/bin/env node
'use strict';

/**
 * The silent-gate guard.
 *
 * actionlint had been "passing" for every run because the runner image did not ship it and
 * the step fell back to a warning. That class of defect — a gate that reports success
 * without running — is what this suite hunts automatically, so it cannot come back quietly.
 *
 * Two halves:
 *   1. Static rules over .github/workflows and scripts/: patterns that hide a failure.
 *   2. Live negative tests: each guard is fed the violation it exists to catch, and must
 *      fail. A guard that cannot fail is not a guard.
 *
 * Every finding names the file and line, so the fix is obvious.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// CELIA_REPO_ROOT lets the negative probe below run against a throwaway copy; the default is
// this checkout. CELIA_STATIC_ONLY runs only the static half (used by that probe).
const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const STATIC_ONLY = !!process.env.CELIA_STATIC_ONLY;
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) { passed += 1; return; }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

/* ------------------------------------------------------- 1. static: allowed exceptions */
/**
 * Patterns that genuinely hide failures. Each entry documents why it is allowed where it is,
 * keyed by "file:line-ish substring". Anything not listed here is a finding.
 */
const ALLOWED = [
  { file: 'ci.yml', match: '--exit-code 0 || true', why: 'the verdict is taken from the JSON report; a bare exit code would be invisible' },
  { file: 'pages.yml', match: 'continue-on-error: true', why: 'configure-pages enablement on a PR; the next step turns a missing site into an explicit error' }
];

const findings = [];
function scanWorkflows() {
  fs.readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).forEach((name) => {
    const lines = fs.readFileSync(path.join(WORKFLOWS, name), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/#.*$/, ''); // ignore comments: they may quote a bad pattern
      const patterns = [
        { regex: /\|\|\s*true\b/, label: '|| true' },
        { regex: /continue-on-error:\s*true/, label: 'continue-on-error: true' },
        { regex: /::warning/, label: '::warning instead of ::error' },
        { regex: /\|\|\s*exit\s+0\b/, label: '|| exit 0' },
        { regex: /set\s+\+e\b/, label: 'set +e (errors stop failing the step)' }
      ];
      patterns.forEach(({ regex, label }) => {
        if (!regex.test(code)) return;
        const allowed = ALLOWED.some((entry) => entry.file === name && line.includes(entry.match));
        if (!allowed) findings.push(`${name}:${index + 1} — ${label}: ${line.trim()}`);
      });
    });
  });
}

scanWorkflows();
check('no unapproved failure-hiding pattern in .github/workflows', findings.length === 0, findings.join(' | '));

/* ------------------------------ 2. static: every gate that exists can actually fail ------- */
// A step that runs a script must not be wrapped in `|| true`, and the script it runs must
// have a non-zero exit path. The second half is verified by the suites below, not by grep.
const ci = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
check('actionlint is not skipped when absent', !/command -v actionlint[\s\S]{0,200}else[\s\S]{0,120}exit 0/.test(ci));
check('gitleaks does not pass when it cannot run', !/binary_ok.*!=.*1[\s\S]{0,300}exit 0/.test(ci));
// The syntax gate must cover every script, not just the entrypoints CI happens to run:
// scripts/env.js shipped unparsable once because nothing imported it.
check('the syntax gate covers every script under scripts/', () => {
  const gate = fs.existsSync(path.join(ROOT, 'scripts', 'check-script-syntax.js'));
  if (!gate) return false;
  const ciText = fs.readFileSync(path.join(WORKFLOWS, 'ci.yml'), 'utf8');
  return /run: node scripts\/check-script-syntax\.js/.test(ciText) && !/run: node --check app\.js/.test(ciText);
});
check('the jsdom suites are required, not optional', /CELIA_ALLOW_SKIP_UI/.test(fs.readFileSync(path.join(ROOT, 'scripts', 'test-ui-smoke.js'), 'utf8')));

// 2b — the readiness document must be generated, not hand-written.
// A status page nobody can prove matches the ledger is a rumour with a table.
{
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'production-readiness.md'), 'utf8');
  check('the readiness document carries a generated block', /GENERATED:START[\s\S]*GENERATED:END/.test(doc));
  check('the readiness document names its source of truth', /gaps\.json/.test(doc));
  check('the readiness document does not reuse G-ids for pipeline stages', !/\|\s*\*\*G1 Build/.test(doc));
}

/* ------------------------------------------------- 3. live: guards that must reject input */
// Skipped in the nested probe: recursion here once took nearly three minutes.
if (STATIC_ONLY) {
  if (failures.length) {
    failures.forEach((failure) => console.log(` ✗ ${failure}`));
    process.exit(1);
  }
  console.log(`Silent-gate guard (static) passed: ${passed} checks.`);
  process.exit(0);
}

const run = (script, args = [], opts = {}) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
  cwd: opts.cwd || ROOT, encoding: 'utf8', env: { ...process.env, NODE_PATH: opts.nodePath || process.env.NODE_PATH || '' }
});

// 3a — the publish gate must reject a leaked internal file.
// Run against a throwaway copy of the repository: mutating the real workflow and restoring
// it races with the child process reading it, and once left the repository dirty.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const copy = (rel) => {
    const target = path.join(sandbox, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), target);
  };
  ['.github/workflows/pages.yml', 'scripts/test-publish-contract.js', 'index.html', 'privacy.html',
    'app.css', 'app.js', 'brand.svg', 'manifest.webmanifest', 'sw.js', 'robots.txt', 'sitemap.xml', '404.html',
    'clinic.json', 'config/.env.example'].forEach(copy);
  fs.mkdirSync(path.join(sandbox, 'assets', 'fonts'), { recursive: true });
  fs.readdirSync(path.join(ROOT, 'assets', 'fonts')).forEach((font) =>
    fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', font), path.join(sandbox, 'assets', 'fonts', font)));
  fs.mkdirSync(path.join(sandbox, 'evidence'), { recursive: true });
  fs.readdirSync(path.join(ROOT, 'evidence')).forEach((file) =>
    fs.copyFileSync(path.join(ROOT, 'evidence', file), path.join(sandbox, 'evidence', file)));

  const leaked = path.join(sandbox, '.github', 'workflows', 'pages.yml');
  fs.writeFileSync(leaked, fs.readFileSync(leaked, 'utf8').replace('404.html clinic.json _site/', '404.html clinic.json Llm.gs _site/'));
  const result = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'test-publish-contract.js')], {
    cwd: sandbox, encoding: 'utf8', env: { ...process.env, CELIA_REPO_ROOT: sandbox }
  });
  check('publish gate FAILS when an internal file is added to the bundle', result.status === 1, `exit ${result.status}`);

  fs.writeFileSync(leaked, fs.readFileSync(leaked, 'utf8').replace('404.html clinic.json Llm.gs _site/', '404.html clinic.json _site/'));
  const clean = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'test-publish-contract.js')], {
    cwd: sandbox, encoding: 'utf8', env: { ...process.env, CELIA_REPO_ROOT: sandbox }
  });
  check('publish gate passes once the leak is removed', clean.status === 0, clean.stdout.trim().split('\n').pop());
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// 3b — the clinic gate must reject an empty production file and accept a demo one.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  fs.mkdirSync(path.join(sandbox, 'scripts'));
  ['clinic-ready.js', 'clinic-schema.js'].forEach((file) =>
    fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(sandbox, 'scripts', file)));
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(sandbox, 'index.html'));

  fs.writeFileSync(path.join(sandbox, 'clinic.json'), JSON.stringify({ clinicName: '', phone: '', doctorName: '', license: '' }));
  const prod = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'clinic-ready.js')], { cwd: sandbox, encoding: 'utf8' });
  check('clinic gate FAILS a production file with empty facts', prod.status === 1, `exit ${prod.status}`);

  fs.writeFileSync(path.join(sandbox, 'clinic.json'), JSON.stringify({ demoMode: true, clinicName: '', phone: '', doctorName: '', license: '' }));
  const demo = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'clinic-ready.js')], { cwd: sandbox, encoding: 'utf8' });
  check('clinic gate PASSES an explicit demo file', demo.status === 0, `exit ${demo.status}`);

  fs.writeFileSync(path.join(sandbox, 'clinic.json'), JSON.stringify({ demoMode: true, clinicName: 'عيادة النور', phone: '0100123456', doctorName: 'د. سارة', license: 'EG-1' }));
  const badPhone = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'clinic-ready.js')], { cwd: sandbox, encoding: 'utf8' });
  check('clinic gate rejects a malformed phone even in demo mode', badPhone.status === 1, `exit ${badPhone.status}`);

  fs.rmSync(sandbox, { recursive: true, force: true });
}

// 3c — this guard must reject a workflow that hides a failure.
// The nested run is restricted to the static rules (CELIA_STATIC_ONLY) so the suite does not
// spawn itself recursively: the child proves the rule fires, the parent proves the guard runs.
{
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-'));
  const fixture = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  fs.mkdirSync(path.join(sandbox, '.github', 'workflows'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'docs'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'docs', 'secrets-manifest.json'), path.join(sandbox, 'docs', 'secrets-manifest.json'));
  fs.mkdirSync(path.join(sandbox, 'config'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'config', '.env.example'), path.join(sandbox, 'config', '.env.example'));

  const broken = fs.readFileSync(fixture, 'utf8').replace('run: node scripts/scan-secrets.js', 'run: node scripts/scan-secrets.js || true');
  fs.writeFileSync(path.join(sandbox, '.github', 'workflows', 'ci.yml'), broken);
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-silent-gates.js')], {
    cwd: sandbox, encoding: 'utf8', env: { ...process.env, CELIA_REPO_ROOT: sandbox, CELIA_STATIC_ONLY: '1' }
  });
  check('silent-gate guard FAILS a workflow that hides a failure with || true', result.status === 1,
    `exit ${result.status}: ${(result.stdout || '').slice(0, 160)}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}

/* ------------------------------------------------------------------------ verdict */
if (failures.length) {
  failures.forEach((failure) => console.log(` ✗ ${failure}`));
  console.log(`\nSilent-gate guard FAILED (${failures.length} of ${passed + failures.length} checks).`);
  process.exit(1);
}
console.log(`Silent-gate guard passed: ${passed} checks (no unapproved ||true/continue-on-error/::warning, and 5 negative probes fired).`);
process.exit(0);
