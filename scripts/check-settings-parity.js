#!/usr/bin/env node
/**
 * The settings screen exists twice: once in Settings.gs (live) and once in app.js
 * (demo mirror). They are kept in step by hand, so they drift — and they did:
 *
 *  - the demo still promised «أنواع الزيارات» while the live screen had already
 *    become «أنواع الزيارات وأسعارها», and
 *  - the live profile forgot to ship `services` at all, so a service the doctor
 *    added reached the backend maths and never the page.
 *
 * This check reads both catalogs and fails when their keys or labels differ, or when
 * the settings screen stops echoing a price back for editing.
 */
const fs = require('fs');
const path = require('path');

const root = process.env.CELIA_REPO_ROOT || path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const failures = [];
const fail = (message) => failures.push(message);

function sliceBetween(source, start, end, label) {
  const from = source.indexOf(start);
  if (from === -1) throw new Error(`${label}: marker not found (${start})`);
  const to = source.indexOf(end, from);
  if (to === -1) throw new Error(`${label}: end marker not found (${end})`);
  return source.slice(from, to);
}

function fieldsOf(block) {
  // Field objects are flat: { key: 'X', label: '…', type: '…' }. Pull them in order so a
  // mismatch points at the field that drifted, not merely at "counts differ".
  const keys = [...block.matchAll(/key:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  const labels = [...block.matchAll(/label:\s*'([^']*)'/g)].map((m) => m[1]);
  return { keys, labels };
}

const backend = fieldsOf(sliceBetween(read('Settings.gs'), 'const CK_SETTINGS_CATALOG', '/** Fields the catalog exposes', 'Settings.gs'));
const demo = fieldsOf(sliceBetween(read('app.js'), 'const DEMO_CATALOG', 'const SETTINGS_DEFAULTS', 'app.js'));

if (!backend.keys.length) fail('Settings.gs — the settings catalog has no fields');
if (!demo.keys.length) fail('app.js — the demo catalog has no fields');

const onlyBackend = backend.keys.filter((key) => !demo.keys.includes(key));
const onlyDemo = demo.keys.filter((key) => !backend.keys.includes(key));
if (onlyBackend.length) fail(`app.js — the demo is missing settings the live screen has: ${onlyBackend.join(', ')}`);
if (onlyDemo.length) fail(`app.js — the demo offers settings that do not exist live: ${onlyDemo.join(', ')}`);

backend.keys.forEach((key, index) => {
  const demoIndex = demo.keys.indexOf(key);
  if (demoIndex === -1) return;
  const live = backend.labels[index];
  const mirrored = demo.labels[demoIndex];
  if (live !== mirrored) {
    fail(`app.js — "${key}" is labelled "${mirrored}" in the demo but "${live}" live`);
  }
});

// The price is part of the service line; if a screen stops echoing it, the doctor is
// offered an edit box that silently drops the fee.
const backendSource = read('Settings.gs');
if (!/item\.price \? ' = ' \+ item\.price/.test(backendSource)) {
  fail('Settings.gs — the settings screen no longer echoes a service price back for editing');
}
const appSource = read('app.js');
if (!/item\.price \? ` = \$\{item\.price\}`/.test(appSource)) {
  fail('app.js — the demo settings screen no longer echoes a service price back for editing');
}

// The public profile must ship the visit types. Without them the page shows the built-in
// defaults and every service the doctor added becomes invisible to parents.
const codeSource = read('Code.gs');
const profile = sliceBetween(codeSource, 'function getClinicProfile()', 'function getConfig_()', 'Code.gs');
if (!/services:\s*clinicServices_\(\)/.test(profile)) {
  fail('Code.gs — getClinicProfile does not return `services`, so configured visit types never reach the page');
}

if (failures.length) {
  console.error(`Settings parity FAILED (${failures.length}):`);
  failures.forEach((message) => console.error(` ✗ ${message}`));
  process.exit(1);
}
console.log(`Settings parity OK — ${backend.keys.length} fields match between Settings.gs and app.js, prices round-trip, and the public profile ships services.`);
