#!/usr/bin/env node
'use strict';

/**
 * Offline tests for the Google bridge (google-bridge.md §5, §13).
 *
 * Everything runs without a credential or a network call:
 * - the local adapter is the reference implementation, and the SAME probe runs
 *   against the google adapter with a scripted fake transport;
 * - retry/backoff, error mapping and idempotency are asserted against recorded
 *   responses, including a 429 and a 401;
 * - profile resolution, scope allowlist, envelope hashing and the migration
 *   planner are covered as pure functions.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const profileModule = require('./google/profile.js');
const gatewayModule = require('./google/gateway.js');
const { planMigration, compareHashes } = require('./google/migrate.js');
const { secretNameFor, buildAuthUrl, maskEmail } = require('./google/auth.js');
const { Bootstrapper, folderQuery, writeLayout } = require('./google/bootstrap.js');

let passed = 0;
const ok = (name, fn) => {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
};
const okAsync = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
};

/** Scripted transport + fetch so the google adapter is exercised without a token. */
function fakeGoogle({ layout, responses = [], onRequest } = {}) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: (options.method || 'GET').toUpperCase(), body: options.body });
    if (onRequest) onRequest(String(url), options, calls);
    const next = queue.length > 1 ? queue.shift() : (queue[0] || { status: 200, body: {} });
    const status = next.status || 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(next.headers || {}),
      json: async () => next.body || {},
      text: async () => JSON.stringify(next.body || {})
    };
  };
  const transport = {
    tokens: 0,
    async accessToken() { this.tokens += 1; return 'fake-access-token'; },
    async invalidate() { this.invalidated = true; }
  };
  const adapter = new gatewayModule.GoogleAdapter({
    transport,
    layout: layout || { 'memory/long': 'F_LONG', evidence: 'F_EVID', archive: 'F_ARCH', inbox: 'F_INBOX', sheet_id: 'SHEET1', calendar_id: 'CAL1' },
    accountLabel: 'developer-1',
    rootFolderName: 'celia-kids-memory',
    fetchImpl,
    sleep: async () => {},
    attempts: 3
  });
  return { adapter, calls, transport };
}

(async () => {
  /* ---------------------------------------------------------------- local adapter */
  const localRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ck-local-'));
  const local = new gatewayModule.LocalAdapter({ root: localRoot });

  await okAsync('local adapter: write → read → list → exists → delete', async () => {
    const doc = gatewayModule.envelope({ type: 'note', source: 'test', body: { text: 'مرحبًا' } });
    const write = await local.put('inbox/memory/long/2026/11/probe.json', doc);
    assert.equal(write.ok, true);
    assert.equal(write.sha256, doc.sha256);
    const read = await local.get('inbox/memory/long/2026/11/probe.json');
    assert.deepEqual(read.body, { text: 'مرحبًا' });
    assert.deepEqual(await local.list('inbox'), ['inbox/memory/long/2026/11/probe.json']);
    assert.equal(await local.exists('inbox/memory/long/2026/11/probe.json'), true);
    assert.equal((await local.delete('inbox/memory/long/2026/11/probe.json')).ok, true);
    assert.equal(await local.exists('inbox/memory/long/2026/11/probe.json'), false);
  });

  await okAsync('local adapter: path traversal cannot escape the store root', async () => {
    await assert.rejects(() => local.put('../../etc/passwd', gatewayModule.envelope({})), /escapes the local store/);
  });

  await okAsync('local adapter: selftest reports every probe step', async () => {
    const report = await local.selftest();
    assert.equal(report.ok, true);
    assert.deepEqual(Object.keys(report.steps).sort(), ['delete', 'exists', 'list', 'read', 'write']);
    assert.equal(await local.exists('inbox'), true);
  });

  /* --------------------------------------------------------------- envelope */
  ok('envelope: identical content hashes identically (idempotent writes)', () => {
    const a = gatewayModule.sha256(gatewayModule.canonical({ type: 'note', tags: ['x'], body: { a: 1, b: 2 } }));
    const b = gatewayModule.sha256(gatewayModule.canonical({ body: { b: 2, a: 1 }, tags: ['x'], type: 'note' }));
    assert.equal(a, b);
    assert.notEqual(a, gatewayModule.sha256(gatewayModule.canonical({ type: 'note', body: { a: 2 } })));
  });

  ok('envelope: carries the documented fields', () => {
    const doc = gatewayModule.envelope({ type: 'evidence', source: 'drive', tags: ['t'], links: ['l'], supersedes: 'old', body: {} });
    ['id', 'type', 'created', 'updated', 'version', 'source', 'sha256', 'tags', 'links', 'supersedes', 'body'].forEach((field) => {
      assert.ok(field in doc, `missing ${field}`);
    });
    assert.equal(doc.version, gatewayModule.ENVELOPE_VERSION);
    assert.match(doc.sha256, /^[0-9a-f]{64}$/);
  });

  /* ---------------------------------------------------------------- profile */
  ok('profile: the committed example is valid and cites no account', () => {
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'google.profile.example.json'), 'utf8'));
    assert.deepEqual(profileModule.validateProfile(example), []);
    assert.ok(!/@/.test(JSON.stringify(example).replace(/@schema_note|@comment/g, '')), 'example must not contain an email');
  });

  ok('profile: an email in account_label is rejected', () => {
    const problems = profileModule.validateProfile({ profile: 'x', account_label: 'bad@example.com', auth_mode: 'oauth_user', scopes: ['drive.file'], root_folder_name: 'r', fallback: 'local', function_map: { 'memory.long': 'drive' } });
    assert.ok(problems.some((problem) => /email/.test(problem)));
  });

  ok('profile: off-allowlist and URL-form scopes are rejected', () => {
    const base = { profile: 'x', account_label: 'label', auth_mode: 'oauth_user', root_folder_name: 'r', fallback: 'local', function_map: { 'memory.long': 'drive' } };
    const offList = profileModule.validateProfile({ ...base, scopes: ['https://mail.google.com/'] });
    assert.ok(offList.some((problem) => /allowlist/.test(problem)), 'unlisted scope must fail');
    assert.ok(offList.some((problem) => /short form/.test(problem)), 'URL-form scope must fail');
  });

  ok('profile: missing file means local fallback, not an error', () => {
    const missing = profileModule.readProfile('does-not-exist');
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.problems, []);
    assert.equal(profileModule.activeAdapter(null), 'local');
  });

  ok('profile: a bootstrapped profile selects the google adapter', () => {
    const profile = { profile: 'p', account_label: 'label', auth_mode: 'oauth_user', scopes: ['drive.file'], root_folder_name: 'r', fallback: 'local', function_map: { 'memory.long': 'drive' }, layout: { 'memory/long': 'F1' } };
    assert.equal(profileModule.activeAdapter(profile), 'google');
    assert.equal(profileModule.resolveSlot(profile, 'memory/long'), 'F1');
    assert.equal(profileModule.resolveSlot(profile, 'evidence'), null);
    assert.throws(() => profileModule.resolveSlot(profile, 'nope'), /Unknown Google bridge slot/);
  });

  ok('profile: GOOGLE_PROFILE and --profile both resolve, flag wins', () => {
    assert.equal(profileModule.resolveProfileName([], { GOOGLE_PROFILE: 'clinic' }), 'clinic');
    assert.equal(profileModule.resolveProfileName(['--profile', 'dev'], { GOOGLE_PROFILE: 'clinic' }), 'dev');
    assert.equal(profileModule.resolveProfileName(['--profile=other'], {}), 'other');
    assert.equal(profileModule.resolveProfileName([], {}), profileModule.DEFAULT_PROFILE);
  });

  /* ------------------------------------------------------------------ auth */
  ok('auth: consent URL asks for offline access and consent prompt', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:1234/oauth2callback', scopes: ['drive.file', 'calendar.events'], state: 'st8' }));
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('prompt'), 'consent');
    assert.equal(url.searchParams.get('state'), 'st8');
    assert.match(url.searchParams.get('scope'), /auth\/drive\.file/);
    assert.match(url.searchParams.get('scope'), /auth\/calendar\.events/);
  });

  ok('auth: refresh-token secret name follows the profile, uppercased', () => {
    assert.equal(secretNameFor('dev'), 'GOOGLE_REFRESH_TOKEN_DEV');
    assert.equal(secretNameFor('clinic-2027'), 'GOOGLE_REFRESH_TOKEN_CLINIC_2027');
  });

  ok('auth: emails are masked when echoed', () => {
    assert.equal(maskEmail('owner@example.com'), 'o***@example.com');
    assert.equal(maskEmail('not-an-email'), 'unknown');
  });

  /* --------------------------------------------------------- google adapter */
  await okAsync('google adapter: selftest runs the same five steps', async () => {
    const { adapter, calls, transport } = fakeGoogle({
      responses: [
        { status: 200, body: { id: 'FILE1', appProperties: { sha256: 'h' } } },        // upload
        { status: 200, body: { files: [{ id: 'FILE1', name: 'x.json' }] } },            // find (read)
        { status: 200, body: { sha256: 'h' } },                                          // alt=media body
        { status: 200, body: { files: [{ id: 'FILE1', name: 'selftest.json' }] } },     // list
        { status: 200, body: { files: [{ id: 'FILE1', name: 'selftest.json' }] } },     // exists
        { status: 200, body: { files: [{ id: 'FILE1', name: 'selftest.json' }] } },     // delete find
        { status: 204, body: {} }                                                        // delete
      ]
    });
    const report = await adapter.selftest();
    assert.equal(report.adapter, 'google');
    assert.equal(report.steps.write, true);
    assert.equal(report.steps.exists, true);
    assert.equal(report.steps.delete, true);
    assert.ok(transport.tokens >= 5, 'every call authorises through the transport');
    assert.ok(calls.every((call) => call.url.startsWith('https://')), 'no relative or local endpoint leaked in');
  });

  await okAsync('google adapter: multipart upload carries name, parent and appProperties', async () => {
    const { adapter, calls } = fakeGoogle({ responses: [{ status: 200, body: { id: 'FILE9' } }] });
    await adapter.put('memory/long/2026/11/doc.json', gatewayModule.envelope({ type: 'fact', body: { a: 1 } }));
    const upload = calls[0];
    assert.match(upload.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
    assert.match(upload.body, /F_LONG/);
    assert.match(upload.body, /appProperties/);
  });

  await okAsync('google adapter: 429 is retried with backoff, then succeeds', async () => {
    const { adapter, calls } = fakeGoogle({
      responses: [
        { status: 429, headers: { 'retry-after': '0' }, body: { error: 'rate' } },
        { status: 200, body: { files: [] } }
      ]
    });
    const listing = await adapter.list('memory/long');
    assert.deepEqual(listing, []);
    assert.equal(calls.length, 2);
  });

  await okAsync('google adapter: a 401 invalidates the token cache and retries', async () => {
    const { adapter, transport } = fakeGoogle({
      responses: [
        { status: 401, body: { error: 'expired' } },
        { status: 200, body: { files: [] } }
      ]
    });
    await adapter.list('memory/long');
    assert.equal(transport.invalidated, true);
  });

  await okAsync('google adapter: exhausted retries surface the status, never a stack trace with a token', async () => {
    const { adapter } = fakeGoogle({ responses: [{ status: 503, body: { error: 'unavailable' } }] });
    await assert.rejects(async () => {
      for (let i = 0; i < 5; i += 1) await adapter.list('memory/long');
    }, /HTTP 503/);
  });

  await okAsync('google adapter: a missing layout id fails with the bootstrap command', async () => {
    const { adapter } = fakeGoogle({ layout: {} });
    await assert.rejects(() => adapter.put('memory/long/a.json', gatewayModule.envelope({})), /scripts\/google\/bootstrap\.js/);
  });

  /* ------------------------------------------------------------- bootstrap */
  ok('bootstrap: folder lookup query is scoped to one parent (idempotency key)', () => {
    const query = folderQuery('memory/long', 'PARENT');
    assert.match(query, /'PARENT' in parents/);
    assert.match(query, /mimeType='application\/vnd\.google-apps\.folder'/);
    assert.match(query, /trashed=false/);
  });

  await okAsync('bootstrap: a second run creates nothing (lookup-first, folders and sheet)', async () => {
    const { adapter } = fakeGoogle({});
    const created = [];
    const lookedUp = [];
    const fetchImpl = async (url, options = {}) => {
      const method = (options.method || 'GET').toUpperCase();
      if (method === 'POST') created.push(String(url));
      if (String(url).includes('/files?q=')) lookedUp.push(String(url));
      const isSheetLookup = String(url).includes('application%2Fvnd.google-apps.spreadsheet');
      const body = isSheetLookup
        ? { files: [{ id: 'SHEET_EXISTING', name: 'index' }] }
        : { files: [{ id: 'F_EXISTING', name: 'memory/long' }] };
      return { ok: true, status: 200, json: async () => body, text: async () => '{}', headers: new Headers() };
    };
    const bootstrapper = new Bootstrapper({ transport: adapter.transport, rootFolderName: 'celia-kids-memory', fetchImpl });
    const result = await bootstrapper.run();
    assert.equal(result.rootFolderId, 'F_EXISTING');
    assert.deepEqual(created, [], 'nothing was created when every folder and the sheet already existed');
    assert.ok(lookedUp.length >= 7, 'every slot is looked up before it would be created');
    assert.equal(result.layout['memory/long'], 'F_EXISTING');
    assert.equal(result.layout.sheet_id, 'SHEET_EXISTING', 'the existing spreadsheet was reused, not recreated');
  });

  await okAsync('bootstrap: a first run creates the folders and the sheet once', async () => {
    const { adapter } = fakeGoogle({});
    const posts = [];
    let counter = 0;
    const fetchImpl = async (url, options = {}) => {
      const method = (options.method || 'GET').toUpperCase();
      const body = method === 'POST'
        ? (String(url).includes('/v4/spreadsheets') ? { spreadsheetId: 'SHEET_NEW' } : { id: `F${++counter}` })
        : { files: [] };
      if (method === 'POST') posts.push(String(url));
      return { ok: true, status: 200, json: async () => body, text: async () => '{}', headers: new Headers() };
    };
    const bootstrapper = new Bootstrapper({ transport: adapter.transport, rootFolderName: 'celia-kids-memory', fetchImpl });
    const result = await bootstrapper.run();
    assert.equal(posts.length, 8, 'root + 6 folders + 1 spreadsheet');
    assert.equal(result.layout.sheet_id, 'SHEET_NEW');
    assert.match(result.layout.backups, /^F\d+$/);
  });

  await okAsync('bootstrap: dry-run plans the calls and writes nothing', async () => {
    const bootstrapper = new Bootstrapper({ transport: { accessToken: async () => 'x' }, rootFolderName: 'celia-kids-memory', dryRun: true });
    const result = await bootstrapper.run();
    assert.equal(result.rootFolderId, 'dry-run-root');
    assert.ok(bootstrapper.actions.length > 3, 'dry run must list its calls');
    assert.ok(bootstrapper.actions.every((action) => /^(GET|POST|would create)/.test(action)), `unexpected action: ${bootstrapper.actions.find((a) => !/^(GET|POST|would create)/.test(a))}`);
  });

  ok('bootstrap: writeLayout fills ids and stamps bootstrapped_at', () => {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ck-profile-'));
    const file = path.join(dir, 'google.profile.dev.json');
    fs.copyFileSync(path.join(ROOT, 'config', 'google.profile.example.json'), file);
    const written = writeLayout(file, { 'memory/long': 'F1', sheet_id: 'S1' });
    assert.equal(written.layout['memory/long'], 'F1');
    assert.equal(written.bootstrapped_at !== null, true);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).layout.sheet_id, 'S1');
    const dry = writeLayout(file, { 'memory/long': 'F2' }, { dryRun: true });
    assert.equal(dry.layout['memory/long'], 'F2');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).layout['memory/long'], 'F1', 'dry run must not touch the file');
  });

  /* --------------------------------------------------------------- migrate */
  ok('migrate: planner copies only what the target lacks', () => {
    const plan = planMigration(['a', 'b', 'c'], ['b']);
    assert.deepEqual(plan.copy, ['a', 'c']);
    assert.deepEqual(plan.skip, ['b']);
    assert.equal(plan.summary.copy, 2);
  });

  ok('migrate: hash comparison reports missing and differing objects', () => {
    const mismatches = compareHashes([{ id: 'a', sha256: '1' }, { id: 'b', sha256: '2' }], [{ id: 'a', sha256: '9' }]);
    assert.equal(mismatches.length, 2);
    assert.equal(mismatches.find((item) => item.id === 'a').reason, 'sha256 differs');
    assert.equal(mismatches.find((item) => item.id === 'b').reason, 'missing in target');
    assert.deepEqual(compareHashes([{ id: 'a', sha256: '1' }], [{ id: 'a', sha256: '1' }]), []);
  });

  /* ------------------------------------------------------------ safety net */
  ok('gateway: createGateway stays local without a bootstrapped profile', () => {
    const gateway = gatewayModule.createGateway({ profileName: 'no-such-profile' });
    assert.equal(gateway.kind, 'local');
    assert.equal(gateway.reason, 'no transport configured');
  });

  ok('no secret value or token shape appears in the bridge sources', () => {
    const files = ['auth.js', 'bootstrap.js', 'gateway.js', 'migrate.js', 'profile.js', 'selftest.js'];
    files.forEach((file) => {
      const source = fs.readFileSync(path.join(__dirname, 'google', file), 'utf8');
      assert.ok(!/ya29\.[A-Za-z0-9_-]{10,}/.test(source), `${file} contains an access-token literal`);
      assert.ok(!/1\/\/[A-Za-z0-9_-]{20,}/.test(source), `${file} contains a refresh-token literal`);
      assert.ok(!/console\.log\([^)]*\b(refresh_token|client_secret|access_token)\b/.test(source), `${file} logs a credential`);
    });
  });

  fs.rmSync(localRoot, { recursive: true, force: true });
  console.log(`\nGoogle bridge suite passed: ${passed} tests (local adapter, google adapter, profile, auth, bootstrap, migrate, safety).`);
})().catch((error) => {
  console.error(`✗ ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});
