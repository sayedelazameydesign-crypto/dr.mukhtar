#!/usr/bin/env node
'use strict';

/**
 * Every test citation in docs/code-logic.md must exist verbatim in a test file.
 *
 *   node scripts/check-doc-evidence.js
 *
 * WHY: that page claims "this assertion proves this decision". A quoted assertion name that
 * drifted (renamed, deleted, paraphrased) turns the table into decoration — exactly the
 * failure the repository already guards against elsewhere (a gate that cannot fail is not a
 * gate). So the citation is checked mechanically instead of trusted.
 *
 * Scope is deliberate: only single-quoted spans on table rows (`| … |`) are citations. The
 * page also contains shell snippets and Arabic prose, and neither is an assertion name.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'code-logic.md');
const TEST_DIR = path.join(ROOT, 'scripts');

if (!fs.existsSync(DOC)) {
  console.error('✗ docs/code-logic.md is missing — the execution-logic page is the point of this check');
  process.exit(1);
}

const doc = fs.readFileSync(DOC, 'utf8');
// Quoted assertion names live on table rows only.
const citations = doc.split('\n')
  .filter((line) => line.trim().startsWith('|'))
  .flatMap((line) => [...line.matchAll(/'([^']{12,90})'/g)].map((match) => match[1]));

if (citations.length < 5) {
  console.error(`✗ only ${citations.length} citations found in docs/code-logic.md — the evidence column lost its quotes`);
  process.exit(1);
}

const sources = fs.readdirSync(TEST_DIR)
  .filter((file) => /\.js$/.test(file) && file !== 'check-doc-evidence.js')
  .map((file) => fs.readFileSync(path.join(TEST_DIR, file), 'utf8'))
  .join('\n');

const missing = citations.filter((quote) => !sources.includes(quote));
if (missing.length) {
  console.error(`✗ ${missing.length} of ${citations.length} cited assertions are not in any script:`);
  missing.forEach((quote) => console.error(`   · "${quote}"`));
  console.error('   Fix the page, not the test: a citation that drifted is a claim without evidence.');
  process.exit(1);
}

// A citation is only meaningful next to the file it names; make sure each row names one.
const rows = doc.split('\n').filter((line) => line.trim().startsWith('|') && line.includes("'"));
const unnamed = rows.filter((line) => !/test-[a-z-]+\.js|check-[a-z-]+\.js|google\/selftest/.test(line));
if (unnamed.length) {
  console.error(`✗ ${unnamed.length} table rows cite an assertion without naming the file it lives in`);
  unnamed.forEach((line) => console.error(`   · ${line.trim().slice(0, 90)}`));
  process.exit(1);
}

console.log(`Execution-logic citations OK — ${citations.length} quoted assertions across ${rows.length} rows all exist in scripts/.`);
