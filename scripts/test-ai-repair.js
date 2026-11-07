#!/usr/bin/env node
'use strict';

/**
 * The repair pipeline's own regression suite.
 *
 * The self-tests inside each script prove the *rules* fire. This file proves the *seam*
 * between them: a scan report flows into a diagnosis, a diagnosis flows into a proposal,
 * and every step refuses to continue when its input is missing, incomplete, or unsafe.
 *
 * It also guards the security shape of the two workflows (read-only triage, secret only in
 * the analysis job, tests in a job with no secret and no write permission), because a
 * privilege boundary that nobody tests is a comment.
 *
 *   node scripts/test-ai-repair.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const scanner = require('./ci-error-scanner.js');
const rootCause = require('./ai-root-cause.js');
const repair = require('./ai-repair.js');
const guard = require('./ai-patch-guard.js');

/**
 * Split a workflow into its job blocks by header (`  name:` at exactly two spaces).
 * Crude, but it is the same shape GitHub reads, and it keeps the privilege assertions
 * honest: a test that greps the whole file cannot tell which job holds a secret.
 */
function jobBlocks(text) {
  const blocks = {};
  let current = null;
  String(text).split('\n').forEach((line) => {
    const header = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      blocks[current] = '';
      return;
    }
    if (current) blocks[current] += line + '\n';
  });
  return blocks;
}

// This is a narrow shape check, not proof against malicious workflow edits. The job must
// be restricted before it checks out code and receives a provider credential.
function assertLiveSmokeBoundary(workflow) {
  const job = jobBlocks(workflow)['live-llm-smoke'];
  assert.ok(job, 'live LLM smoke job is present');
  const conditions = [...job.matchAll(/^ {4}if:\s*(.+)$/gm)];
  assert.equal(conditions.length, 1, 'exactly one job-level condition is required');
  assert.equal(conditions[0][1].trim(), "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main' && vars.LLM_SMOKE_ENABLED == 'true'");
  assert.equal((String(workflow).match(/\$\{\{\s*secrets\.GEMINI_API_KEY\s*\}\}/g) || []).length, 1);
  assert.match(job, /GEMINI_API_KEY:\s*\$\{\{\s*secrets\.GEMINI_API_KEY\s*\}\}/);
  assert.match(job, /run:\s*node scripts\/live-llm-smoke\.js/);
  assert.doesNotMatch(job, /^\s*ref:\s*\$\{\{/m, 'do not check out a different ref in the secret-bearing job');
}

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name} — ${error.message}`);
  }
}

const RUN = {
  id: 42169489664,
  run_attempt: 1,
  head_sha: 'd763c2b4e0f1d31733de930abfe09c0f6a76a055',
  head_branch: 'arena/5bc2896d-dr-mukhtar',
  name: 'CI',
  jobs: [
    {
      name: 'live LLM smoke (optional)',
      conclusion: 'failure',
      steps: [{ name: 'Probe the configured provider', conclusion: 'failure', message: 'LIVE LLM SMOKE FAILED: provider returned an empty answer' }]
    },
    {
      name: 'lint · typecheck · test · build · audit',
      conclusion: 'cancelled',
      steps: [
        { name: 'Secret scan', conclusion: 'success', message: '' },
        { name: 'UI smoke test (jsdom)', conclusion: 'skipped', message: 'skipped after an earlier failure' },
        { name: 'Readiness document', conclusion: 'cancelled', message: 'The operation was canceled.' }
      ]
    }
  ],
  annotations: []
};

const DIAGNOSIS = {
  error_id: 'fp-0e1f2a3b',
  severity: 'medium',
  error_category: 'provider-empty-answer',
  file: 'scripts/live-llm-smoke.js',
  line: null,
  affected_function: 'main',
  root_cause: 'the probe runs whenever a key exists, so a switch set to false still spends quota and reports a failure',
  evidence: ['LIVE LLM SMOKE FAILED: provider returned an empty answer'],
  facts: ['the step failed'],
  hypotheses: ['the switch is not consulted'],
  proposed_fix: 'consult LLM_SMOKE_ENABLED before calling the provider',
  required_tests: ['scripts/test-llm-smoke-probe.js'],
  confidence: 0.85,
  requires_human_review: true
};

const PATCH = [
  'diff --git a/scripts/live-llm-smoke.js b/scripts/live-llm-smoke.js',
  '--- a/scripts/live-llm-smoke.js',
  '+++ b/scripts/live-llm-smoke.js',
  '@@ -1,2 +1,2 @@',
  '-const enabled = Boolean(process.env.FLAG);',
  '+const enabled = process.env.FLAG === "true";',
  ' module.exports = { enabled };',
  ''
].join('\n');

(async () => {
  /* ------------------------------------------------- the seam: scan → diagnose */
  const report = scanner.buildReport({ runs: [RUN], source: 'fixture' }, { head: 'd763c2b' });

  await check('the scan finds the real failure and not the cancelled run', () => {
    assert.equal(report.counts.code_failures, 1);
    assert.equal(report.findings.filter((finding) => finding.category === 'cancelled').length, 1);
    assert.equal(report.findings.filter((finding) => finding.category === 'skipped').length, 1);
    assert.deepEqual(report.repair_candidates.length, 1);
  });

  await check('the scanner CLI writes a report another stage can read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    const fixture = path.join(dir, 'run.json');
    fs.writeFileSync(fixture, JSON.stringify(RUN));
    const out = path.join(dir, 'report.json');
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci-error-scanner.js'), '--fixture', fixture, '--json', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const written = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(written.schema, 'celia.ci-error-report/1');
    assert.ok(written.findings.some((finding) => finding.step === 'Probe the configured provider'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('the scanner CLI refuses to run without input', () => {
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ci-error-scanner.js')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
  });

  /* --------------------------------------------- diagnosis is audited, not trusted */
  const audited = rootCause.validateAnalysis_(DIAGNOSIS, { readFile: () => 'function main() {}\n' });

  await check('a diagnosis that cites a real file and function survives the audit', () => {
    assert.equal(audited.analysis.diagnosis_status, 'supported');
    assert.equal(audited.analysis.file, 'scripts/live-llm-smoke.js');
  });

  await check('a diagnosis that invents a test file is caught downstream', () => {
    const invented = Object.assign({}, DIAGNOSIS, { required_tests: ['scripts/test-imaginary.js'] });
    const vetted = repair.vetProposal({ rationale: 'r', risk: 'low', patch: PATCH, tests_to_run: invented.required_tests }, {});
    assert.equal(vetted.accepted, false);
    assert.ok(vetted.reasons.some((reason) => /does not exist/.test(reason)));
  });

  /* ----------------------------------------------------- diagnose → propose patch */
  await check('a supported diagnosis yields a proposal that names a real test', async () => {
    const result = await repair.propose({
      analysis: audited.analysis,
      readFile: () => 'const enabled = Boolean(process.env.FLAG);\nmodule.exports = { enabled };\n',
      transport: async () => ({ ok: true, text: JSON.stringify({ rationale: 'strict flag parse', risk: 'low', patch: PATCH, files: ['scripts/live-llm-smoke.js'], tests_to_run: ['scripts/test-llm-smoke-probe.js'] }) })
    });
    assert.equal(result.status, 'proposed');
    assert.equal(result.proposal.files.join(), 'scripts/live-llm-smoke.js');
  });

  await check('the same diagnosis with an unsafe patch yields no proposal', async () => {
    const result = await repair.propose({
      analysis: audited.analysis,
      readFile: () => 'x\n',
      transport: async () => ({ ok: true, text: JSON.stringify({ rationale: 'loosen the gate', risk: 'low', patch: PATCH.replace(/scripts\/live-llm-smoke\.js/g, '.github/workflows/ci.yml'), files: ['.github/workflows/ci.yml'], tests_to_run: ['scripts/test-llm-smoke-probe.js'] }) })
    });
    assert.equal(result.status, 'refused');
    assert.ok(result.reasons.some((reason) => /guard/.test(reason)));
  });

  /* ---------------------------------------- the patch guard sees a real diff shape */
  await check('the guard accepts the proposal it was shown and rejects a faked one', () => {
    assert.equal(guard.checkPatch(PATCH).ok, true);
    const faked = PATCH.replace('@@ -1,2 +1,2 @@', '@@ -1,2 +1,2 @@\n+const key = "AIza' + 'A'.repeat(35) + '";');
    assert.equal(guard.checkPatch(faked).ok, false);
  });

  /* -------------------------------------------------------------- workflow shape */
  const ciWorkflow = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  await check('the live smoke job is main-only, opt-in and never runs on PRs', () => {
    assertLiveSmokeBoundary(ciWorkflow);
    assert.throws(() => assertLiveSmokeBoundary(ciWorkflow.replace("github.ref == 'refs/heads/main'", "github.ref != 'refs/heads/main'")));
    assert.throws(() => assertLiveSmokeBoundary(ciWorkflow.replace("vars.LLM_SMOKE_ENABLED == 'true'", "vars.LLM_SMOKE_ENABLED != 'true'")));
    assert.throws(() => assertLiveSmokeBoundary(ciWorkflow.replace("github.event_name == 'push'", "github.event_name == 'pull_request'")));
  });
  const triage = fs.readFileSync(path.join(ROOT, '.github/workflows/ci-error-triage.yml'), 'utf8');
  const repairFlow = fs.readFileSync(path.join(ROOT, '.github/workflows/ai-repair.yml'), 'utf8');

  await check('the triage workflow is read-only', () => {
    const block = /^permissions:\n((?: {2}[a-z-]+: \w+\n)+)/m.exec(triage);
    assert.ok(block, 'the triage workflow declares top-level permissions');
    const granted = block[1].trim().split('\n').map((line) => line.trim());
    assert.deepEqual(granted.sort(), ['actions: read', 'checks: read', 'contents: read']);
    assert.ok(!/write/.test(block[1]));
  });

  await check('the triage workflow never receives the provider key', () => {
    assert.ok(!/GEMINI_API_KEY/.test(triage));
  });

  await check('the repair workflow is manual only and never runs on pull_request_target', () => {
    assert.ok(/workflow_dispatch/.test(repairFlow));
    assert.ok(!/pull_request_target/.test(repairFlow));
  });

  await check('the repair workflow puts the key in the analysis job only', () => {
    const jobs = jobBlocks(repairFlow);
    const analysisJob = Object.values(jobs).filter((block) => /GEMINI_API_KEY/.test(block));
    assert.equal(analysisJob.length, 1, 'exactly one job may receive the provider key');
    assert.ok(!/contents: write|pull-requests: write/.test(analysisJob[0]), 'the job holding the key must not be able to push or open a PR');
    assert.ok(!/git apply/.test(analysisJob[0]), 'the job holding the key must not apply a patch');
  });

  await check('the job that applies and tests a patch holds no secret', () => {
    const applyJob = Object.values(jobBlocks(repairFlow)).find((block) => /git apply/.test(block)) || '';
    assert.ok(applyJob, 'no job applies a patch');
    assert.ok(!/GEMINI_API_KEY/.test(applyJob));
  });

  await check('apply is preceded by a check, and auto-merge is absent', () => {
    assert.ok(/git apply --check/.test(repairFlow));
    assert.ok(!/gh pr merge/.test(repairFlow));
    assert.ok(!/\bdeploy\b/.test(repairFlow.replace(/#.*$/gm, '')));
  });

  if (failures.length) {
    failures.forEach((failure) => console.error(` ✗ ${failure}`));
    console.error(`\nAI repair pipeline: ${failures.length} of ${passed + failures.length} checks failed.`);
    process.exit(1);
  }
  console.log(`AI repair pipeline passed: ${passed} checks (scan → diagnose → propose → refuse-on-unsafe).`);
})();
