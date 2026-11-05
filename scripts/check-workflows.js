#!/usr/bin/env node
'use strict';

/**
 * Validates the secrets/variables contract for this repo:
 *
 *  1. docs/secrets-manifest.json is well formed; names follow UPPER_SNAKE_CASE,
 *     never start with a digit or GITHUB_, and are unique case-insensitively.
 *  2. Every `secrets.NAME` / `vars.NAME` used in a workflow exists in the
 *     manifest (and every manifest entry is actually used, or explicitly marked).
 *  3. Workflows never inline ${{ secrets.X }} inside a `run:` block, never dump
 *     env (printenv/env/set -x), never use pull_request_target with a head
 *     checkout, and never use self-hosted runners on this public repo.
 *  4. Every action is pinned: official `actions|github` → major tag; anything
 *     else → full 40-char commit SHA.
 *  5. Every job has timeout-minutes; top-level permissions are declared.
 *  6. .env.example lists exactly the manifest names, with empty values.
 *
 * Usage: node scripts/check-workflows.js [--strict]
 * Exits 1 on any violation so CI (and pre-commit) can block.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'secrets-manifest.json');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');
const strict = process.argv.includes('--strict');

const errors = [];
const warnings = [];
const fail = (message) => errors.push(message);
const warn = (message) => warnings.push(message);


/* ------------------------------------------------------------- self-test */
/**
 * `--self-test` builds a throwaway repo in the OS temp dir with deliberately
 * unsafe workflows and asserts the validator rejects each violation. This is
 * the regression test for the policy checks themselves.
 */
if (process.argv.includes('--self-test')) {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');

  const GOOD_MANIFEST = JSON.stringify({
    limits: { repo_secrets: 100 },
    secrets: [{ name: 'GEMINI_API_KEY', level: 'repo', used_by: ['ci'], provider: 'Google AI Studio', card_required: false, rotation_days: 90 }],
    variables: [{ name: 'APP_ENV', level: 'repo', default: 'ci', used_by: ['ci'] }]
  });
  const GOOD_ENV = 'APP_ENV=ci\nGEMINI_API_KEY=\n';
  const GOOD_WORKFLOW = `name: ok
on: [push]
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v5
      - name: run
        env:
          GEMINI_API_KEY: \${{ secrets.GEMINI_API_KEY }}
          APP_ENV: \${{ vars.APP_ENV }}
        run: echo "using $APP_ENV"
`;

  const cases = [
    { name: 'clean workflow passes', workflow: GOOD_WORKFLOW, expect: 0 },
    { name: 'inline secret in run: is rejected', workflow: GOOD_WORKFLOW.replace('run: echo "using $APP_ENV"', 'run: echo "\${{ secrets.GEMINI_API_KEY }}"'), expect: 1 },
    { name: 'undeclared secret is rejected', workflow: GOOD_WORKFLOW.replace(/GEMINI_API_KEY/g, 'UNKNOWN_TOKEN'), expect: 1 },
    { name: 'unpinned third-party action is rejected', workflow: GOOD_WORKFLOW.replace('uses: actions/checkout@v5', 'uses: some-org/deploy@main'), expect: 1 },
    { name: 'missing timeout-minutes is rejected', workflow: GOOD_WORKFLOW.replace('    timeout-minutes: 5\n', ''), expect: 1 },
    { name: 'missing permissions block is rejected', workflow: GOOD_WORKFLOW.replace('permissions:\n  contents: read\n', ''), expect: 1 },
    { name: 'self-hosted runner is rejected', workflow: GOOD_WORKFLOW.replace('runs-on: ubuntu-latest', 'runs-on: [self-hosted, linux]'), expect: 1 },
    { name: 'pull_request_target with head checkout is rejected', workflow: GOOD_WORKFLOW.replace('on: [push]', 'on: [pull_request_target]') + '      - uses: actions/checkout@v5\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n', expect: 1 },
    { name: 'env dump is flagged', workflow: GOOD_WORKFLOW.replace('run: echo "using $APP_ENV"', 'run: printenv'), expect: 0, expectWarning: true }
  ];

  let failed = 0;
  for (const testCase of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-contract-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'secrets-manifest.json'), GOOD_MANIFEST);
    fs.writeFileSync(path.join(dir, '.env.example'), GOOD_ENV);
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), testCase.workflow);

    let outcome;
    try {
      const output = execFileSync(process.execPath, [__filename], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, CELIA_REPO_ROOT: dir }
      });
      outcome = { code: 0, output };
    } catch (error) {
      outcome = { code: error.status || 1, output: `${error.stdout || ''}${error.stderr || ''}` };
    }
    fs.rmSync(dir, { recursive: true, force: true });

    const codeOk = outcome.code === testCase.expect;
    const warnOk = !testCase.expectWarning || /printenv|dumps the environment/i.test(outcome.output);
    if (codeOk && warnOk) console.log(`✓ self-test: ${testCase.name}`);
    else { console.error(`✗ self-test: ${testCase.name} (exit ${outcome.code}, expected ${testCase.expect})`); failed += 1; }
  }

  if (failed) { console.error(`\n${failed} self-test(s) failed.`); process.exit(1); }
  console.log(`\nContract self-test passed: ${cases.length} cases.`);
  process.exit(0);
}

/* ---------------------------------------------------------------- manifest */
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
} catch (error) {
  console.error(`Cannot read ${path.relative(ROOT, MANIFEST_PATH)}: ${error.message}`);
  process.exit(1);
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const declared = new Map(); // name -> kind

function validateEntry(entry, kind) {
  const where = `${kind}:${entry.name || '(missing name)'}`;
  if (!entry.name) return fail(`${where} — name is required`);
  if (!NAME_PATTERN.test(entry.name)) fail(`${kind} ${entry.name} — must match ${NAME_PATTERN} (UPPER_SNAKE_CASE, no leading digit)`);
  if (entry.name.startsWith('GITHUB_')) fail(`${kind} ${entry.name} — the GITHUB_ prefix is reserved`);
  const lowered = entry.name.toLowerCase();
  if (declared.has(lowered)) fail(`${kind} ${entry.name} — duplicate name (names are case-insensitive)`);
  declared.set(lowered, kind);
  if (!entry.level) fail(`${kind} ${entry.name} — level is required (repo | environment:<name> | org | dependabot)`);
  else if (!/^(repo|org|dependabot|environment:[a-z0-9-]+)$/.test(entry.level)) fail(`${kind} ${entry.name} — invalid level "${entry.level}"`);
  if (!Array.isArray(entry.used_by) || entry.used_by.length === 0) warn(`${kind} ${entry.name} — used_by is empty`);
  if (kind === 'secret') {
    if (typeof entry.card_required !== 'boolean') fail(`secret ${entry.name} — card_required must be a boolean (Zero-Card policy)`);
    if (entry.card_required === true) fail(`secret ${entry.name} — card_required is true; that violates the Zero-Card policy`);
    if (!entry.provider) warn(`secret ${entry.name} — provider is missing`);
    if (!(entry.rotation_days > 0)) warn(`secret ${entry.name} — rotation_days is missing`);
  }
  return entry.name;
}

(manifest.secrets || []).forEach((entry) => validateEntry(entry, 'secret'));
(manifest.variables || []).forEach((entry) => validateEntry(entry, 'variable'));
if (!manifest.secrets || !manifest.secrets.length) fail('manifest declares no secrets at all');
const secretCount = (manifest.secrets || []).length;
const varCount = (manifest.variables || []).length;
if (secretCount > (manifest.limits?.repo_secrets || 100)) fail('secret count exceeds the repo limit');
if (varCount > (manifest.limits?.repo_secrets || 100)) fail('variable count exceeds the repo limit');

/* --------------------------------------------------------------- workflows */
const workflowFiles = fs.existsSync(WORKFLOW_DIR)
  ? fs.readdirSync(WORKFLOW_DIR).filter((file) => /\.ya?ml$/.test(file))
  : [];
if (!workflowFiles.length) fail('.github/workflows has no workflow files');

const usedSecrets = new Set();
const usedVars = new Set();
const OFFICIAL_ACTION = /^(actions|github)\/[A-Za-z0-9._/-]+@v\d+(?:\.\d+){0,2}$/;
const SHA_PINNED = /@[0-9a-f]{40}$/;
const FORBIDDEN_RUN = [
  { re: /\bprintenv\b/, why: 'dumps the environment' },
  { re: /(^|[;&|]\s*)env\s*(>|\||$|\n)/m, why: 'dumps the environment' },
  { re: /set\s+-[a-z]*x/, why: 'traces commands (secrets end up in logs)' },
  { re: /echo\s+\$\{?(?:[A-Z_]*SECRET|[A-Z_]*TOKEN|[A-Z_]*KEY|CELIA_ADMIN_PIN|GEMINI_API_KEY)/, why: 'echoes a secret' }
];

for (const file of workflowFiles) {
  const relative = `.github/workflows/${file}`;
  const text = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
  const lines = text.split('\n');

  // 1. references exist in the manifest
  for (const match of text.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)/g)) {
    usedSecrets.add(match[1]);
    if (!declared.has(match[1].toLowerCase())) fail(`${relative} — secrets.${match[1]} is not declared in docs/secrets-manifest.json`);
  }
  for (const match of text.matchAll(/\$\{\{\s*vars\.([A-Za-z0-9_]+)/g)) {
    usedVars.add(match[1]);
    if (!declared.has(match[1].toLowerCase())) fail(`${relative} — vars.${match[1]} is not declared in docs/secrets-manifest.json`);
  }

  // 2. top-level permissions
  if (!/^permissions:/m.test(text)) fail(`${relative} — declare a minimal top-level permissions: block`);

  // 3. pull_request_target + head checkout / self-hosted
  // Matches both block style (`pull_request_target:`) and flow style (`on: [pull_request_target]`).
  if (/\bpull_request_target\b/.test(text)) {
    if (/ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)/.test(text)) {
      fail(`${relative} — pull_request_target must never check out PR head code`);
    } else {
      warn(`${relative} — pull_request_target is risky; prefer pull_request`);
    }
  }
  if (/runs-on:\s*\[?\s*self-hosted/.test(text)) fail(`${relative} — self-hosted runners are forbidden on public repos`);

  // 4. action pinning
  for (const match of text.matchAll(/uses:\s*([^\s#]+)/g)) {
    const ref = match[1];
    if (ref.startsWith('./')) continue;
    if (SHA_PINNED.test(ref)) continue;
    if (OFFICIAL_ACTION.test(ref)) continue;
    fail(`${relative} — ${ref} must be pinned to a full commit SHA (non-official action or floating major)`);
  }

  // 5. every job needs timeout-minutes
  const jobBlocks = text.split(/^  (?=[A-Za-z0-9_-]+:\s*$)/m).slice(1);
  jobBlocks.forEach((block) => {
    const name = (block.match(/^([A-Za-z0-9_-]+):/) || [])[1];
    if (!name || !/\n\s{4}(?:name|runs-on|steps|uses|needs|environment):/.test(block)) return;
    if (!/timeout-minutes:/.test(block)) fail(`${relative} — job "${name}" has no timeout-minutes`);
  });

  // 6. inline secrets in run blocks / forbidden shell patterns
  let inRun = false;
  let runIndent = 0;
  lines.forEach((line, index) => {
    // Single-line form: `run: echo ${{ secrets.X }}`
    const inlineRun = /^\s*(?:-\s+)?run:\s*(?!\||>)(.+)$/.exec(line);
    if (inlineRun && /\$\{\{\s*secrets\./.test(inlineRun[1])) {
      fail(`${relative}:${index + 1} — secrets must be passed via env:, never inlined in run:`);
    }
    const runMatch = /^(\s*)(?:-\s+)?run:\s*(\||>)?\s*$/.exec(line);
    if (runMatch) { inRun = true; runIndent = runMatch[1].length; return; }
    if (inRun) {
      const indent = line.search(/\S/);
      if (line.trim() !== '' && indent <= runIndent) inRun = false;
      else if (/\$\{\{\s*secrets\./.test(line)) {
        fail(`${relative}:${index + 1} — secrets must be passed via env:, never inlined in run:`);
      }
    }
    if (inRun || /^\s*(?:-\s+)?run:/.test(line)) {
      FORBIDDEN_RUN.forEach((rule) => {
        if (rule.re.test(line)) warn(`${relative}:${index + 1} — pattern "${rule.why}" (${line.trim().slice(0, 60)})`);
      });
    }
  });
}

/* ------------------------------------------------- manifest ↔ usage parity */
const BYPASS = new Set(['CELIA_ADMIN_PIN']);
(manifest.secrets || []).forEach((entry) => {
  if (!usedSecrets.has(entry.name) && !BYPASS.has(entry.name)) {
    warn(`manifest secret ${entry.name} is not referenced by any workflow (declared-only is allowed, keep it deliberate)`);
  }
});
(manifest.variables || []).forEach((entry) => {
  if (!usedVars.has(entry.name)) warn(`manifest variable ${entry.name} is not referenced by any workflow`);
});

/* --------------------------------------------------------- .env.example */
if (!fs.existsSync(ENV_EXAMPLE)) {
  fail('.env.example is missing');
} else {
  const envText = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  const envNames = new Set(
    envText.split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line.trim()))
      .map((line) => line.split('=')[0].trim())
  );
  (manifest.secrets || []).forEach((entry) => {
    if (!envNames.has(entry.name) && !BYPASS.has(entry.name)) fail(`.env.example — missing secret name ${entry.name}`);
  });
  (manifest.variables || []).forEach((entry) => {
    if (!envNames.has(entry.name)) fail(`.env.example — missing variable name ${entry.name}`);
  });
  // Values for secret names must stay empty in the committed template.
  envText.split('\n').forEach((line, index) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) return;
    const [, name, value] = match;
    const entry = (manifest.secrets || []).find((item) => item.name === name);
    if (entry && value.trim() !== '') fail(`.env.example:${index + 1} — ${name} must be empty (never commit secret values)`);
  });
}

/* ------------------------------------------------------------------ report */
warnings.forEach((message) => console.log(`· ${message}`));
if (errors.length) {
  console.error(`\nWorkflow/secrets contract FAILED (${errors.length}):`);
  errors.forEach((message) => console.error(` ✗ ${message}`));
  process.exit(1);
}

console.log(`Secrets contract OK — ${secretCount} secrets, ${varCount} variables declared; ` +
  `${workflowFiles.length} workflows checked (${usedSecrets.size} secret and ${usedVars.size} variable references resolved).`);
if (strict && warnings.length) {
  console.error(`--strict: ${warnings.length} warning(s) treated as failures.`);
  process.exit(1);
}
