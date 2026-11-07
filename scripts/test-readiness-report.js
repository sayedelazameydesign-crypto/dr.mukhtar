#!/usr/bin/env node
'use strict';

/**
 * The readiness check compares docs/production-readiness.md against a fresh run. Two honest
 * runs can differ in the measurement date or whether the machine could reach the published
 * site (the "الشبكة" row and site.up's detail cell). Before the fix, a
 * document generated with --offline failed the check on a laptop with network, and vice versa
 * — a false "stale" that teaches people to regenerate the file instead of reading it.
 *
 * This suite proves both halves of the rule, offline and hermetically:
 *   · a document whose only difference is the network wording still passes, and
 *   · every real difference — a count, a status, a gap state, the browser environment —
 *     still fails.
 *
 * Nothing here touches the committed document: the fixture is generated in a temporary
 * directory and pointed at with CELIA_READINESS_DOC.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'readiness-report.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-'));

// Pin the browser gate so this suite tests the comparison rule, not whether this machine
// happens to have jsdom: the fixture is generated under the same environment it is checked in.
const env = { ...process.env, CELIA_ALLOW_SKIP_UI: '1', NODE_PATH: '' };

const run = (doc, args) => spawnSync(process.execPath, [SCRIPT, ...args], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...env, CELIA_READINESS_DOC: doc }
});

let passed = 0;
const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
};

/** Copy a document, apply one edit, and return the new path. */
const variant = (name, edit) => {
  const file = path.join(tmp, `${name}.md`);
  const text = fs.readFileSync(base, 'utf8');
  const edited = edit(text);
  assert.notStrictEqual(edited, text, `variant ${name} did not change anything`);
  fs.writeFileSync(file, edited);
  return file;
};

// 0 — a fixture generated on this machine, offline. This is the baseline the rest mutates.
const base = path.join(tmp, 'base.md');
const written = run(base, ['--write', '--offline']);
check('the fixture document is generated', written.status === 0, written.stderr.slice(0, 300));
check('the fixture check passes as written', run(base, ['--offline']).status === 0);

// 1 — the bug: same document, network-flavoured wording only. Must pass.
const networked = variant('networked', (text) => text
  .replace(/\| الشبكة \| [^|]+ \|/, '| الشبكة | مستخدمة |')
  .replace(/^(\| site\.up [^|]*\|[^|]*\|)[^|]*\|/m, '$1 تعذر الوصول من هذه الشبكة: fetch failed |'));
const networkedRun = run(networked, ['--offline']);
check('a document that only differs by network wording is not called stale',
  networkedRun.status === 0, `${networkedRun.stdout}${networkedRun.stderr}`.slice(0, 300));

// A measurement remains historically dated; a later check must not fail just
// because the calendar day changed. Invalid dates must not be normalized away.
const earlierDate = variant('earlier-date', (text) => text.replace(/\| تاريخ القياس \| \d{4}-\d{2}-\d{2} \|/, '| تاريخ القياس | 2000-01-01 |'));
check('a different valid measurement day alone does not fail', run(earlierDate, ['--offline']).status === 0);
const invalidDate = variant('invalid-date', (text) => text.replace(/\| تاريخ القياس \| \d{4}-\d{2}-\d{2} \|/, '| تاريخ القياس | 2026-02-30 |'));
check('an invalid measurement day still fails', run(invalidDate, ['--offline']).status === 1);

// 2 — negative: a changed count still fails.
const wrongCount = variant('wrong-count', (text) => text.replace(/(\| جاهز \| \*\*)(\d+)(\*\* \|)/,
  (_, a, n, b) => `${a}${Number(n) + 1}${b}`));
check('a changed "جاهز" count still fails', run(wrongCount, ['--offline']).status === 1);

// 3 — negative: site.up's *status* is not part of the ignore rule, only its detail.
const wrongStatus = variant('wrong-status', (text) => text.replace(
  /^(\| site\.up [^|]*\|)[^|]*\|/m, '$1 ✅ **PASS** |'));
check('a changed site.up status still fails', run(wrongStatus, ['--offline']).status === 1);

// 4 — negative: the ledger's own state cannot be laundered through the ignore rule.
const wrongGap = variant('wrong-gap', (text) => text.replace(
  /^(\| G\d+ \|[^|]*\|[^|]*\| )\*\*OPEN\*\*/m, '$1**resolved**'));
check('a gap flipped OPEN → resolved still fails', run(wrongGap, ['--offline']).status === 1);

// 5 — negative: the measurement environment is a fact, not noise.
const wrongEnv = variant('wrong-env', (text) => text.replace(
  /(\| بيئة القياس \| )[^|]+( \|)/, '$1jsdom موجود (البوابة عملت) $2'));
check('a changed browser environment still fails', run(wrongEnv, ['--offline']).status === 1);

// 6 — the check must still say *why* it failed, not just exit 1.
const message = run(wrongCount, ['--offline']);
check('the failure names the document as stale', /stale/.test(message.stderr), message.stderr.slice(0, 200));

console.log(`Readiness-report suite passed: ${passed} checks (network wording ignored, real drift still fails).`);
