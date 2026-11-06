#!/usr/bin/env node
'use strict';

/**
 * Parse every script in scripts/ — not just the handful CI already runs.
 *
 * Why this exists: scripts/env.js (the startup environment contract) was unparsable for a
 * while because an object literal was missing a comma and nothing ever imported it. The
 * syntax gate only looked at app.js and the three Apps Script sources, so the breakage
 * shipped and was found by hand. A language-level error is the cheapest possible defect to
 * catch, and the only unacceptable outcome is catching it late.
 *
 *   node scripts/check-script-syntax.js
 *
 * Exit 1 on the first file that does not parse, listing every offender at once.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const TARGETS = ['scripts'];

const broken = [];
let checked = 0;

function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    if (!/\.js$/.test(entry.name)) return;
    checked += 1;
    // A shebang is not JavaScript, but Node accepts it on the first line — so the gate has to
    // strip it before parsing, or every executable script in this directory "fails".
    const source = fs.readFileSync(full, 'utf8').replace(/^#![^\n]*\n/, '').replace(/^\uFEFF/, '');
    try {
      // Compiling without running is the point: new Function parses the file exactly as the
      // runtime would, and never executes it.
      // eslint-disable-next-line no-new-func
      new Function(source);
    } catch (error) {
      broken.push(`${path.relative(ROOT, full)}: ${error.message}`);
    }
  });
}

TARGETS.forEach((target) => {
  const full = path.join(ROOT, target);
  if (!fs.existsSync(full)) {
    console.error(`✗ ${target}/ is missing`);
    process.exit(1);
  }
  walk(full);
});

if (!checked) {
  console.error('✗ no scripts were checked — a gate that checks nothing is not a gate');
  process.exit(1);
}
if (broken.length) {
  broken.forEach((line) => console.error(`✗ ${line}`));
  console.error(`\nSyntax gate FAILED: ${broken.length} of ${checked} script(s) do not parse.`);
  process.exit(1);
}
console.log(`Syntax gate passed: ${checked} script(s) under scripts/ parse.`);
