#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the setup checker's comparison logic (no network).
 * Proves the checker reports gaps correctly and never emits values.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { compare } = require('./setup-github.js');

const manifest = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'docs', 'secrets-manifest.json'), 'utf8'));
const repoSecrets = manifest.secrets.filter((entry) => entry.level === 'repo').map((entry) => entry.name);
const envSecretEntries = manifest.secrets.filter((entry) => entry.level.startsWith('environment:'));
const allVars = manifest.variables.map((entry) => entry.name);

// 1) nothing configured yet (today's real state)
const empty = compare(manifest, { repo: 'o/r', secrets: [], variables: [], environments: [] });
assert.equal(empty.gaps.filter((gap) => gap.startsWith('variable')).length, allVars.length, 'every variable is a gap');
assert.equal(empty.gaps.filter((gap) => gap.startsWith('secret')).length, repoSecrets.length, 'every repo secret is a gap');
assert.equal(empty.gaps.filter((gap) => gap.includes('missing → gh api')).length, envSecretEntries.length, 'missing environments are reported');
console.log('✓ empty state: every declared name is reported as a gap');

// 2) variables only → repo secrets still missing
const partial = compare(manifest, { repo: 'o/r', secrets: [], variables: allVars, environments: [] });
assert.equal(partial.gaps.filter((gap) => gap.startsWith('variable')).length, 0);
assert.ok(partial.gaps.some((gap) => gap.startsWith('secret GEMINI_API_KEY')));
console.log('✓ variables-only state: secret gap still reported');

// 3) fully configured → no gaps, environment names flagged for UI confirmation only
const full = compare(manifest, { repo: 'o/r', secrets: repoSecrets, variables: allVars, environments: ['production'] });
assert.equal(full.gaps.length, 0, `unexpected gaps: ${full.gaps.join(' | ')}`);
assert.equal(full.pendingEnvSecrets.length, envSecretEntries.length);
console.log('✓ fully configured state: zero gaps (environment secrets move to "confirm in UI")');

// 4) no secret material can appear: output is names and commands only
const rendered = JSON.stringify(full) + JSON.stringify(empty);
assert.ok(!/AIza|sk-|ghp_/.test(rendered), 'no secret-shaped material in output');
console.log('✓ output contains names and copy-paste commands only');

// Exercise the exact inline Actions probe, with a fake fetch and fake credential; no network.
(async () => {
  const fs = require('node:fs');
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/setup-status.yml'), 'utf8');
  const match = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/);
  assert.ok(match, 'read-only WAAPI probe must be present');
  const program = match[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const run = new Function('fetch', 'process', 'console', 'AbortSignal', `return (async () => { ${program}\n })();`);
  const fixture = 'fixture-' + 'secret-for-test';
  for (const status of [200, 401, 429, 500]) {
    const output = []; let call = null; let cancelled = false;
    const fakeProcess = { env: { WAAPI_API_TOKEN: fixture }, exitCode: 0, exit: (code) => { throw new Error('exit ' + code); } };
    await run(async (url, options) => {
      call = { url, options };
      return { ok: status >= 200 && status < 300, status, body: { cancel: async () => { cancelled = true; } } };
    }, fakeProcess, { log: (s) => output.push(s), error: (s) => output.push(s) }, AbortSignal);
    assert.equal(call.url, 'https://waapi.app/api/v1/instances');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error', 'redirects must not forward a credential');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + fixture);
    assert.equal(fakeProcess.exitCode, status === 200 ? 0 : 1);
    assert.ok(cancelled, 'the response body is discarded');
    assert.ok(!output.join(' ').includes(fixture), 'credential is never printed');
  }
  const errors = [];
  const fakeProcess = { env: { WAAPI_API_TOKEN: fixture }, exitCode: 0 };
  await run(async () => { throw new Error(fixture); }, fakeProcess,
    { log: (s) => errors.push(s), error: (s) => errors.push(s) }, AbortSignal);
  assert.equal(fakeProcess.exitCode, 1);
  assert.ok(!errors.join(' ').includes(fixture), 'network errors are not logged raw');
  console.log('✓ WAAPI probe: GET only, redirects blocked, response discarded and failures sanitized');
  console.log('\nSetup checker tests passed: 5 cases.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
