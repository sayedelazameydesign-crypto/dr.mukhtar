#!/usr/bin/env node
'use strict';

/**
 * Write clinic.json from two inputs, without ever inventing a value.
 *
 *   node scripts/build-clinic-profile.js --input <values.json> [--dry-run]
 *   node scripts/build-clinic-profile.js --input <values.json> --write
 *
 * `clinic.json` in the repository holds the publishable facts. A values file is any JSON
 * object with the same keys — it may come from the doctor, from a Script Properties
 * export, or from a partially filled draft. Precedence is: explicit input value first,
 * then the value already published. Whitespace is trimmed; nothing else is rewritten,
 * reordered, transliterated or "corrected".
 *
 * Refuses (exit 1) when any provided value fails the schema — publishing a phone that
 * nobody answers is a worse outcome than publishing an empty field.
 */

const fs = require('node:fs');
const path = require('node:path');
const schema = require('./clinic-schema.js');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'clinic.json');

function arg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error(`✗ ${label} (${path.relative(ROOT, file)}): ${error.message}`);
    process.exit(1);
  }
}

const inputPath = arg('--input');
const dryRun = !process.argv.includes('--write') || process.argv.includes('--dry-run');

const current = fs.existsSync(TARGET) ? readJson(TARGET, 'clinic.json is not valid JSON') : schema.emptyClinic();
const incoming = inputPath ? readJson(path.resolve(inputPath), 'input file is not valid JSON') : {};

// Only known keys travel: an input with a typo must not silently create a new published field.
const merged = Object.assign(schema.emptyClinic(), current);
schema.FIELDS.forEach((key) => {
  if (!(key in incoming)) return;
  const value = incoming[key];
  if (value === null || value === undefined) return;
  // Trim only. A licence number keeps its exact characters.
  merged[key] = String(value).trim();
});

const result = schema.validate(merged);

console.log('— clinic.json merge —');
schema.FIELDS.forEach((key) => {
  const next = String(merged[key] == null ? '' : merged[key]).trim();
  const previous = String(current[key] == null ? '' : current[key]).trim();
  const source = key in incoming && String(incoming[key] || '').trim() ? 'input' : (previous ? 'kept' : 'empty');
  const flag = next ? '•' : '·';
  console.log(`  ${flag} ${key.padEnd(11)} [${source.padEnd(5)}] ${next ? JSON.stringify(next) : '(فارغ)'}`);
});

result.warnings.forEach((warning) => console.log(`  ! ${warning}`));

if (!result.ok) {
  console.error(`\n✗ INVALID — ${Object.keys(result.errors).length} field(s) rejected; nothing was written:`);
  Object.entries(result.errors).forEach(([key, message]) => {
    console.error(`   ✗ ${schema.LABELS[key] || key}: ${message}`);
  });
  console.error('  أصلح القيم أو احذفها؛ الحقل الفارغ يبقى فارغًا على الصفحة.');
  process.exit(1);
}

if (result.missing.length) {
  console.log(`\n  · غير مكتمل بعد: ${result.missing.map((key) => schema.LABELS[key]).join(' · ')}`);
  console.log('  · هذا متوقع ما لم تصل البيانات؛ الصفحة تُظهر بديلًا محايدًا ولا تخترع قيمة.');
}

if (dryRun) {
  console.log(`\n(dry run) لم يُكتب شيء. أضف --write لكتابة ${path.relative(ROOT, TARGET)}.`);
  process.exit(0);
}

const ordered = {};
Object.keys(schema.emptyClinic()).forEach((key) => { ordered[key] = merged[key]; });
fs.writeFileSync(TARGET, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
console.log(`\n✓ كُتب ${path.relative(ROOT, TARGET)} — ${result.missing.length ? `${result.missing.length} حقلًا ما زال فارغًا` : 'كل الحقول مكتملة'}.`);
process.exit(0);
