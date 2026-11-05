#!/usr/bin/env node
'use strict';

/**
 * Offline tests for the LLM adapter boundary (Llm.gs) and config validation.
 * No network: UrlFetchApp is simulated. Providers are never called for real.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

process.env.TZ = 'Africa/Cairo';
const ROOT = path.resolve(__dirname, '..');

const properties = new Map([
  ['ADMIN_PIN', 'test-admin-secret-0123456789abcdef'],
  ['TIMEZONE', 'Africa/Cairo'],
  ['WORK_START', '09:00'],
  ['WORK_END', '14:00'],
  ['SLOT_MINUTES', '30'],
  ['WORK_DAYS', '0,1,2,3,4'],
  ['GEMINI_API_KEY', 'fake-key'],
  ['GEMINI_MODEL', 'gemini-test-model'],
  ['LLM_RETRIES', '2'],
  ['LLM_BACKOFF_BASE_MS', '100'],
  ['LLM_BACKOFF_MAX_MS', '200'],
  ['LLM_DAILY_LIMIT', '3'],
  ['LLM_HOURLY_LIMIT', '50'],
  ['LLM_CIRCUIT_FAILS', '2'],
  ['LLM_COOLDOWN_S', '60'],
  ['LLM_CACHE_TTL_SEC', '600']
]);

const cache = new Map();
const requests = [];
const sleeps = [];
let fetchPlan = []; // queue of { status, body } | { throw: true }
let alwaysStatus = null; // when set, every call returns this status

const context = {
  console: { log() {}, info() {}, warn() {}, error() {} },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
      setProperty: (key, value) => { properties.set(key, String(value)); return this; },
      setProperties: (values) => { Object.entries(values).forEach(([k, v]) => properties.set(k, String(v))); },
      deleteProperty: (key) => properties.delete(key),
      getProperties: () => Object.fromEntries(properties)
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (key) => (cache.has(key) ? cache.get(key) : null),
      put: (key, value) => { cache.set(key, value); }
    })
  },
  LockService: {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  },
  Utilities: {
    sleep: (ms) => sleeps.push(ms),
    formatDate: () => '2026-11-04',
    computeDigest: (algo, value) => {
      // Deterministic 32-byte stand-in; the test only needs uniqueness/stability.
      const out = new Array(32).fill(0);
      for (let i = 0; i < value.length; i += 1) out[i % 32] = (out[i % 32] + value.charCodeAt(i) * (i + 1)) % 256;
      return out;
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' }
  },
  UrlFetchApp: {
    fetch: (url, options) => {
      requests.push({ url, options });
      const fallback = alwaysStatus
        ? { status: alwaysStatus, body: {} }
        : { status: 200, body: { candidates: [{ content: { parts: [{ text: 'إجابة إدارية تجريبية.' }] } }] } };
      const step = fetchPlan.shift() || fallback;
      if (step.throw) throw new Error('simulated network failure');
      return {
        getResponseCode: () => step.status,
        getHeaders: () => step.headers || {},
        getContentText: () => JSON.stringify(step.body || {})
      };
    }
  },
  Session: { getScriptTimeZone: () => 'Africa/Cairo' },
  SpreadsheetApp: { openById: () => { throw new Error('not used in this suite'); }, getActiveSpreadsheet: () => null },
  CalendarApp: { getDefaultCalendar: () => null, getCalendarById: () => null },
  HtmlService: {}
};

vm.createContext(context);
for (const file of ['Llm.gs', 'Code.gs']) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(source, context, { filename: file });
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (error) {
    results.push(['FAIL', `${name} — ${error.message}`]);
  }
}
function reset({ plan = [], status = null, clearBudget = true } = {}) {
  requests.length = 0;
  sleeps.length = 0;
  fetchPlan = plan;
  alwaysStatus = status;
  cache.clear();
  if (clearBudget) {
    ['gemini'].forEach((id) => {
      properties.delete(`LLM_BUDGET_COUNT_${id}`);
      properties.delete(`LLM_BUDGET_DAY_${id}`);
      properties.delete(`LLM_FAILS_${id}`);
      properties.delete(`LLM_OPEN_UNTIL_${id}`);
    });
  }
}

test('answers through the adapter without exposing the provider to the domain', () => {
  reset();
  const out = context.askGeneralQuestion('كيف أغيّر الموعد؟');
  assert.equal(out.ok, true);
  assert.equal(out.answer, 'إجابة إدارية تجريبية.');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /gemini-test-model/);
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'fake-key');
});

test('retries 429 with backoff then succeeds', () => {
  reset({ plan: [{ status: 429, body: {} }, { status: 200, body: { candidates: [{ content: { parts: [{ text: 'بعد إعادة المحاولة' }] } }] } }] });
  const out = context.llmAnswer_('سؤال إداري');
  assert.equal(out.ok, true);
  assert.equal(out.attempts, 2);
  assert.equal(requests.length, 2);
  assert.ok(sleeps.length >= 1, 'backoff sleep must happen between attempts');
});

test('always trusts Retry-After header when provided', () => {
  reset({ plan: [{ status: 429, headers: { 'retry-after': '1' }, body: {} }, { status: 200, body: { candidates: [{ content: { parts: [{ text: 'ok' }] } }] } }] });
  assert.equal(context.llmAnswer_('سؤال آخر').ok, true);
  assert.ok(sleeps.includes(1000), `expected a 1000ms Retry-After sleep, got ${sleeps.join(',')}`);
});

test('does not retry permanent auth errors', () => {
  reset({ plan: [{ status: 401, body: { error: 'unauthorized' } }, { status: 200, body: {} }] });
  const out = context.llmAnswer_('سؤال');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PROVIDER_HTTP');
  assert.equal(requests.length, 1, '401 must not be retried');
});

test('opens the circuit after repeated failures and skips the provider', () => {
  reset({ status: 500 }); // every attempt fails
  const first = context.llmAnswer_('س1');
  assert.equal(first.ok, false);
  // The second call is what trips the breaker (threshold = 2 recorded failures).
  const second = context.llmAnswer_('س2');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'PROVIDER_HTTP');
  const callsBefore = requests.length;
  const third = context.llmAnswer_('س3');
  assert.equal(third.ok, false);
  assert.equal(third.code, 'CIRCUIT_OPEN');
  assert.equal(requests.length, callsBefore, 'open circuit must not call the provider');
});

test('enforces the daily budget and fails closed', () => {
  reset();
  assert.equal(context.llmAnswer_('س1').ok, true);
  assert.equal(context.llmAnswer_('س2').ok, true);
  assert.equal(context.llmAnswer_('س3').ok, true);
  const blocked = context.llmAnswer_('س4');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'BUDGET');
});

test('serves identical prompts from cache without a second provider call', () => {
  reset();
  const first = context.llmAnswer_('كيف أحجز؟');
  const second = context.llmAnswer_('كيف أحجز؟');
  assert.equal(first.ok, true);
  assert.equal(second.cached, true);
  assert.equal(requests.length, 1);
});

test('blocks PII before it can reach a free-tier provider', () => {
  reset();
  const out = context.askGeneralQuestion('اتصلوا بي على 01012345678');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'PII_BLOCKED');
  assert.equal(requests.length, 0, 'no provider call may happen for PII');
});

test('does not misread the booking word «الموعد» as a medical complaint', () => {
  reset();
  const out = context.askGeneralQuestion('كيف أغيّر الموعد؟');
  assert.equal(out.ok, true);
  assert.equal(out.code, undefined);
  assert.equal(requests.length, 1, 'booking questions must reach the assistant');
});

test('refuses medical questions without calling the model', () => {
  reset();
  const out = context.askGeneralQuestion('طفلي عنده حرارة عالية، إيه الدوا؟');
  assert.equal(out.ok, true);
  assert.match(out.answer, /لا أقدم إرشادات طبية/);
  assert.equal(requests.length, 0);
});

test('sanitises untrusted model output', () => {
  reset({ plan: [{ status: 200, body: { candidates: [{ content: { parts: [{ text: '<script>alert(1)</script>  إجابة\n نظيفة  ' }] } }] } }] });
  const out = context.llmAnswer_('سؤال');
  assert.equal(out.ok, true);
  assert.ok(!out.answer.includes('<'), 'markup must be stripped');
  assert.equal(out.answer, 'alert(1) إجابة نظيفة');
});

test('disabled provider degrades gracefully', () => {
  reset();
  properties.delete('GEMINI_API_KEY');
  const out = context.askGeneralQuestion('سؤال إداري');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'DISABLED');
  assert.match(out.message, /يمكنكم متابعة الحجز/);
  properties.set('GEMINI_API_KEY', 'fake-key');
});

test('config validation rejects bad values instead of silently normalising', () => {
  const good = context.getConfig_();
  assert.equal(good.start, '09:00');
  properties.set('WORK_START', '9am');
  assert.throws(() => context.getConfig_(), /WORK_START/);
  properties.set('WORK_START', '09:00');
  properties.set('WORK_END', '08:00');
  assert.throws(() => context.getConfig_(), /يسبق/);
  properties.set('WORK_END', '14:00');
  properties.set('WORK_DAYS', '0,1,9');
  assert.throws(() => context.getConfig_(), /WORK_DAYS/);
  properties.set('WORK_DAYS', '0,1,2,3,4');
  assert.doesNotThrow(() => context.getConfig_());
});

test('validateConfig reports the weak demo PIN as blocking', () => {
  properties.set('ADMIN_PIN', '2468');
  const report = context.validateConfig();
  const pin = report.checks.find((check) => check.id === 'admin_pin');
  assert.equal(pin.ok, false);
  assert.equal(report.ok, false);
  properties.set('ADMIN_PIN', 'test-admin-secret-0123456789abcdef');
});

test('llmStatus exposes limits but never the key', () => {
  const status = context.llmStatus();
  const json = JSON.stringify(status);
  assert.equal(status.enabled, true);
  assert.ok(!json.includes('fake-key'), 'API key must never be surfaced');
  assert.equal(status.dailyLimit, 3);
});

const failed = results.filter(([state]) => state === 'FAIL');
results.forEach(([state, name]) => console.log(`${state === 'PASS' ? '✓' : '✗'} ${name}`));
if (failed.length) {
  console.error(`\n${failed.length} adapter test(s) failed.`);
  process.exit(1);
}
console.log(`\nLLM adapter suite passed: ${results.length} tests (retry, backoff, circuit, budget, cache, PII screen, output sanitising, config validation).`);
