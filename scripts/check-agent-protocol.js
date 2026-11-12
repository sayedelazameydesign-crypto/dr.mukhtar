#!/usr/bin/env node
'use strict';

/**
 * The agent-protocol gate.
 *
 * docs/OPERATING-PROTOCOL.md and its siblings were written so an agent can be held to a
 * verifiable workflow. A protocol document nobody checks is prose: it drifts, links rot,
 * and the register quietly turns into a wish list. This gate exists so the protocol itself
 * fails loudly instead.
 *
 * What it enforces, and nothing more:
 *
 *   1. the protocol files exist (missing file = the protocol is not in force);
 *   2. each carries its required sections/anchors (a stubbed-out file is not a protocol);
 *   3. AGENTS.md links every protocol document (an unlinked protocol is invisible);
 *   4. docs/ERROR-REGISTER.md has a well-formed register: numbered entries, a protection and
 *      regression reference per entry, and no placeholder rows;
 *   5. the register names its open section explicitly (hidden open items are how a register
 *      starts lying).
 *
 *   node scripts/check-agent-protocol.js            # check
 *   node scripts/check-agent-protocol.js --self-test  # build a broken fixture, demand failure
 *   CELIA_PROTOCOL_ROOT=/tmp/fixture node …          # test seam
 *
 * Exit 0 = the protocol is in force. Exit 1 = it is not, and the output says where.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.CELIA_PROTOCOL_ROOT
  ? path.resolve(process.env.CELIA_PROTOCOL_ROOT)
  : path.resolve(__dirname, '..');

const REQUIRED_FILES = [
  'AGENTS.md',
  'docs/OPERATING-PROTOCOL.md',
  'docs/QUALITY-GATES.md',
  'docs/ERROR-REGISTER.md',
  'docs/ACCEPTANCE-CRITERIA.md',
  'docs/DECISIONS.md',
  // Canonical product criteria and the ADR index the DECISIONS page points at.
  'docs/prd/acceptance.md',
  'docs/architecture/adr/README.md',
];

const REQUIRED_ANCHORS = {
  'docs/OPERATING-PROTOCOL.md': [
    'UNDERSTAND', 'INSPECT', 'PLAN', 'EXECUTE', 'VERIFY', 'REPORT',
    'Per-task contract', 'Final report template', 'Completion definition',
  ],
  'docs/QUALITY-GATES.md': [
    'npm run gates', 'ci.yml', 'Evidence format', 'Levels of protection', 'When a gate fails',
  ],
  'docs/ERROR-REGISTER.md': [
    'REG-001', 'Regression-test rule', 'Open incidents', 'Register maintenance',
  ],
  'docs/ACCEPTANCE-CRITERIA.md': [
    'docs/prd/acceptance.md', 'Definition of done', 'Task-contract template',
  ],
  'docs/DECISIONS.md': [
    'architecture/adr/0005', 'How to change a decision', 'Binding invariants',
  ],
};

const AGENTS_LINKS = [
  'docs/OPERATING-PROTOCOL.md',
  'docs/QUALITY-GATES.md',
  'docs/ERROR-REGISTER.md',
  'docs/ACCEPTANCE-CRITERIA.md',
  'docs/DECISIONS.md',
];

const REGISTER_MIN_ENTRIES = 10;
const ENTRY_STATUS = /VERIFIED|BLOCKED|FAILED|OPEN|NOT_EXECUTED|NOT_APPLICABLE/;
const PLACEHOLDER = /\b(TBD|TODO|FIXME|XXX|fill me|placeholder)\b/i;

function read(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), 'utf8');
  } catch {
    return null;
  }
}

function validate(root) {
  const failures = [];

  for (const relative of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(root, relative))) {
      failures.push(`missing required file: ${relative} — the protocol is not in force without it`);
    }
  }

  for (const [relative, anchors] of Object.entries(REQUIRED_ANCHORS)) {
    const text = read(root, relative);
    if (text === null) continue; // already reported as missing
    for (const anchor of anchors) {
      if (!text.includes(anchor)) {
        failures.push(`${relative}: required anchor "${anchor}" not found — the document was stubbed or renamed away`);
      }
    }
    if (PLACEHOLDER.test(text)) {
      failures.push(`${relative}: contains a placeholder marker (TBD/TODO/FIXME/…) — a protocol with holes is not a protocol`);
    }
  }

  const agents = read(root, 'AGENTS.md');
  if (agents !== null) {
    for (const link of AGENTS_LINKS) {
      if (!agents.includes(link)) {
        failures.push(`AGENTS.md does not reference ${link} — an unlinked protocol document is invisible to an agent reading only the entry file`);
      }
    }
  }

  const register = read(root, 'docs/ERROR-REGISTER.md');
  if (register !== null) {
    const entries = register.split('\n').filter((line) => /^\|\s*REG-\d{3}\s*\|/.test(line.trim()));
    if (entries.length < REGISTER_MIN_ENTRIES) {
      failures.push(`docs/ERROR-REGISTER.md: only ${entries.length} REG entries (expected ≥ ${REGISTER_MIN_ENTRIES}) — entries were lost`);
    }
    entries.forEach((line, index) => {
      const id = (line.match(/REG-\d{3}/) || ['?'])[0];
      const cells = line.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 6) {
        failures.push(`docs/ERROR-REGISTER.md: ${id} has ${cells.length} cells (expected ≥ 6: id · incident · cause · protection · regression · status)`);
      }
      if (!/test|gate|scan|CI|check-|smoke/i.test(line)) {
        failures.push(`docs/ERROR-REGISTER.md: ${id} names no test/gate as regression evidence — a register entry without one is a promise, not a protection`);
      }
      if (!ENTRY_STATUS.test(line)) {
        failures.push(`docs/ERROR-REGISTER.md: ${id} carries no recognised status — the register must say VERIFIED / BLOCKED / FAILED / OPEN`);
      }
    });
  }

  return failures;
}

function report(failures) {
  if (failures.length === 0) {
    console.log('Agent protocol OK: required files present, anchors intact, AGENTS.md linked, register well-formed.');
    return 0;
  }
  failures.forEach((failure) => console.error(` ✗ ${failure}`));
  console.error(`Agent protocol gate FAILED: ${failures.length} problem(s).`);
  return 1;
}

/* ---------------------------------------------------------------- self-test */
// The gate's own negative test: a gate that cannot fail is not a gate. Each case copies the
// real documents into a throwaway tree and breaks one thing; the validator must notice.
if (process.argv.includes('--self-test')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-protocol-'));
  const copy = (relative) => {
    const target = path.join(tmp, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), target);
  };
  const required = [...new Set([...REQUIRED_FILES, ...Object.keys(REQUIRED_ANCHORS)])];
  required.forEach(copy);

  const cases = [
    { name: 'a missing protocol file is rejected', break: () => fs.rmSync(path.join(tmp, 'docs', 'ERROR-REGISTER.md')), expect: 1 },
    {
      name: 'a stubbed-out protocol is rejected',
      break: () => fs.writeFileSync(path.join(tmp, 'docs', 'OPERATING-PROTOCOL.md'), '# stub\n'),
      expect: 1,
    },
    {
      name: 'a register with no regression references is rejected',
      break: () => {
        const file = path.join(tmp, 'docs', 'ERROR-REGISTER.md');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
          .replace(/test/g, 'documented')
          .replace(/gate/g, 'note')
          .replace(/CI/g, 'review')
          .replace(/check-/g, 'see-')
          .replace(/scan/g, 'review')
          .replace(/smoke/g, 'review'));
      },
      expect: 1,
    },
    {
      name: 'an AGENTS.md that stops linking the protocol is rejected',
      break: () => {
        const file = path.join(tmp, 'AGENTS.md');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/docs\/(OPERATING-PROTOCOL|QUALITY-GATES|ERROR-REGISTER|ACCEPTANCE-CRITERIA|DECISIONS)\.md/g, 'docs/old.md'));
      },
      expect: 1,
    },
  ];

  let failed = 0;
  // The pristine fixture must pass.
  const cleanFailures = validate(tmp);
  if (cleanFailures.length !== 0) {
    console.error(' ✗ self-test: the unmodified fixture should pass, but reported:');
    cleanFailures.forEach((failure) => console.error(`   · ${failure}`));
    failed += 1;
  } else {
    console.log(' ✓ self-test: unmodified fixture passes');
  }
  for (const testCase of cases) {
    const backups = new Map();
    const snapshot = (relative) => {
      const source = path.join(tmp, relative);
      if (fs.existsSync(source)) backups.set(relative, fs.readFileSync(source));
    };
    // Snapshot everything the case may touch, then restore between cases.
    REQUIRED_FILES.concat(Object.keys(REQUIRED_ANCHORS)).forEach(snapshot);
    testCase.break();
    const failures = validate(tmp);
    if (failures.length >= testCase.expect) {
      console.log(` ✓ self-test: ${testCase.name}`);
    } else {
      console.error(` ✗ self-test: ${testCase.name} — validator did not fail loudly (0 problem(s))`);
      failed += 1;
    }
    for (const [relative, buffer] of backups) {
      const target = path.join(tmp, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed) {
    console.error(`Agent protocol self-test FAILED: ${failed} case(s).`);
    process.exit(1);
  }
  console.log('Agent protocol self-test passed: the gate fails when it should, passes when it should.');
  process.exit(0);
}

process.exit(report(validate(ROOT)));
