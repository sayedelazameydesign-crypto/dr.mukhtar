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
  const GOOD_ENV_JS = `const ENV_SPECS = [\n  { name: 'GEMINI_API_KEY', secret: true, required: false, pattern: null, hint: '' },\n  { name: 'APP_ENV', secret: false, required: false, pattern: /^(ci)$/, hint: '' }\n];\n`;
  const GOOD_MAP_PROJECT = JSON.stringify({
    meta: { name: 'fixture', commit: '0000000', generated_at: '2026-01-01T00:00:00Z', coverage: 'partial' },
    summary_L0: 'one line',
    nodes: [
      { id: 'ui.index', kind: 'component', path: 'index.html', layer: 'ui', role: 'markup' },
      { id: 'domain.code', kind: 'module', path: 'Code.gs', layer: 'domain', role: 'rules' },
      { id: 'env.GEMINI_API_KEY', kind: 'env', path: '.env.example:1', layer: 'infra', role: 'secret name' },
      { id: 'env.APP_ENV', kind: 'env', path: '.env.example:2', layer: 'infra', role: 'variable name' }
    ],
    edges: [
      { type: 'calls', evidence: 'index.html:1', confidence: 'high', source: 'static', pairs: [['ui.index', 'domain.code']] },
      { type: 'uses_env', evidence: 'Code.gs:1', confidence: 'high', source: 'static', pairs: [['domain.code', 'env.GEMINI_API_KEY'], ['domain.code', 'env.APP_ENV']] }
    ]
  });
  const GOOD_GAPS = JSON.stringify({ gaps: [{ id: 'G1', type: 'docs_drift', evidence: 'README.md:1', fix: 'update it', severity: 'low' }], questions: [] });
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
    { name: 'stale project map is rejected under --strict', map: GOOD_MAP_PROJECT, expect: 1, strict: true, mapCommit: 'deadbee' },
    { name: 'env dump is flagged', workflow: GOOD_WORKFLOW.replace('run: echo "using $APP_ENV"', 'run: printenv'), expect: 0, expectWarning: true },
    { name: 'map edge pointing at an undeclared node is rejected', map: GOOD_MAP_PROJECT.replace(JSON.stringify('domain.code'), JSON.stringify('domain.ghost')), expect: 1 },
    { name: 'map missing a declared env name is rejected', map: GOOD_MAP_PROJECT.replace(/env\.APP_ENV/g, 'env.OTHER_NAME'), expect: 1 },
    { name: 'map without summary_L0 is rejected', map: JSON.stringify({ ...JSON.parse(GOOD_MAP_PROJECT), summary_L0: '' }), expect: 1 },
    { name: 'missing docs/map is rejected', map: null, expect: 1 },
    { name: 'bridge script calling Google directly is rejected', workflow: GOOD_WORKFLOW, expect: 1, bridgeLeak: true },
    { name: 'built-in GITHUB_TOKEN needs no declaration', workflow: GOOD_WORKFLOW.replace('GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}', 'GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), expect: 0, expectWarning: false }
  ];

  let failed = 0;
  for (const testCase of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-contract-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs', 'secrets-manifest.json'), GOOD_MANIFEST);
    fs.writeFileSync(path.join(dir, '.env.example'), GOOD_ENV);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'env.js'), GOOD_ENV_JS);
    fs.mkdirSync(path.join(dir, 'scripts', 'google'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'google', 'gateway.js'),
      "class LocalAdapter {}\nclass GoogleAdapter {}\n");
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'google.profile.example.json'),
      JSON.stringify({ profile: 'dev', account_label: 'label', auth_mode: 'oauth_user', scopes: ['drive.file'], root_folder_name: 'r', fallback: 'local', layout: { 'memory/long': null }, function_map: { 'memory.long': 'drive' } }));
    fs.writeFileSync(path.join(dir, 'scripts', 'enable-pages.sh'),
      '#!/usr/bin/env sh\n# --dry-run\ngh secret set PAGES_TOKEN\ngh secret delete PAGES_TOKEN\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'bootstrap-github.sh'),
      '#!/usr/bin/env sh\n# --dry-run supported\ngit status >/dev/null\n');
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), testCase.workflow || GOOD_WORKFLOW);
    if (testCase.map !== null) {
      fs.mkdirSync(path.join(dir, 'docs', 'map'), { recursive: true });
      // A local git repo makes the map's commit comparable with HEAD, so the
      // staleness rule can be exercised (git is present wherever CI runs).
      const git = (...args) => require('node:child_process').execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      if (!testCase.noGit) {
        git('init', '-q');
        git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'head');
        if (testCase.mapCommit) {
          fs.writeFileSync(path.join(dir, 'docs', 'map', 'project.json'),
            testCase.map.replace(/\"commit\":\"[^\"]*\"/, `\"commit\":\"${testCase.mapCommit}\"`));
        }
      }
      fs.writeFileSync(path.join(dir, 'docs', 'map', 'project.json'), testCase.map || GOOD_MAP_PROJECT);
      fs.writeFileSync(path.join(dir, 'docs', 'map', 'gaps.json'), GOOD_GAPS);
      fs.writeFileSync(path.join(dir, 'docs', 'map', 'ARCHITECTURE.md'), '# fixture\n');
    }
    if (testCase.bridgeLeak) {
      fs.writeFileSync(path.join(dir, 'scripts', 'google', 'selftest.js'),
        "const url = 'https://www.googleapis.com/drive/v3/files';\n");
    }

    let outcome;
    try {
      const output = execFileSync(process.execPath, [__filename].concat(testCase.strict ? ['--strict'] : []), {
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
// Injected by Actions on every run; never stored, never user-supplied.
const BUILTIN_CONTEXT = new Set(['GITHUB_TOKEN', 'GITHUB_ACTOR', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF']);
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
    if (BUILTIN_CONTEXT.has(match[1])) continue;
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
      // Uploading a directory that may hold .env / properties exports is forbidden.
      if (/upload-artifact/.test(line) && /\.(env|properties)/.test(line)) {
        fail(`${relative}:${index + 1} — do not upload .env or properties files as artifacts`);
      }
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

/* ---------------------------------------------- scripts/env.js ↔ manifest */
const ENV_JS = path.join(ROOT, 'scripts', 'env.js');
if (!fs.existsSync(ENV_JS)) {
  fail('scripts/env.js is missing (startup env contract)');
} else {
  const envSource = fs.readFileSync(ENV_JS, 'utf8');
  const specNames = new Set([...envSource.matchAll(/name:\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]));
  if (!specNames.size) fail('scripts/env.js declares no ENV_SPECS names');
  (manifest.secrets || []).forEach((entry) => {
    if (!specNames.has(entry.name)) fail(`scripts/env.js — missing secret ${entry.name} (add an ENV_SPECS entry with required/pattern)`);
  });
  (manifest.variables || []).forEach((entry) => {
    if (!specNames.has(entry.name)) fail(`scripts/env.js — missing variable ${entry.name}`);
  });
  specNames.forEach((name) => {
    if (!declared.has(name.toLowerCase())) fail(`scripts/env.js — ${name} is not declared in docs/secrets-manifest.json`);
  });
  // Generated/committed files must never embed a value: spec entries carry names only.
  if (/name:\s*'[A-Z_]+'[^}]*value:\s*'[^']+'/i.test(envSource)) fail('scripts/env.js — must not contain literal values');
}

/* ------------------------------------------------- bootstrap safety */
const BOOTSTRAP = path.join(ROOT, 'scripts', 'bootstrap-github.sh');
if (!fs.existsSync(BOOTSTRAP)) {
  fail('scripts/bootstrap-github.sh is missing (owner bootstrap)');
} else {
  const script = fs.readFileSync(BOOTSTRAP, 'utf8');
  // Secrets must be prompted, never passed as arguments or literals.
  if (/gh secret set [^\n]*--body/.test(script)) fail('scripts/bootstrap-github.sh — never pass --body to gh secret set');
  if (/^\s*\w+_KEY=|^\s*\w+_PIN=/m.test(script)) fail('scripts/bootstrap-github.sh — must not assign secret values');
  if (!/--dry-run/.test(script)) fail('scripts/bootstrap-github.sh — must support --dry-run');
  try {
    require('node:child_process').execFileSync('sh', ['-n', BOOTSTRAP], { stdio: 'pipe' });
  } catch (error) {
    fail('scripts/bootstrap-github.sh — shell syntax error');
  }
}

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

/* ------------------------------------------------------------ project map */
/**
 * `docs/map/` is what a human or agent reads before touching code, so it is a
 * contract like the secrets manifest: present, parseable, every edge cited and
 * resolvable. Staleness (map commit behind HEAD) is a warning here and fails
 * under --strict, because a code-only commit must not be blocked by a doc bump.
 */
const MAP_DIR = path.join(ROOT, 'docs', 'map');
const EDGE_TYPES = new Set(['imports', 'calls', 'reads', 'writes', 'uses_env', 'deploys_to', 'tests', 'shares_contract', 'emits', 'handles']);

function gitHead() {
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (error) {
    return null; // exported copies have no git metadata; that is not an error
  }
}

if (!fs.existsSync(MAP_DIR)) {
  fail('docs/map/ is missing — follow project-map.md before coding');
} else {
  const readMap = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(MAP_DIR, file), 'utf8'));
    } catch (error) {
      fail(`docs/map/${file} — ${error.message}`);
      return null;
    }
  };
  const project = readMap('project.json');
  const gaps = readMap('gaps.json');
  const architecture = path.join(MAP_DIR, 'ARCHITECTURE.md');
  if (!fs.existsSync(architecture)) fail('docs/map/ARCHITECTURE.md is missing');
  else if (fs.readFileSync(architecture, 'utf8').replace(/\n+$/, '').split('\n').length > 150) warn('docs/map/ARCHITECTURE.md is longer than 150 lines (project-map.md §11)');

  if (project) {
    const meta = project.meta || {};
    if (!meta.commit) fail('docs/map/project.json — meta.commit is required');
    if (!meta.generated_at) fail('docs/map/project.json — meta.generated_at is required');
    const l0 = String(project.summary_L0 || '');
    if (!l0.trim()) fail('docs/map/project.json — summary_L0 is required');
    else if (l0.split('\n').length > 15) fail(`docs/map/project.json — summary_L0 is ${l0.split('\n').length} lines, max 15`);

    const nodes = Array.isArray(project.nodes) ? project.nodes : [];
    if (!nodes.length) fail('docs/map/project.json — nodes is empty');
    const ids = new Set();
    nodes.forEach((node) => {
      if (!node.id) return fail('docs/map/project.json — a node has no id');
      if (ids.has(node.id)) fail(`docs/map/project.json — duplicate node id ${node.id}`);
      ids.add(node.id);
      ['kind', 'path', 'layer', 'role'].forEach((field) => {
        if (!node[field]) fail(`docs/map/project.json — node ${node.id} is missing ${field}`);
      });
      if (node.role && String(node.role).trim().split(/\s+/).length > 12) warn(`docs/map/project.json — node ${node.id} role exceeds 12 words`);
    });

    const edges = Array.isArray(project.edges) ? project.edges : [];
    if (!edges.length) fail('docs/map/project.json — edges is empty');
    edges.forEach((edge, index) => {
      const label = `docs/map/project.json — edge #${index + 1}`;
      if (!EDGE_TYPES.has(edge.type)) fail(`${label}: type "${edge.type}" is not one of ${[...EDGE_TYPES].join('|')}`);
      if (!edge.evidence) fail(`${label}: evidence (path:line) is required`);
      if (!['high', 'med', 'low'].includes(edge.confidence)) fail(`${label}: confidence must be high|med|low`);
      if (!edge.source) fail(`${label}: source is required`);
      if (!Array.isArray(edge.pairs) || !edge.pairs.length) return fail(`${label}: pairs is required`);
      edge.pairs.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) return fail(`${label}: each pair must be [from, to]`);
        pair.forEach((endpoint) => {
          const base = String(endpoint).split('#')[0];
          if (!ids.has(base)) fail(`${label}: "${base}" is not a declared node id`);
        });
      });
    });

    // Environment names are the contract shared with the manifest — the map must mention each one.
    const haystack = JSON.stringify({ nodes, edges, entrypoints: project.entrypoints || [] });
    [...(manifest.secrets || []), ...(manifest.variables || [])].forEach((entry) => {
      if (!haystack.includes(entry.name)) fail(`docs/map/project.json — declared name ${entry.name} is absent from the map`);
    });
  }

  if (gaps) {
    const list = Array.isArray(gaps.gaps) ? gaps.gaps : [];
    if (!list.length) warn('docs/map/gaps.json — no gaps recorded (unusual for any real repo)');
    const seen = new Set();
    list.forEach((gap) => {
      if (!gap.id) return fail('docs/map/gaps.json — a gap has no id');
      if (seen.has(gap.id)) fail(`docs/map/gaps.json — duplicate gap id ${gap.id}`);
      seen.add(gap.id);
      ['type', 'evidence', 'fix'].forEach((field) => {
        if (!gap[field]) fail(`docs/map/gaps.json — ${gap.id} is missing ${field}`);
      });
      if (!['high', 'med', 'low'].includes(gap.severity)) fail(`docs/map/gaps.json — ${gap.id} severity must be high|med|low`);
    });
  }

  const head = gitHead();
  const mapped = project && project.meta && project.meta.commit;
  if (head && mapped && !head.startsWith(mapped) && !mapped.startsWith(head.slice(0, 7))) {
    warn(`docs/map/ is stale — meta.commit ${mapped} but HEAD is ${head.slice(0, 7)}; refresh per project-map.md §8`);
  }
}

/* -------------------------------------------------- pages enablement script */
const ENABLE_PAGES = path.join(ROOT, 'scripts', 'enable-pages.sh');
if (!fs.existsSync(ENABLE_PAGES)) {
  fail('scripts/enable-pages.sh is missing (first-run Pages enablement path)');
} else {
  const script = fs.readFileSync(ENABLE_PAGES, 'utf8');
  if (/gh secret set [^\n]*--body/.test(script)) fail('scripts/enable-pages.sh — never pass --body to gh secret set');
  if (!/--dry-run/.test(script)) fail('scripts/enable-pages.sh — must support --dry-run');
  // The token it stores is single-purpose and short-lived: the script must remove it again.
  if (!/gh secret delete PAGES_TOKEN/.test(script)) fail('scripts/enable-pages.sh — must delete PAGES_TOKEN after a successful deploy');
  try {
    require('node:child_process').execFileSync('sh', ['-n', ENABLE_PAGES], { stdio: 'pipe' });
  } catch (error) {
    fail('scripts/enable-pages.sh — shell syntax error');
  }
}

/* --------------------------------------------------------- google bridge */
/**
 * The bridge's promises are testable, so they are checked here:
 * - one gateway, adapters behind it (google-bridge.md §5);
 * - the committed profile template is valid, carries no account, and its
 *   layout ids stay null (ids are private → git-ignored profile only);
 * - the active profile's secret name is derived, not hardcoded per account;
 * - every bridge script refuses to invent credentials (names only, §10);
 * - the site and the clinic backend stay independent of Google-only code.
 */
const BRIDGE_DIR = path.join(ROOT, 'scripts', 'google');
const PROFILE_TEMPLATE = path.join(ROOT, 'config', 'google.profile.example.json');
if (!fs.existsSync(PROFILE_TEMPLATE)) {
  fail('config/google.profile.example.json is missing (Google bridge template)');
} else {
  let template = null;
  try {
    template = JSON.parse(fs.readFileSync(PROFILE_TEMPLATE, 'utf8'));
  } catch (error) {
    fail(`config/google.profile.example.json — ${error.message}`);
  }
  if (template) {
    if (!template.profile) fail('config/google.profile.example.json — profile name is required');
    if (!template.auth_mode) fail('config/google.profile.example.json — auth_mode is required');
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(JSON.stringify(template))) {
      fail('config/google.profile.example.json — must not contain an email address (accounts stay out of the repo)');
    }
    const layout = template.layout || {};
    const filled = Object.keys(layout).filter((key) => layout[key]);
    if (filled.length) fail(`config/google.profile.example.json — layout must stay null in the template (found ${filled.join(', ')})`);
    const scopes = Array.isArray(template.scopes) ? template.scopes : [];
    if (!scopes.length) fail('config/google.profile.example.json — list the scopes explicitly');
    scopes.filter((scope) => /^https?:\/\//.test(String(scope)))
      .forEach((scope) => fail(`config/google.profile.example.json — scope "${scope}" must be the short form`));
    if (scopes.includes('https://mail.google.com/')) fail('config/google.profile.example.json — full mailbox scope is never acceptable');
  }
}

if (fs.existsSync(BRIDGE_DIR)) {
  const files = fs.readdirSync(BRIDGE_DIR).filter((file) => file.endsWith('.js'));
  if (!files.includes('gateway.js')) fail('scripts/google/gateway.js is missing (the single Google boundary)');
  files.forEach((file) => {
    const source = fs.readFileSync(path.join(BRIDGE_DIR, file), 'utf8');
    // 1. No client of the gateway may call Google directly.
    if (file !== 'gateway.js' && file !== 'auth.js' && file !== 'bootstrap.js') {
      if (/googleapis\.com/.test(source)) fail(`scripts/google/${file} — only the gateway (and the one-time auth/bootstrap) may call Google APIs`);
    }
    // 2. Credentials are read by NAME from the environment, never assigned.
    if (/\bGOOGLE_(CLIENT_SECRET|REFRESH_TOKEN_[A-Z0-9_]*)\s*=\s*['"][^'"]+['"]/.test(source)) {
      fail(`scripts/google/${file} — must not assign a credential value`);
    }
    // 3. Never print a credential, even in an error path.
    if (/console\.(log|error)\([^)]*\$\{[^}]*(refresh_token|client_secret|access_token)/i.test(source)) {
      fail(`scripts/google/${file} — logs a credential field`);
    }
  });
  // 4. The gateway must ship the fallback, otherwise nothing works without Google.
  const gateway = fs.existsSync(path.join(BRIDGE_DIR, 'gateway.js')) ? fs.readFileSync(path.join(BRIDGE_DIR, 'gateway.js'), 'utf8') : '';
  if (gateway && !/class LocalAdapter/.test(gateway)) fail('scripts/google/gateway.js — the local adapter is required (Google must never be a hard dependency)');
  if (gateway && !/class GoogleAdapter/.test(gateway)) fail('scripts/google/gateway.js — the google adapter is missing');
} else {
  warn('scripts/google/ is absent — the Google bridge is not wired in this repo');
}

// 5. The shipped site must not grow a Google dependency: no SDKs, no direct API hosts.
const clientFiles = ['index.html', 'app.js', 'app.css'];
clientFiles.forEach((file) => {
  const target = path.join(ROOT, file);
  if (!fs.existsSync(target)) return;
  const source = fs.readFileSync(target, 'utf8');
  if (/googleapis\.com|gstatic\.com\/drive|accounts\.google\.com/.test(source)) {
    fail(`${file} — the static site must not call Google APIs directly (Google calls live behind the gateway)`);
  }
});

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
