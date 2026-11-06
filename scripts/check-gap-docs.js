#!/usr/bin/env node
'use strict';

/**
 * Single source of truth for gaps: `docs/map/gaps.json`.
 *
 * Why this gate exists: the ledger said 5 gaps were open, `docs/map/ARCHITECTURE.md`
 * said 3, and the ledger's own `note` listed a third set (G4/G5/G12–G14, all closed).
 * Every one of those pages is read by a human deciding what to do next, so a stale
 * list is not a typo — it is a plan built on a lie. No gate caught it, because no gate
 * read the derived pages at all.
 *
 * The rule this enforces, and nothing more:
 *
 *   1. a document that restates the open set must restate *exactly* the ledger's set;
 *   2. the ledger's own free-text note may not hard-code a set that disagrees.
 *
 * Closed-gap evidence is deliberately NOT validated here: it belongs to the ledger and
 * to the command that produced it, not to a mirror.
 *
 *   node scripts/check-gap-docs.js          # check
 *   CELIA_GAP_DOCS_ROOT=/tmp/fixture node …  # test seam (scripts/test-gap-docs.js)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_GAP_DOCS_ROOT
  ? path.resolve(process.env.CELIA_GAP_DOCS_ROOT)
  : path.resolve(__dirname, '..');

const LEDGER = path.join(ROOT, 'docs', 'map', 'gaps.json');
const DOCS = ['docs/map/ARCHITECTURE.md'];

// A gap is open unless the ledger says it is resolved/closed. Some records carry no
// status field at all — G1 is one — and those are open by definition, not by accident.
const CLOSED_STATES = new Set(['resolved', 'closed', 'fixed']);

function openIds(ledger) {
  return ledger.gaps
    .filter((gap) => !CLOSED_STATES.has(String(gap.status || '').toLowerCase()))
    .map((gap) => gap.id);
}

function idsIn(text) {
  return (String(text).match(/G\d+/g) || []);
}

const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

function main() {
  const problems = [];

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
  } catch (error) {
    console.error(`✗ ${path.relative(ROOT, LEDGER)} is not readable JSON: ${error.message}`);
    process.exit(1);
  }
  const expected = openIds(ledger);

  // 1 — the ledger's own note must not restate a set it disagrees with.
  const note = String(ledger.note || '');
  const stillOpen = note.match(/Still open:([^.]*)/i);
  if (stillOpen) {
    const claimed = idsIn(stillOpen[1]);
    if (!sameSet(claimed.sort(), expected.slice().sort())) {
      problems.push(
        `docs/map/gaps.json note says "Still open: ${claimed.join(', ')}" but the records say ` +
        `${expected.join(', ')}. A note that contradicts its own data is worse than no note.`
      );
    }
  }

  // 2 — every derived document must restate exactly the ledger's open set.
  for (const relative of DOCS) {
    const file = path.join(ROOT, relative);
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      problems.push(`${relative} is missing — the map cannot be derived from nothing.`);
      continue;
    }
    const line = text.match(/^Open gaps: (.+)$/m);
    if (!line) {
      problems.push(`${relative}: no "Open gaps: …" line. The page must restate the ledger's open set.`);
      continue;
    }
    const claimed = idsIn(line[1]);
    const missing = expected.filter((id) => !claimed.includes(id));
    const invented = claimed.filter((id) => !expected.includes(id));
    if (missing.length || invented.length) {
      problems.push(
        `${relative}: open-gap line disagrees with the ledger` +
        `${missing.length ? ` · missing: ${missing.join(', ')}` : ''}` +
        `${invented.length ? ` · claims closed-or-unknown: ${invented.join(', ')}` : ''}`
      );
    }
    // A page may not call an open gap closed in the same breath.
    const closedLine = text.match(/^Closed[^:]*: (.+)$/m);
    if (closedLine) {
      const overlap = idsIn(closedLine[1]).filter((id) => expected.includes(id));
      if (overlap.length) {
        problems.push(`${relative}: lists ${overlap.join(', ')} as closed while the ledger has them open.`);
      }
    }
  }

  if (problems.length) {
    console.error('\n✗ Gap documents disagree with docs/map/gaps.json:');
    problems.forEach((problem) => console.error(`   ✗ ${problem}`));
    console.error('\n  Fix the page, or fix the ledger if the page is right — then re-run.');
    process.exit(1);
  }

  console.log(
    `Gap documents agree with the ledger — ${expected.length} open (${expected.join(' · ')}), ` +
    `${ledger.gaps.length - expected.length} closed.`
  );
}

main();
