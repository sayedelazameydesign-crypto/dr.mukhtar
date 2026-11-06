#!/usr/bin/env node
'use strict';

/**
 * Rotation reminders for the secrets manifest — a report, not a nag.
 *
 *   node scripts/rotation-reminders.js                  # human report (exit 0 unless due)
 *   node scripts/rotation-reminders.js --warn-days 30   # tell me a month early (default)
 *   node scripts/rotation-reminders.js --max-days 45    # grace window after the due date
 *   node scripts/rotation-reminders.js --json           # machine-readable
 *   node scripts/rotation-reminders.js --self-test      # prove the rules fire
 *
 * Why it exists: `docs/secrets.md` §6 says "every 90 days", and nothing in the repository
 * ever said whether that had happened. A policy with no clock is a sentence.
 *
 * What it deliberately does NOT do:
 *   - read, print, hash or compare a secret value (the manifest holds none);
 *   - write to GitHub (that needs a token the session does not have, and it is an owner act);
 *   - fail a normal run for a secret that is declared but has never been set
 *     (`rotated: null` plus `required: false` is an honest state, not an error).
 *
 * The exit code is the contract: 1 only when something is *overdue* (due date + grace),
 * so CI can carry it without going red the day a rotation becomes advisable.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.env.CELIA_REPO_ROOT ? path.resolve(process.env.CELIA_REPO_ROOT) : path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'docs', 'secrets-manifest.json');
const asJson = process.argv.includes('--json');
const selfTest = process.argv.includes('--self-test');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const WARN_DAYS = arg('--warn-days', 30);
const MAX_DAYS = arg('--max-days', 45);
const DAY_MS = 86400000;

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Classify one secret. Three states only, because a fourth would be decoration:
 *   never-set   declared, optional, no date recorded — informational
 *   ok / warn   within the rotation window (warn = inside WARN_DAYS of the due date)
 *   overdue     past the due date by more than the grace window
 * `unknown-date` is reported for a rotated value whose date is not a real ISO date: a
 * reminder built on an unparseable date is worse than none, so it is surfaced, not ignored.
 */
function classify(entry, now, warnDays, maxDays) {
  const rotationDays = Number(entry.rotation_days);
  const base = { name: entry.name, level: entry.level || '', rotation_days: rotationDays, rotated: entry.rotated ?? null };
  if (!(rotationDays > 0)) return Object.assign(base, { state: 'unknown-date', days_left: null, due: null });
  if (!entry.rotated) {
    return Object.assign(base, {
      state: entry.validation && entry.validation.required === false ? 'never-set' : 'never-set',
      days_left: null, due: null
    });
  }
  const rotatedAt = Date.parse(`${entry.rotated}T00:00:00Z`);
  if (!Number.isFinite(rotatedAt)) return Object.assign(base, { state: 'unknown-date', days_left: null, due: null });
  const dueAt = rotatedAt + rotationDays * DAY_MS;
  const daysLeft = Math.floor((dueAt - now) / DAY_MS);
  const state = daysLeft < -maxDays ? 'overdue' : daysLeft <= warnDays ? 'warn' : 'ok';
  return Object.assign(base, {
    state,
    days_left: daysLeft,
    due: new Date(dueAt).toISOString().slice(0, 10)
  });
}

function evaluate(manifest, now = Date.now(), warnDays = WARN_DAYS, maxDays = MAX_DAYS) {
  const secrets = Array.isArray(manifest.secrets) ? manifest.secrets : [];
  const rows = secrets.map((entry) => classify(entry, now, warnDays, maxDays));
  // A variable may carry a rotation policy too (e.g. a model pin), so it is read the same way
  // and only counted; the manifest treats secrets as the credential-bearing set.
  const variables = (Array.isArray(manifest.variables) ? manifest.variables : [])
    .filter((entry) => entry.rotation_days > 0)
    .map((entry) => classify(entry, now, warnDays, maxDays));
  const counts = rows.reduce((acc, row) => { acc[row.state] = (acc[row.state] || 0) + 1; return acc; }, {});
  return {
    checked: manifest.checked || null,
    warn_days: warnDays,
    max_days: maxDays,
    counts,
    due: rows.filter((row) => row.state === 'warn' || row.state === 'overdue'),
    rows,
    variables
  };
}

/* ------------------------------------------------------------------ self-test ---- */

if (selfTest) {
  const assert = require('node:assert/strict');
  const now = Date.parse('2026-11-05T00:00:00Z');
  const iso = (daysAgo) => new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const entry = (overrides) => Object.assign({ name: 'X', level: 'repo', rotation_days: 90, rotated: null }, overrides);
  let passed = 0;
  const ok = (label, fn) => { fn(); passed += 1; };

  ok('a fresh rotation inside the window is ok', () => {
    assert.equal(classify(entry({ rotated: iso(10) }), now, 30, 45).state, 'ok');
  });
  ok('inside the warning window is warn, not overdue', () => {
    const row = classify(entry({ rotated: iso(70) }), now, 30, 45);
    assert.equal(row.state, 'warn');
    assert.equal(row.days_left, 20);
  });
  ok('past the due date but inside the grace window is still warn', () => {
    assert.equal(classify(entry({ rotated: iso(120) }), now, 30, 45).state, 'warn');
  });
  ok('past the grace window is overdue', () => {
    const row = classify(entry({ rotated: iso(140) }), now, 30, 45);
    assert.equal(row.state, 'overdue');
    assert.ok(row.days_left < -45);
  });
  ok('a declared-but-never-set optional secret is not an error', () => {
    assert.equal(classify(entry({ validation: { required: false } }), now, 30, 45).state, 'never-set');
  });
  ok('an unparseable rotation date is surfaced, never treated as ok', () => {
    assert.equal(classify(entry({ rotated: 'last tuesday' }), now, 30, 45).state, 'unknown-date');
  });
  ok('the report runs on the real manifest and never reads a value', () => {
    const manifest = readManifest(MANIFEST);
    assert.ok(!manifest.error, `manifest unreadable: ${manifest.error}`);
    const report = evaluate(manifest, now, 30, 45);
    assert.equal(report.rows.length, manifest.secrets.length);
    const serialised = JSON.stringify(report);
    // Field-name check, not a text match: `validation.hint` legitimately contains the word
    // "value", and a substring test would fail on prose while missing a real leak.
    manifest.secrets.forEach((secret) => {
      assert.ok(!('value' in secret), `${secret.name} must not carry a value in the manifest`);
      assert.ok(!('secret_value' in secret), `${secret.name} must not carry a value in the manifest`);
    });
    assert.ok(!serialised.includes('api_key'), 'the report names secrets, it does not expose them');
  });
  console.log(`Rotation-reminder self-test passed: ${passed} checks (window, grace, never-set, unparseable date, manifest shape).`);
  process.exit(0);
}

/* --------------------------------------------------------------------- report ---- */

const manifest = readManifest(MANIFEST);
if (manifest.error) {
  console.error(`✗ docs/secrets-manifest.json is unreadable: ${manifest.error}`);
  process.exit(2);
}

const report = evaluate(manifest);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const icon = { ok: '✓', warn: '!', overdue: '✗', 'never-set': '·', 'unknown-date': '?' };
  console.log('\n— تذكير تدوير الأسرار (أسماء فقط، لا قيم) —\n');
  report.rows.forEach((row) => {
    const due = row.due ? ` · الاستحقاق ${row.due}` : '';
    const left = row.days_left === null ? '' : ` · ${row.days_left >= 0 ? `باقٍ ${row.days_left} يومًا` : `متأخر ${Math.abs(row.days_left)} يومًا`}`;
    const rotated = row.rotated ? `آخر تدوير ${row.rotated}` : 'لم يُسجَّل تدوير';
    console.log(`  ${icon[row.state] || '?'} ${row.name.padEnd(24)} ${rotated}${due}${left}`);
  });
  if (report.variables.length) {
    report.variables.forEach((row) => console.log(`  ${icon[row.state] || '?'} ${row.name.padEnd(24)} (متغيّر) ${row.rotated || 'لم يُسجَّل'}`));
  }
  console.log(`\n  داخل النافذة ${report.counts.ok || 0} · اقترب موعدها ${report.counts.warn || 0} · متأخرة ${report.counts.overdue || 0} · بلا تاريخ ${(report.counts['never-set'] || 0) + (report.counts['unknown-date'] || 0)}`);
  console.log('  القاعدة: docs/secrets.md §6 — كل ٩٠ يومًا أو عند تغيّر الموظفين أو أي شك.');
  console.log('  بعد التدوير: حدّث GitHub Secret وScript Property معًا، ثم سجّل `rotated` في docs/secrets-manifest.json.');
  console.log('  لا تُكتب أي قيمة سرّية في المستودع — هذا التقرير يقرأ الأسماء والتواريخ فقط.\n');
}

if (report.counts.overdue) {
  console.error(`✗ ${report.counts.overdue} سرًّا تجاوز موعد تدويره بأكثر من ${report.max_days} يومًا.`);
  process.exit(1);
}
process.exit(0);
