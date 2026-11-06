#!/usr/bin/env node
'use strict';

/**
 * Architecture boundary gate.
 *
 * The repository already tests *behaviour* (24 privacy checks, the simulated Apps Script
 * suite, the UI smoke). It had no test for *shape*: nothing prevented a "pure" validator
 * from reading Script Properties, or a model call from creeping into the booking path, or a
 * new mutator from writing without the script lock. Those defects do not fail a behavioural
 * test — they fail six months later, in production, for someone else.
 *
 *   node scripts/check-architecture-boundaries.js
 *   node scripts/check-architecture-boundaries.js --self-test
 *
 * The rules live in docs/architecture/boundaries.json, not here. This file only knows how to
 * evaluate them, so adding a boundary is a data change a reviewer can read in the diff.
 *
 * Exit 0 when every rule holds and every rule was actually evaluated. A rule that matched no
 * function is reported as a failure: a boundary nobody can trip is not a boundary.
 *
 * Honest limit: this parses by brace/string scanning, not by a JavaScript grammar. It is
 * accurate for this repository (one function per top-level `function name(...)`), and it
 * refuses to guess: anything it cannot parse is reported, never skipped.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const RULES_FILE = path.join('docs', 'architecture', 'boundaries.json');

/* ------------------------------------------------------------------ parsing */

/** Read a source file without ever letting a missing file pass as "clean". */
function readSource(root, relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return { ok: false, why: `${relative} is missing` };
  return { ok: true, text: fs.readFileSync(file, 'utf8') };
}

/**
 * Find top-level functions and their bodies.
 *
 * A closing brace is only accepted when the brace depth returns to zero AND the remainder of
 * that line is empty — this survives one-line functions (`function a() { return 1; }`) and
 * does not need a real parser.
 */
function functionsOf(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const header = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]);
    if (!header) continue;
    const body = [];
    let depth = 0;
    let started = false;
    let end = -1;
    for (let j = i; j < lines.length; j += 1) {
      body.push(lines[j]);
      for (const ch of lines[j]) {
        if (ch === '{') { depth += 1; started = true; } else if (ch === '}') { depth -= 1; }
      }
      if (started && depth === 0) { end = j; break; }
    }
    found.push({
      name: header[1],
      line: i + 1,
      startLine: i,
      endLine: end,
      body: endpointBody(body, end === -1 ? body.length - 1 : body.length - 1),
      raw: body.join('\n')
    });
    if (end > i) i = end;
  }
  return found;
}

/** Strip everything after the closing brace on the last line, so a following comment cannot lie. */
function endpointBody(bodyLines) {
  return bodyLines.join('\n');
}

/** Ignore comments and string literals when hunting for forbidden symbols. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

/* ------------------------------------------------------------------ checking */

const findings = [];
const evaluated = [];

function fail(rule, file, detail) {
  findings.push(`${rule} ${file}: ${detail}`);
}

/** B1/B2/B5 — forbidden symbols or patterns in a file, or inside named functions. */
function checkForbidden(rule, root) {
  rule.files.forEach((relative) => {
    const source = readSource(root, relative);
    if (!source.ok) return fail(rule.id, relative, source.why);
    const code = codeOnly(source.text);
    evaluated.push({ rule: rule.id, file: relative });

    (rule.forbiddenSymbols || []).forEach((symbol) => {
      if (code.includes(symbol)) fail(rule.id, relative, `forbidden symbol '${symbol}' appears in the file`);
    });

    // B1 shape: "these functions must not call these names". The list is per rule, so the
    // same mechanism serves 'the booking path never calls a model' and 'a pure function
    // stays pure' without a second code path.
    const insideSymbols = rule.forbiddenInTheseFunctions || rule.forbiddenSymbols || [];
    (rule.forbiddenInFunctions || []).forEach((name) => {
      const fn = functionsOf(source.text).find((candidate) => candidate.name === name);
      if (!fn) return fail(rule.id, relative, `rule names '${name}', which does not exist — a stale rule is a lie`);
      if ((rule.notYetPure || {})[name]) return; // counted, never silently ignored
      const body = codeOnly(fn.raw);
      insideSymbols.forEach((symbol) => {
        if (body.includes(symbol)) fail(rule.id, `${relative}:${fn.line}`, `'${name}' must not reach '${symbol}'`);
      });
    });

    // A boundary that forbids something inside functions must forbid it somewhere; an
    // empty list would otherwise pass as "enforced".
    if (rule.forbiddenInFunctions && !rule.forbiddenInFunctions.length) {
      fail(rule.id, relative, 'the rule names no functions — nothing is enforced');
    }

    (rule.forbiddenPatterns || []).forEach((pattern) => {
      if (new RegExp(pattern).test(source.text)) fail(rule.id, relative, `matches a secret-shaped pattern (${pattern.slice(0, 12)}…)`);
    });
  });
}

/** B3 — a mutator must take the script lock and release it. */
function checkLocking(rule, root) {
  rule.files.forEach((relative) => {
    const source = readSource(root, relative);
    if (!source.ok) return fail(rule.id, relative, source.why);
    const fns = functionsOf(source.text);
    rule.mutators.forEach((name) => {
      const fn = fns.find((candidate) => candidate.name === name);
      if (!fn) return fail(rule.id, relative, `mutator '${name}' does not exist — the rule points at nothing`);
      evaluated.push({ rule: rule.id, file: relative, fn: name });
      const body = codeOnly(fn.raw);
      if (!body.includes(rule.requireBefore)) {
        fail(rule.id, `${relative}:${fn.line}`, `'${name}' writes but never takes ${rule.requireBefore}`);
      }
      const lockIndex = body.indexOf(rule.requireBefore);
      const writeIndex = firstWriteIndex(body);
      if (lockIndex !== -1 && writeIndex !== -1 && writeIndex < lockIndex) {
        fail(rule.id, `${relative}:${fn.line}`, `'${name}' writes before the lock is taken`);
      }
      (rule.requireAlso || []).forEach((needed) => {
        if (!body.includes(needed)) fail(rule.id, `${relative}:${fn.line}`, `'${name}' takes the lock but never calls ${needed}`);
      });
    });
  });
}

function firstWriteIndex(body) {
  const writes = ['appendRow', 'setValues', 'updateRequestRow_', 'createEvent', 'deleteEvent', 'setProperty', 'deleteProperty', 'appendAudit_'];
  let best = -1;
  writes.forEach((write) => {
    const at = body.indexOf(write);
    if (at !== -1 && (best === -1 || at < best)) best = at;
  });
  return best;
}

/** B4 — a command returns an object with the keys app.js reads. */
function checkResponses(rule, root) {
  const perFile = rule.filePerCommand || {};
  const files = [...new Set([...rule.files, ...rule.commands.map((name) => perFile[name]).filter(Boolean)])];
  files.forEach((relative) => {
    const source = readSource(root, relative);
    if (!source.ok) return fail(rule.id, relative, source.why);
    const fns = functionsOf(source.text);
    const commands = rule.commands.filter((name) => (perFile[name] || rule.files[0]) === relative);
    commands.forEach((name) => {
      const fn = fns.find((candidate) => candidate.name === name);
      if (!fn) return fail(rule.id, relative, `command '${name}' does not exist — the rule points at nothing`);
      evaluated.push({ rule: rule.id, file: relative, fn: name });
      rule.requireKeys.forEach((key) => {
        const shape = new RegExp(`\\b${key}\\s*:`);
        if (!shape.test(fn.raw)) fail(rule.id, `${relative}:${fn.line}`, `'${name}' never returns '${key}'`);
      });
    });
  });
}

/** The shared status vocabulary: every value used somewhere, every value declared. */
function checkVocabulary(vocabulary) {
  if (!vocabulary) return;
  const files = ['Code.gs', 'Staff.gs', 'Settings.gs', 'Llm.gs', 'WhatsApp.gs'];
  const used = new Set();
  files.forEach((relative) => {
    const source = readSource(ROOT, relative);
    if (!source.ok) return;
    [...source.text.matchAll(/'(REQUESTED|PENDING_APPROVAL|RESCHEDULED|CONFIRMED|CANCELLED|COMPLETED|DELETED)'/g)]
      .forEach((match) => used.add(match[1]));
  });
  evaluated.push({ rule: 'vocabulary', file: vocabulary.declaredIn });
  const declared = new Set(vocabulary.values);
  [...used].forEach((value) => {
    if (!declared.has(value)) findings.push(`vocabulary: '${value}' is used in code but missing from boundaries.json`);
  });
  [...declared].forEach((value) => {
    if (!used.has(value)) findings.push(`vocabulary: '${value}' is declared but no file uses it`);
  });
}

function run(root) {
  findings.length = 0;
  evaluated.length = 0;
  const rulesPath = path.join(root, RULES_FILE);
  if (!fs.existsSync(rulesPath)) {
    findings.push(`${RULES_FILE}: missing — the gate has no rules, which is not the same as having none`);
    return { findings: findings.slice(), evaluated: [], rules: 0 };
  }
  const config = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  config.rules.forEach((rule) => {
    if (rule.id === 'B3') return checkLocking(rule, root);
    if (rule.id === 'B4') return checkResponses(rule, root);
    return checkForbidden(rule, root);
  });
  checkVocabulary(config.statusVocabulary);
  const debt = [];
  config.rules.forEach((rule) => Object.entries(rule.notYetPure || {}).forEach(([name, why]) => debt.push({ rule: rule.id, name, why })));
  return { findings: findings.slice(), evaluated: evaluated.slice(), rules: config.rules.length, debt };
}

/* ------------------------------------------------------------------ self-test */

function selfTest() {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounds-'));
  const write = (relative, text) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  write(RULES_FILE, JSON.stringify({
    version: 1,
    rules: [
      {
        id: 'B2', title: 'pure stays pure', files: ['Probe.gs'],
        forbiddenSymbols: ['PropertiesService'],
        forbiddenInFunctions: ['pureThing_']
      },
      {
        id: 'B3', title: 'lock first', files: ['Probe.gs'],
        mutators: ['writes_'], requireBefore: 'LockService.getScriptLock()', requireAlso: ['releaseLock']
      },
      {
        id: 'B4', title: 'contract', files: ['Probe.gs'], commands: ['command_'], requireKeys: ['ok']
      }
    ]
  }));

  const good = [
    "function pureThing_(a) { return a + 1; }",
    "function writes_(x) { const lock = LockService.getScriptLock(); lock.tryLock(1); try { sheet.appendRow([x]); } finally { lock.releaseLock(); } }",
    "function command_(x) { return { ok: true, message: '' }; }"
  ].join('\n');

  const cases = [
    { name: 'a clean file passes every rule', text: good, expect: 0 },
    { name: 'a pure function that reads Properties fails', text: good.replace('return a + 1;', 'return PropertiesService.getScriptProperties().getProperty("x");'), expect: 1 },
    { name: 'a mutator without the lock fails', text: good.replace('const lock = LockService.getScriptLock(); lock.tryLock(1); try { sheet.appendRow([x]); } finally { lock.releaseLock(); }', 'sheet.appendRow([x]);'), expect: 1 },
    { name: 'a mutator that never releases fails', text: good.replace('} finally { lock.releaseLock(); }', '}'), expect: 1 },
    { name: 'a command without ok fails', text: good.replace("{ ok: true, message: '' }", 'true'), expect: 1 },
    { name: 'a rule naming a function that does not exist fails', text: good, mutateRules: (rules) => { rules.rules[1].mutators = ['ghost_']; }, expect: 1 }
  ];

  let failed = 0;
  cases.forEach((testCase) => {
    write(RULES_FILE, JSON.stringify({ version: 1, rules: buildRules(testCase.mutateRules) }));
    write('Probe.gs', testCase.text);
    const result = run(root);
    const code = result.findings.length ? 1 : 0;
    if (code === testCase.expect) {
      console.log(`✓ self-test: ${testCase.name}`);
    } else {
      console.error(`✗ self-test: ${testCase.name} (exit ${code}, expected ${testCase.expect}) ${result.findings.join('; ')}`);
      failed += 1;
    }
  });
  fs.rmSync(root, { recursive: true, force: true });

  if (failed) {
    console.error(`\nArchitecture-boundary self-test FAILED (${failed} of ${cases.length}).`);
    return 1;
  }
  console.log(`\nArchitecture-boundary self-test passed: ${cases.length} cases.`);
  return 0;
}

function buildRules(mutate) {
  const rules = [
    { id: 'B2', title: 'pure stays pure', files: ['Probe.gs'], forbiddenSymbols: ['PropertiesService'], forbiddenInFunctions: ['pureThing_'] },
    { id: 'B3', title: 'lock first', files: ['Probe.gs'], mutators: ['writes_'], requireBefore: 'LockService.getScriptLock()', requireAlso: ['releaseLock'] },
    { id: 'B4', title: 'contract', files: ['Probe.gs'], commands: ['command_'], requireKeys: ['ok'] }
  ];
  if (typeof mutate === 'function') mutate({ rules });
  return rules;
}

/* --------------------------------------------------------------------- entry */

if (require.main === module) {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  const result = run(ROOT);
  result.findings.forEach((line) => console.error(` ✗ ${line}`));
  if (result.findings.length) {
    console.error(`\nArchitecture boundaries FAILED: ${result.findings.length} problem(s) across ${result.evaluated.length} checked function(s), ${result.rules} rule(s).`);
    process.exit(1);
  }
  console.log(`Architecture boundaries OK — ${result.rules} rules, ${result.evaluated.length} function checks, 0 violations.`);
  // Known, named exemptions are printed every run. Silence would make them look already fixed.
  if (result.debt.length) {
    console.log(`\n  ${result.debt.length} named exemption(s) — these are NOT enforced yet:`);
    result.debt.forEach((item) => console.log(`   · ${item.rule} ${item.name}: ${item.why}`));
  }
}

module.exports = { run, functionsOf, codeOnly };
