#!/usr/bin/env node
'use strict';

// Offline tests of required/optional/unknown settings and the exact inline WAAPI probe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { compare, exitCode, listNames } = require('./setup-github.js');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'secrets-manifest.json'), 'utf8'));

const sample = {
  secrets: [
    { name: 'REQUIRED_SECRET', level: 'repo', validation: { required: true } },
    { name: 'OPTIONAL_SECRET', level: 'repo', validation: { required: false } },
    { name: 'ENV_SECRET', level: 'environment:production', validation: { required: true } }
  ],
  variables: [
    { name: 'REQUIRED_VAR', validation: { required: true } },
    { name: 'OPTIONAL_VAR', validation: { required: false } }
  ]
};
const empty = compare(sample, { secrets: [], variables: [], environments: [] });
assert.equal(exitCode(empty), 1);
assert.equal(empty.gaps.length, 3);
assert.equal(empty.optionalMissing.length, 2);
assert.ok(!empty.gaps.some((s) => s.includes('OPTIONAL')));
const complete = compare(sample, { secrets: ['REQUIRED_SECRET'], variables: ['REQUIRED_VAR'], environments: [] });
assert.equal(complete.gaps.length, 1, 'required environment remains required');
const actual = compare(manifest, { secrets: [], variables: [], environments: [] });
assert.ok(!actual.gaps.some((s) => s.includes('GEMINI_API_KEY')), 'optional real secret is not a gap');
const unknown = compare(sample, { secrets: null, variables: ['REQUIRED_VAR'], environments: ['production'] });
assert.equal(exitCode(unknown), 2);
assert.ok(unknown.unknown.some((s) => s.includes('secret names unavailable')));
assert.ok(unknown.unknown.some((s) => s.includes('ENV_SECRET@production')));
assert.ok(!unknown.gaps.some((s) => s.includes('REQUIRED_SECRET')), 'unknown is not missing');
const noEnvironmentAccess = compare(sample, { secrets: ['REQUIRED_SECRET'], variables: ['REQUIRED_VAR'], environments: null });
assert.equal(exitCode(noEnvironmentAccess), 2);
assert.ok(noEnvironmentAccess.unknown.includes('environment names unavailable'));
assert.ok(!noEnvironmentAccess.gaps.some((s) => s.includes('environment')));
const allOptional = compare({ secrets: [sample.secrets[1]], variables: [sample.variables[1]] }, { secrets: [], variables: [], environments: [] });
assert.equal(exitCode(allOptional), 0);
const missingClassification = compare({ secrets: [{ name: 'UNCLASSIFIED', level: 'repo' }], variables: [] }, { secrets: [], variables: [], environments: [] });
assert.equal(exitCode(missingClassification), 2, 'missing required metadata must not be silently treated as optional');
console.log('✓ required, optional, inaccessible, empty and manual environment checks are distinct');

(async () => {
  const calls = [];
  const list = await listNames(async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get('page');
    const data = page === '1' ? [{ name: 'FIRST' }] : [{ name: 'SECOND' }];
    return { ok: true, status: 200, json: async () => ({ total_count: 2, secrets: data }) };
  }, 'example/repo', 'fixture', '/actions/secrets', 'secrets');
  assert.deepEqual(list.names, ['FIRST', 'SECOND']);
  assert.equal(calls.length, 2);
  const denied = await listNames(async () => ({ ok: false, status: 403 }), 'example/repo', 'fixture', '/actions/secrets', 'secrets');
  assert.equal(denied.names, null);
  const malformed = await listNames(async () => ({ ok: true, status: 200, json: async () => ({ secrets: [] }) }), 'example/repo', 'fixture', '/actions/secrets', 'secrets');
  assert.equal(malformed.names, null);
  const incomplete = await listNames(async () => ({ ok: true, status: 200, json: async () => ({ total_count: 2, secrets: [] }) }), 'example/repo', 'fixture', '/actions/secrets', 'secrets');
  assert.equal(incomplete.names, null);
  console.log('✓ pagination, 403, malformed and incomplete responses never become empty verified lists');

  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/setup-status.yml'), 'utf8');
  const match = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/);
  assert.ok(match, 'read-only WAAPI probe must be present');
  const program = match[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
  const run = new Function('fetch', 'process', 'console', 'AbortSignal', `return (async () => { ${program}\n })();`);
  const fixture = 'fixture-' + 'secret-for-test';
  const sensitive = 'PRIVATE_INSTANCE_SENTINEL';
  const cases = [
    { status: 200, type: 'application/json', body: JSON.stringify({ status: 'success', instances: [{ owner: sensitive }] }), ok: true },
    { status: 200, type: 'application/json; charset=utf-8', body: '{"status":"success","instances":[]}', ok: true },
    { status: 200, type: 'text/html', body: '<html>login</html>', ok: false },
    { status: 200, type: 'application/json', body: '{not json', ok: false },
    { status: 200, type: 'application/json', body: '{"status":"error","instances":[]}', ok: false },
    { status: 200, type: 'application/json', body: '{"status":"success"}', ok: false },
    { status: 200, type: 'application/json', body: 'x'.repeat(1024 * 1024 + 1), ok: false },
    { status: 401, type: 'application/json', body: sensitive, ok: false },
    { status: 429, type: 'application/json', body: sensitive, ok: false },
    { status: 500, type: 'application/json', body: sensitive, ok: false }
  ];
  for (const c of cases) {
    const output = []; let call = null;
    const fakeProcess = { env: { WAAPI_API_TOKEN: fixture }, exitCode: 0, exit: (code) => { throw new Error('exit ' + code); } };
    await run(async (url, options) => {
      call = { url, options };
      return new Response(c.body, { status: c.status, headers: { 'Content-Type': c.type } });
    }, fakeProcess, { log: (s) => output.push(s), error: (s) => output.push(s) }, AbortSignal);
    assert.equal(call.url, 'https://waapi.app/api/v1/instances');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.Authorization, 'Bearer ' + fixture);
    assert.equal(fakeProcess.exitCode, c.ok ? 0 : 1);
    assert.ok(!output.join(' ').includes(fixture) && !output.join(' ').includes(sensitive), 'no secrets or response data in output');
  }
  const errors = [];
  const fakeProcess = { env: { WAAPI_API_TOKEN: fixture }, exitCode: 0 };
  await run(async () => { throw new Error(fixture); }, fakeProcess,
    { log: (s) => errors.push(s), error: (s) => errors.push(s) }, AbortSignal);
  assert.equal(fakeProcess.exitCode, 1);
  assert.ok(!errors.join(' ').includes(fixture), 'raw network errors are not logged');
  console.log('✓ WAAPI GET verifies JSON success and instances, rejects unsafe responses and never logs data');
  console.log('\nSetup checker and WAAPI probe tests passed.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
