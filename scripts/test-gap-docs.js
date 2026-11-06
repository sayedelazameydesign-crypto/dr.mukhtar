#!/usr/bin/env node
'use strict';

/**
 * Offline tests for scripts/check-gap-docs.js.
 *
 * The gate exists because three pages disagreed about which gaps were open. A gate whose
 * own failure modes are untested would repeat that defect one level up, so each test below
 * builds a tiny fixture tree and asserts the gate's exit code and its message.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const GATE = path.join(__dirname, 'check-gap-docs.js');
let passed = 0;

const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

/** Build a throwaway repo root with a ledger and one derived page. */
function fixture({ gaps, note = '', page, extraFiles = {} }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'celia-gapdocs-'));
  fs.mkdirSync(path.join(root, 'docs', 'map'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'map', 'gaps.json'),
    JSON.stringify({ note, gaps }, null, 2)
  );
  if (page !== null) {
    fs.writeFileSync(path.join(root, 'docs', 'map', 'ARCHITECTURE.md'), page);
  }
  for (const [relative, content] of Object.entries(extraFiles)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [GATE], {
      env: { ...process.env, CELIA_GAP_DOCS_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status === undefined ? 1 : error.status, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

const page = (openLine, closedLine = '') => `# Architecture\n\n## 9. Open gaps\n\n${openLine}\n${closedLine}`.trim() + '\n';

// 1 — a page that matches the ledger passes.
const usingRecords = [
  { id: 'G1', severity: 'high' },
  { id: 'G2', resolution: { command: 'x' }, status: 'resolved' }
];
{
  const root = fixture({ gaps: usingRecords, page: page('Open gaps: G1 · G2') });
  // G2 is resolved, so claiming it open must fail; the matching page is the next test.
  const result = run(root);
  check('a page that claims a resolved gap as open fails', result.status === 1, result.output);
  check('the failure names the invented gap', /claims closed-or-unknown: G2/.test(result.output), result.output);
}

// 2 — exactly the ledger's set passes.
{
  const root = fixture({ gaps: usingRecords, page: page('Open gaps: G1') });
  const result = run(root);
  check('a page that restates the ledger exactly passes', result.status === 0, result.output);
  check('the pass message counts both sides', /1 open .*1 closed/.test(result.output), result.output);
}

// 3 — a missing open gap fails (the real defect: 5 open, page said 3).
{
  const gaps = [
    { id: 'G1', severity: 'high' },
    { id: 'G14', severity: 'med' },
    { id: 'G23', status: 'open', severity: 'med' }
  ];
  const root = fixture({ gaps, page: page('Open gaps: G1 · G14') });
  const result = run(root);
  check('a page that drops an open gap fails', result.status === 1, result.output);
  check('the failure names what is missing', /missing: G23/.test(result.output), result.output);
}

// 4 — the ledger note may not contradict its own records.
{
  const gaps = [{ id: 'G1', severity: 'high' }, { id: 'G2', severity: 'high' }];
  const root = fixture({
    gaps,
    note: 'Still open: G1, G4, G12–G14.',
    page: page('Open gaps: G1 · G2')
  });
  const result = run(root);
  check('a note that contradicts the records fails', result.status === 1, result.output);
  check('the note failure is reported as its own problem', /note says/i.test(result.output), result.output);
}

// 5 — a note without a hard-coded list is fine.
{
  const gaps = [{ id: 'G1', severity: 'high' }];
  const root = fixture({
    gaps,
    note: 'Open set is computed from the records; never restate it by hand.',
    page: page('Open gaps: G1')
  });
  check('a note that avoids restating the set passes', run(root).status === 0);
}

// 6 — a page that calls an open gap closed fails even if the open line is right.
{
  const gaps = [{ id: 'G1', severity: 'high' }, { id: 'G26', status: 'open', severity: 'med' }];
  const root = fixture({ gaps, page: page('Open gaps: G1 · G26', 'Closed 2026-11: G1.') });
  const result = run(root);
  check('a page that lists an open gap as closed fails', result.status === 1, result.output);
  check('the contradiction is named', /as closed while the ledger has them open/.test(result.output), result.output);
}

// 7 — a page without the machine-readable line fails.
{
  const root = fixture({ gaps: [{ id: 'G1' }], page: '# Architecture\n\nNo gap line here.\n' });
  const result = run(root);
  check('a page with no "Open gaps:" line fails', result.status === 1, result.output);
}

// 8 — a missing page fails instead of passing silently.
{
  const root = fixture({ gaps: [{ id: 'G1' }], page: null });
  const result = run(root);
  check('a missing map page fails', result.status === 1, result.output);
}

// 9 — an unreadable ledger fails with a message, not a stack trace.
{
  const root = fixture({ gaps: [], page: page('Open gaps: ') });
  fs.writeFileSync(path.join(root, 'docs', 'map', 'gaps.json'), '{ not json');
  const result = run(root);
  check('an unreadable ledger fails loudly', result.status === 1, result.output);
  check('the message says it is not JSON', /not readable JSON/.test(result.output), result.output);
}

// 10 — the real repository passes right now (the state this change set leaves behind).
{
  const result = execFileSync(process.execPath, [GATE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  check('the real repository passes the gate', /agree with the ledger/.test(result), result);
}

console.log(`\nGap-docs suite passed: ${passed} checks (single source of truth, both directions, note drift, missing page).`);
