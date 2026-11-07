#!/usr/bin/env node
'use strict';
// Exercises the exact inline workflow probe with fake responses, never network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'setup-status.yml'), 'utf8');
function checkOptIn(text) {
  assert.match(text, /check_test_contact:\s*\n\s+description: [^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/, 'contact check must default off');
  assert.match(text, /waapi-test-contact:\s*\n\s+name:.*\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.check_test_contact == true/, 'contact check requires explicit opt-in');
}
checkOptIn(workflow);
assert.throws(() => checkOptIn(workflow.replace('default: false', 'default: true')));
assert.throws(() => checkOptIn(workflow.replace("github.event_name == 'workflow_dispatch' && inputs.check_test_contact == true", "github.event_name == 'workflow_dispatch'")));
const match = workflow.match(/node --input-type=commonjs <<'STATUS_CHECK'\n([\s\S]*?)\n\s+STATUS_CHECK/);
assert.ok(match, 'inline contact status probe must exist');
const program = match[1].split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
const run = new Function('fetch', 'process', 'console', 'AbortSignal', 'require', `return ${program}`);
const prefix = 'https://waapi.app/api/v1/instances';
const secret = 'fixture-' + 'secret-sentinel';
const phone = '01100000000';
const id = '777';
const list = { status: 'success', instances: [{ id: 777, owner: 'fixture-private-owner' }] };
const me = { status: 'success', me: { status: 'success', instanceId: id, data: { formattedNumber: '+20 11 0000 0000', private: 'fixture-private-contact' } } };
const status = { status: 'success', clientStatus: { status: 'success', instanceId: id, instanceStatus: 'ready', instanceWebhook: 'fixture-private-webhook' } };
async function check(name, overrides, expected, expectedCode, expectedStage) {
  const calls = []; const output = [];
  const data = { [prefix]: list, [`${prefix}/${id}/client/me`]: me, [`${prefix}/${id}/client/status`]: status, ...overrides };
  const fakeProcess = { env: { WAAPI_API_TOKEN: secret }, exitCode: 0 };
  const fakeRequire = (module) => { assert.equal(module, 'node:fs'); return { readFileSync: () => JSON.stringify({ developerPhone: phone }) }; };
  await run(async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    assert.ok(url === prefix || /^https:\/\/waapi\.app\/api\/v1\/instances\/777\/client\/(?:me|status)$/.test(url));
    const body = data[url];
    if (body === 'THROW') throw new Error('fixture-private-error ' + secret);
    if (body === 'HTTP_ERROR') return new Response('fixture-private-error', { status: 429, headers: { 'content-type': 'application/json' } });
    if (body === 'HTML') return new Response('<html>fixture-private</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (body === 'TOO_LARGE') return new Response('x'.repeat(1048577), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }, fakeProcess, { log: (s) => output.push(s), error: (s) => output.push(s) }, AbortSignal, fakeRequire);
  if (expected === 'UNKNOWN') {
    assert.equal(output.length, 1, name);
    assert.match(output[0], /^::error title=Test contact status::UNKNOWN \((?:CONFIG|INSTANCE_LIST_READ|INSTANCE_LIST_SHAPE|INSTANCE_NONE|INSTANCE_MULTIPLE|INSTANCE_ID|CLIENT_INFO_READ|CLIENT_INFO_SHAPE|CONTACT_MISMATCH|CLIENT_STATUS_READ|CLIENT_STATUS_SHAPE)\)$/, name);
    if (expectedStage) assert.equal(output[0], `::error title=Test contact status::UNKNOWN (${expectedStage})`, name);
  } else assert.deepEqual(output, [`::notice title=Test contact status::${expected}`], name);
  assert.equal(fakeProcess.exitCode, expectedCode, name);
  assert.ok(!output.join('').includes(secret) && !output.join('').includes(phone) && !output.join('').includes('fixture-private') && !output.join('').includes(id));
  return calls;
}
(async () => {
  assert.equal((await check('matching ready', {}, 'CONNECTED', 0)).length, 3);
  await check('matching disconnected', { [`${prefix}/${id}/client/status`]: { ...status, clientStatus: { ...status.clientStatus, instanceStatus: 'disconnected' } } }, 'NOT_READY', 0);
  await check('another contact', { [`${prefix}/${id}/client/me`]: { ...me, me: { ...me.me, data: { formattedNumber: '+20 10 0000 0000' } } } }, 'UNKNOWN', 1);
  await check('multiple instances', { [prefix]: { status: 'success', instances: [{ id: 777 }, { id: 888 }] } }, 'UNKNOWN', 1, 'INSTANCE_MULTIPLE');
  await check('missing instances', { [prefix]: { status: 'success', instances: [] } }, 'UNKNOWN', 1, 'INSTANCE_NONE');
  await check('invalid instance', { [prefix]: { status: 'success', instances: [{ id: '../other' }] } }, 'UNKNOWN', 1);
  await check('mismatched identity', { [`${prefix}/${id}/client/me`]: { ...me, me: { ...me.me, instanceId: '888' } } }, 'UNKNOWN', 1);
  await check('provider status error', { [`${prefix}/${id}/client/status`]: { ...status, clientStatus: { ...status.clientStatus, status: 'error' } } }, 'UNKNOWN', 1);
  await check('unknown provider status', { [`${prefix}/${id}/client/status`]: { ...status, clientStatus: { ...status.clientStatus, instanceStatus: 'surprise' } } }, 'UNKNOWN', 1);
  await check('rate limited', { [`${prefix}/${id}/client/me`]: 'HTTP_ERROR' }, 'UNKNOWN', 1);
  await check('network exception', { [prefix]: 'THROW' }, 'UNKNOWN', 1);
  await check('wrong content type', { [prefix]: 'HTML' }, 'UNKNOWN', 1);
  await check('oversized response', { [prefix]: 'TOO_LARGE' }, 'UNKNOWN', 1);
  console.log('WAAPI test-contact read-only probe passed (mock responses only).');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
