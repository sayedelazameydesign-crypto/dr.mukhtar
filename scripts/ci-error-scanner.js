#!/usr/bin/env node
'use strict';

/**
 * CI error scanner — the DETECT + CLASSIFY stage of the repair pipeline.
 *
 * Reads GitHub Actions state (read-only) and produces one structured JSON report:
 * which runs/jobs/steps failed, why, in which file, and whether the same fingerprint has
 * happened before. It never decides that something is a code defect on its own: every
 * finding carries `severity` and `category`, and the categories keep three states apart
 * that used to be conflated —
 *
 *   skipped   — the check did not run (proves nothing; never reported as passing)
 *   cancelled — the run was superseded or stopped (never reported as a code failure)
 *   failure   — a step really failed (the only category that can lead to a repair)
 *
 * Modes — all offline except the two that read GitHub:
 *   node scripts/ci-error-scanner.js --fixture <file.json>   # analyse a recorded run
 *   node scripts/ci-error-scanner.js --workflow-runs <dir>    # analyse exported JSON files
 *   node scripts/ci-error-scanner.js --live --run <id>        # read via `gh`/REST (needs a token)
 *   node scripts/ci-error-scanner.js --self-test              # prove the classifier fires
 *
 * Output: --json <path> writes the report; stdout gets a summary. Exit code is 0 when the
 * report was produced, 1 when the input could not be read — never 0 because nothing was found
 * to analyse (an empty scan is reported as `incomplete`, see `report.complete`).
 *
 * Security: logs and annotations are untrusted input. They are redacted, truncated, and
 * treated as data. Nothing in this file executes, evaluates, or interpolates them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const MAX_MESSAGE = 400;
const MAX_LOG_LINES = 200;

/* --------------------------------------------------------------- redaction */

/** Patterns that must never leave this process, even inside an error message. */
const SECRET_PATTERNS = [
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { id: 'github-pat', re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { id: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { id: 'google-oauth-secret', re: /GOCSPX-[A-Za-z0-9_-]{20,}/g },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  // Egyptian mobile numbers and e-mail addresses: a log line is not a reason to leak a patient.
  { id: 'phone', re: /(?:\+?20)?0?1[0125]\d{8}\b/g },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g }
];

/**
 * @param {string} text
 * @returns {{text:string, redactions:string[]}} redacted copy plus the rule ids that fired
 */
function redact(text) {
  let output = String(text === undefined || text === null ? '' : text);
  const fired = [];
  SECRET_PATTERNS.forEach((pattern) => {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(output)) {
      fired.push(pattern.id);
      pattern.re.lastIndex = 0;
      output = output.replace(pattern.re, `[redacted:${pattern.id}]`);
    }
  });
  // Actions' own masking prints ***; keep it, but count it so a report can say "masked".
  return { text: output, redactions: fired };
}

/** Redact, flatten whitespace, and cap length. */
function clean(text, limit) {
  const result = redact(text);
  const flattened = result.text.replace(/\s+/g, ' ').trim().slice(0, limit || MAX_MESSAGE);
  return { text: flattened, redactions: result.redactions };
}

/* ------------------------------------------------------------ classification */

/**
 * Ordered rules: the first match wins, so the most specific cause is the one reported.
 * Each rule names what the operator can do about it — a category without an action is
 * just a label.
 */
const RULES = [
  { id: 'infra-cancelled', category: 'cancelled', severity: 'info', action: 'none — a newer run superseded this one (concurrency group)',
    test: (f) => f.conclusion === 'cancelled' || /cancel/i.test(f.message) },
  { id: 'infra-skipped', category: 'skipped', severity: 'info', action: 'none — the step did not run, so it proves nothing',
    test: (f) => f.conclusion === 'skipped' },
  { id: 'timeout', category: 'timeout', severity: 'high', action: 'raise timeout-minutes or split the step',
    test: (f) => f.conclusion === 'timed_out' || /timed out after|The operation was canceled\.\s*$/i.test(f.message) },
  { id: 'auth', category: 'authentication', severity: 'high', action: 'rotate or restore the credential, then re-run',
    test: (f) => /HTTP 40[13]|rejected the credential|bad credentials|authentication failed/i.test(f.message) },
  { id: 'quota', category: 'quota', severity: 'medium', action: 'wait for the provider budget window or check the free-tier limits',
    test: (f) => /HTTP 429|quota exhausted|rate limit/i.test(f.message) },
  { id: 'provider-empty', category: 'provider-empty-answer', severity: 'medium', action: 'read the probe diagnostics (blockReason / finishReason), not the exit code',
    test: (f) => /empty answer|empty candidates|no candidates|blockReason|finishReason/i.test(f.message) },
  { id: 'network', category: 'network', severity: 'medium', action: 're-run; if it repeats, check provider status',
    test: (f) => /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network error|fetch failed/i.test(f.message) },
  { id: 'dependency', category: 'dependency', severity: 'high', action: 'inspect the npm advisory and pin or replace the package',
    test: (f) => /npm audit|vulnerabilit|ERESOLVE|ETARGET/i.test(f.message) },
  { id: 'missing-file', category: 'missing-reference', severity: 'medium', action: 'the step names a file or script that is not in the tree',
    test: (f) => /Cannot find module|No such file or directory|is missing/i.test(f.message) },
  { id: 'assertion', category: 'test-failure', severity: 'high', action: 'read the assertion name; the message states the violated rule',
    test: (f) => /\bAssertionError\b|\bexpected\b.*\bto (?:be|equal|match|throw)\b/i.test(f.message) },
  // Every gate in this repository prints ✗ for a violation it refused; that is the shape to
  // capture, so the rule looks for the marker as well as the exit code.
  { id: 'gate', category: 'gate-failure', severity: 'high', action: 'the gate refused the change; fix the cause, do not relax the gate',
    test: (f) => /::error|✗|exit 1|Process completed with exit code/i.test(f.message) },
  { id: 'unknown', category: 'unclassified', severity: 'medium', action: 'read the log; the pattern set has no rule for this shape yet',
    test: () => true }
];

/**
 * Classify one failed step into one category.
 * @param {{conclusion:string, message:string}} finding
 */
function classify(finding) {
  const message = finding && typeof finding.message === 'string' ? finding.message : '';
  for (const rule of RULES) {
    if (rule.test({ conclusion: finding && finding.conclusion, message: message })) {
      return { category: rule.category, severity: rule.severity, rule: rule.id, action: rule.action };
    }
  }
  return { category: 'unclassified', severity: 'medium', rule: 'unknown', action: RULES[RULES.length - 1].action };
}

/**
 * A stable identity for "the same failure again", so a repair loop cannot re-propose a fix
 * that already failed. Built from the step name and the *shape* of the message (digits and
 * ids removed), never from a timestamp or a run id.
 */
function fingerprint(finding) {
  const shape = clean(finding.message || '', 160).text
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/\d+/g, '<n>')
    .replace(/line \d+/gi, 'line <n>')
    .toLowerCase();
  const key = `${finding.workflow || ''}|${finding.job || ''}|${finding.step || ''}|${shape}`;
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** Pull `path/to/file.ext:12` mentions out of a message — best effort, never invented. */
function filenames(message) {
  const matches = String(message || '').match(/(?:^|[\s(`"'])((?:[\w.-]+\/)*[\w.-]+\.(?:js|mjs|cjs|ts|gs|py|json|ya?ml|md|html|css))(?::(\d+))?/g) || [];
  const seen = new Set();
  return matches
    .map((match) => match.trim().replace(/^[(`"']/, ''))
    .filter((reference) => {
      const file = reference.split(':')[0];
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .map((reference) => {
      const [file, line] = reference.split(':');
      return { file: file, line: line ? Number(line) : null, exists: fs.existsSync(path.join(ROOT, file)) };
    })
    .slice(0, 10);
}

/* ------------------------------------------------------------- ingestion */

/**
 * Normalise one Actions run (REST shape) into job/step findings.
 * Accepts either `jobs` embedded (as the API returns for a run) or a bare run object.
 */
function fromRun(run) {
  const jobs = Array.isArray(run.jobs) ? run.jobs : [];
  const findings = [];
  jobs.forEach((job) => {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const failedSteps = steps.filter((step) => step && ['failure', 'timed_out', 'cancelled'].includes(step.conclusion));
    // Skipped steps are only interesting inside a job that already failed: they are the
    // checks that never ran, and a check that never ran must never read as a pass.
    const skippedInFailedJob = failedSteps.length
      ? steps.filter((step) => step && step.conclusion === 'skipped')
      : [];
    if (!failedSteps.length && !skippedInFailedJob.length) return;
    failedSteps.concat(skippedInFailedJob).forEach((step) => {
      const message = step.message || step.output ||
        (step.conclusion === 'skipped'
          ? `step "${step.name}" never ran (skipped after an earlier failure in this job)`
          : `step "${step.name}" concluded ${step.conclusion}`);
      const cleaned = clean(message);
      const base = {
        run_id: run.id === undefined ? null : run.id,
        run_attempt: run.run_attempt === undefined ? null : run.run_attempt,
        commit: run.head_sha || null,
        branch: run.head_branch || null,
        workflow: run.name || run.workflow_name || null,
        job: job.name || null,
        job_conclusion: job.conclusion || null,
        step: step.name || null,
        conclusion: step.conclusion,
        message: cleaned.text,
        redactions: cleaned.redactions
      };
      const verdict = classify({ conclusion: step.conclusion, message: cleaned.text });
      findings.push(Object.assign(base, verdict, {
        evidence: 'step conclusion=' + step.conclusion,
        files: filenames(cleaned.text)
      }));
    });
  });
  return findings;
}

/** Annotations are richer than step conclusions; merge them by job/step name. */
function annotationsToFindings(annotations, run) {
  return (annotations || []).map((annotation) => {
    const cleaned = clean(annotation.message || '');
    const verdict = classify({ conclusion: 'failure', message: cleaned.text });
    return Object.assign({
      run_id: run && run.id !== undefined ? run.id : null,
      run_attempt: run && run.run_attempt !== undefined ? run.run_attempt : null,
      commit: (run && run.head_sha) || null,
      branch: (run && run.head_branch) || null,
      workflow: (run && run.name) || null,
      job: annotation.job_name || null,
      job_conclusion: null,
      step: annotation.step_name || null,
      conclusion: 'failure',
      message: cleaned.text,
      redactions: cleaned.redactions,
      evidence: `check-run annotation (${annotation.annotation_level || 'failure'}) at ${annotation.path || 'unknown'}:${annotation.start_line || 0}`,
      files: annotation.path ? [{ file: annotation.path, line: annotation.start_line || null, exists: fs.existsSync(path.join(ROOT, annotation.path)) }] : []
    }, verdict);
  });
}

/**
 * Build the report. `input` is:
 *   { runs: [run...], truncated?: boolean, source: 'live'|'fixture'|'files' }
 * A run with no jobs is NOT treated as passing: it is recorded as `unreadable`.
 */
function buildReport(input, options) {
  const opts = options || {};
  const runs = Array.isArray(input.runs) ? input.runs : [];
  const findings = [];
  const unreadable = [];

  runs.forEach((run) => {
    const jobs = Array.isArray(run.jobs) ? run.jobs : [];
    if (!jobs.length) {
      unreadable.push({ run_id: run.id === undefined ? null : run.id, reason: 'no jobs were returned for this run (API truncation or permission), so nothing can be concluded about it' });
      return;
    }
    fromRun(run).forEach((finding) => findings.push(finding));
    annotationsToFindings(run.annotations, run).forEach((finding) => findings.push(finding));
  });

  // Fingerprints + recurrence: the same shape twice is a pattern, not an accident.
  const byFingerprint = new Map();
  findings.forEach((finding) => {
    const print = fingerprint(finding);
    finding.fingerprint = print;
    if (!byFingerprint.has(print)) byFingerprint.set(print, []);
    byFingerprint.get(print).push(finding);
  });
  byFingerprint.forEach((group) => {
    if (group.length > 1) group.forEach((finding) => { finding.repeated = group.length; });
  });

  const codeFailures = findings.filter((finding) => !['cancelled', 'skipped'].includes(finding.category));
  const counts = {
    runs: runs.length,
    findings: findings.length,
    code_failures: codeFailures.length,
    cancelled: findings.filter((finding) => finding.category === 'cancelled').length,
    skipped: findings.filter((finding) => finding.category === 'skipped').length,
    repeated_patterns: [...byFingerprint.values()].filter((group) => group.length > 1).length,
    redactions: findings.reduce((total, finding) => total + (finding.redactions || []).length, 0),
    unreadable_runs: unreadable.length
  };

  return {
    schema: 'celia.ci-error-report/1',
    generated_at: new Date().toISOString(),
    source: input.source || 'unknown',
    head: opts.head || null,
    // A report that examined nothing proves nothing. Say so in the data, not in a footnote.
    complete: counts.runs > 0 && counts.unreadable_runs === 0,
    counts: counts,
    findings: findings,
    unreadable: unreadable,
    // Any code failure is a repair candidate; only a human decides whether to act on it.
    repair_candidates: codeFailures.filter((finding) => finding.severity === 'high' || finding.severity === 'medium').map((finding) => finding.fingerprint)
  };
}

/* ------------------------------------------------------------------ live mode */

function ghAvailable() {
  const result = spawnSync('gh', ['--version'], { encoding: 'utf8' });
  return result.status === 0;
}

function ghJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return null;
  }
}

/** Read one run + its jobs + its check-run annotations. Read-only; never mutates. */
function fetchRun(runId) {
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!repo) return null;
  const run = ghJson(['api', `repos/${repo}/actions/runs/${runId}`]);
  if (!run) return null;
  const jobs = ghJson(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`]);
  const annotations = [];
  ((jobs && jobs.jobs) || []).forEach((job) => {
    const checks = ghJson(['api', `repos/${repo}/check-runs/${job.id}/annotations`]);
    (checks || []).forEach((annotation) => annotations.push(Object.assign({ job_name: job.name }, annotation)));
  });
  return Object.assign({}, run, { jobs: (jobs && jobs.jobs) || [], annotations: annotations });
}

/* -------------------------------------------------------------- self-test */

/**
 * The scanner is only useful if its classifier actually fires. Each case below is a
 * *recorded shape* of a real conclusion, including the two that must never be called a
 * code failure: a cancelled run and a skipped step.
 */
const SELF_TEST_RUN = {
  id: 999,
  run_attempt: 1,
  head_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  head_branch: 'arena/test',
  name: 'CI',
  jobs: [
    {
      name: 'lint · typecheck · test · build · audit',
      conclusion: 'cancelled',
      steps: [
        { name: 'Secret scan', conclusion: 'failure', message: '✗ 1 secret-shaped string: AIza' + 'A'.repeat(35) + ' at config/x.js:3' },
        { name: 'UI smoke test (jsdom)', conclusion: 'skipped', message: 'skipped after an earlier failure' },
        { name: 'Readiness document', conclusion: 'cancelled', message: 'The operation was canceled.' }
      ]
    },
    {
      name: 'live LLM smoke (optional)',
      conclusion: 'failure',
      steps: [
        { name: 'Probe the configured provider', conclusion: 'failure', message: 'LIVE LLM SMOKE FAILED: provider returned an empty answer' },
        { name: 'Retry probe', conclusion: 'failure', message: 'LIVE LLM SMOKE FAILED: provider quota exhausted (HTTP 429)' },
        { name: 'Timeout probe', conclusion: 'timed_out', message: 'The action timed out after 5 minutes' }
      ]
    }
  ],
  annotations: [
    { annotation_level: 'failure', path: 'scripts/live-llm-smoke.js', start_line: 96, message: 'Process completed with exit code 1.', job_name: 'live LLM smoke (optional)' }
  ]
};

function selfTest() {
  const report = buildReport({ runs: [SELF_TEST_RUN], source: 'self-test' }, { head: 'deadbeef' });
  const byStep = (name) => report.findings.find((finding) => finding.step === name);
  const checks = [
    ['the secret scan failure is classified as a gate failure', () => byStep('Secret scan').category === 'gate-failure'],
    ['a secret-shaped string is redacted before it reaches the report', () => !JSON.stringify(report).includes('AIza' + 'A'.repeat(20))],
    ['a phone number in a log is redacted', () => !JSON.stringify(buildReport({ runs: [{ id: 1, jobs: [{ name: 'j', steps: [{ name: 's', conclusion: 'failure', message: 'guardian 01113593643 could not book' }] }] }] })).includes('01113593643')],
    ['a cancelled step is not a code failure', () => byStep('Readiness document').category === 'cancelled' && !report.repair_candidates.includes(byStep('Readiness document').fingerprint)],
    ['a skipped step is reported as skipped, never as passing', () => byStep('UI smoke test (jsdom)').category === 'skipped'],
    ['an empty answer is its own category', () => byStep('Probe the configured provider').category === 'provider-empty-answer'],
    ['a quota failure is its own category', () => byStep('Retry probe').category === 'quota'],
    ['a timed-out step is its own category', () => byStep('Timeout probe').category === 'timeout'],
    ['annotations are ingested with file and line', () => report.findings.some((finding) => finding.category === 'gate-failure' && finding.files.some((file) => file.file === 'scripts/live-llm-smoke.js' && file.line === 96))],
    ['the report says how many findings were cancelled vs failed', () => report.counts.cancelled >= 1 && report.counts.code_failures >= 4],
    ['a run with no jobs is recorded as unreadable, not as green', () => buildReport({ runs: [{ id: 5, jobs: [] }] }).counts.unreadable_runs === 1],
    ['the same failure in two runs is one repeated pattern', () => {
      const runAgain = JSON.parse(JSON.stringify(SELF_TEST_RUN));
      runAgain.id = 1000;
      runAgain.run_attempt = 2;
      return buildReport({ runs: [SELF_TEST_RUN, runAgain] }).counts.repeated_patterns >= 1;
    }],
    ['identical shapes in different attempts share a fingerprint', () => fingerprint({ workflow: 'CI', job: 'j', step: 's', message: 'failed at line 12' }) === fingerprint({ workflow: 'CI', job: 'j', step: 's', message: 'failed at line 481' })],
    ['an empty scan is marked incomplete', () => buildReport({ runs: [] }).complete === false]
  ];
  let failed = 0;
  checks.forEach(([name, predicate]) => {
    let ok = false;
    try { ok = predicate() === true; } catch (error) { ok = false; }
    if (ok) console.log(`✓ self-test: ${name}`);
    else { console.error(`✗ self-test: ${name}`); failed += 1; }
  });
  if (failed) {
    console.error(`\nCI error scanner self-test FAILED (${failed} of ${checks.length}).`);
    return 1;
  }
  console.log(`\nCI error scanner self-test passed: ${checks.length} cases.`);
  return 0;
}

/* --------------------------------------------------------------------- CLI */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`Cannot read ${file}: ${error.message}`);
    return null;
  }
}

function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };

  if (argv.includes('--self-test')) return selfTest();

  const runs = [];
  let source = 'unknown';
  let truncated = false;

  const fixture = flag('--fixture');
  const dir = flag('--workflow-runs');
  const liveRun = flag('--run');

  if (fixture) {
    const parsed = readJson(fixture);
    if (!parsed) return 1;
    (Array.isArray(parsed) ? parsed : [parsed]).forEach((run) => runs.push(run));
    source = 'fixture';
  } else if (dir) {
    if (!fs.existsSync(dir)) {
      console.error(`No such directory: ${dir}`);
      return 1;
    }
    fs.readdirSync(dir).filter((file) => /\.json$/.test(file)).sort().forEach((file) => {
      const parsed = readJson(path.join(dir, file));
      if (!parsed) { truncated = true; return; }
      (Array.isArray(parsed) ? parsed : [parsed]).forEach((run) => runs.push(run));
    });
    source = 'files';
  } else if (liveRun) {
    if (!ghAvailable()) {
      console.error('--live needs the GitHub CLI (`gh`) and a read-only token; neither is available here.');
      return 1;
    }
    const run = fetchRun(liveRun);
    if (!run) {
      console.error(`Could not read run ${liveRun}. Nothing is concluded from a failed read.`);
      return 1;
    }
    runs.push(run);
    source = 'live';
  } else {
    console.error('Nothing to scan. Use --fixture <file>, --workflow-runs <dir>, --live --run <id>, or --self-test.');
    return 1;
  }

  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  const report = buildReport({ runs: runs, source: source, truncated: truncated }, {
    head: head.status === 0 ? head.stdout.trim() : null
  });
  if (truncated) report.complete = false;

  const out = flag('--json');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, out), `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(`CI error scan (${report.source}) — ${report.counts.runs} run(s), ${report.counts.findings} finding(s): ` +
    `${report.counts.code_failures} code failure(s), ${report.counts.cancelled} cancelled, ${report.counts.skipped} skipped, ` +
    `${report.counts.repeated_patterns} repeated pattern(s), ${report.counts.redactions} redaction(s).`);
  report.findings.forEach((finding) => {
    console.log(` · [${finding.severity}/${finding.category}] ${finding.workflow || '?'} › ${finding.job || '?'} › ${finding.step || '?'} — ${finding.message.slice(0, 120)}`);
  });
  if (!report.complete) console.log(' ! report is incomplete: some runs could not be read. A partial scan is not a green scan.');
  console.log(out ? `Report written to ${out}` : 'No --json path given; the report is not persisted.');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { buildReport, classify, fingerprint, redact, clean, filenames, fromRun, RULES };
