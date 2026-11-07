#!/usr/bin/env node
'use strict';

/**
 * Offline tests for the live provider probe (scripts/llm-smoke-probe.js).
 *
 * No network: every case injects a fake fetch. What is proven here is the decision the
 * previous version got wrong — a repository with a key and LLM_SMOKE_ENABLED=false must
 * not call the provider, and must not report a failure for not calling it.
 *
 * The negative half matters as much as the positive one: each failure shape (auth, quota,
 * blocked prompt, empty candidates, empty text, truncated, malformed, timeout, network)
 * must be reported as its own class, because "empty answer" was unactionable.
 */

const assert = require('node:assert/strict');
const path = require('node:path');

const probe = require(path.join(__dirname, 'llm-smoke-probe.js'));

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name} — ${error.message}`);
  }
}

/** Fake fetch that records calls and returns one canned response. */
function fakeFetch(plan) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: url, options: options });
    if (plan && plan.throws) {
      const error = new Error('boom');
      error.name = plan.throws;
      throw error;
    }
    return {
      status: plan.status || 200,
      json: async () => {
        if (plan.badJson) throw new Error('not json');
        return plan.body;
      }
    };
  };
  impl.calls = calls;
  return impl;
}

const answer = (text, extra) => Object.assign({
  candidates: [{ content: { parts: [{ text: text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 }
}, extra || {});

const run = (env, plan, timeoutMs) => probe.probe_({ env: env, fetchImpl: fakeFetch(plan), timeoutMs: timeoutMs }).then((verdict) => ({ verdict: verdict }));

(async () => {
  /* ------------------------------------------------ the switch — the real bug */
  {
    const fetchImpl = fakeFetch({ body: answer('ok') });
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'false', GEMINI_API_KEY: 'k' }, fetchImpl: fetchImpl });
    check('a key with LLM_SMOKE_ENABLED=false is not used (no network call)', () => {
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(verdict.status, 'disabled');
    });
  }
  {
    const fetchImpl = fakeFetch({ body: answer('ok') });
    const verdict = await probe.probe_({ env: { GEMINI_API_KEY: 'k' }, fetchImpl: fetchImpl });
    check('an unset switch is off, not on', () => {
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(verdict.status, 'disabled');
    });
  }
  {
    const fetchImpl = fakeFetch({ body: answer('ok') });
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'yes', GEMINI_API_KEY: 'k' }, fetchImpl: fetchImpl });
    check('only the literal string "true" enables the probe', () => {
      assert.equal(fetchImpl.calls.length, 0);
      assert.equal(verdict.status, 'disabled');
    });
  }
  {
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'TRUE', GEMINI_API_KEY: 'k' }, fetchImpl: fakeFetch({ body: answer('ok') }) });
    check('the switch is case-insensitive when it says true', () => assert.equal(verdict.status, 'ok'));
  }
  {
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'true' }, fetchImpl: fakeFetch({ body: answer('ok') }) });
    check('enabled without a key skips instead of failing', () => assert.equal(verdict.status, 'no-key'));
  }
  {
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'true', LLM_SMOKE_REQUIRE_KEY: 'true' }, fetchImpl: fakeFetch({ body: answer('ok') }) });
    check('the rotation guard turns a missing key into a failure', () => assert.equal(verdict.status, 'missing-key'));
  }

  /* -------------------------------------------------------------- the happy path */
  {
    const fetchImpl = fakeFetch({ body: answer('أعد الحجز من صفحة الطلب.') });
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'true', GEMINI_API_KEY: 'secret-key-value' }, fetchImpl: fetchImpl });
    check('a real answer passes and reports the model', () => {
      assert.equal(verdict.status, 'ok');
      assert.equal(verdict.details.model, 'gemini-3.5-flash-lite');
      assert.equal(verdict.details.prompt_tokens, 21);
      assert.equal(verdict.details.output_tokens, 9);
    });
    check('the request carries the key in a header, never in the URL', () => {
      assert.ok(!fetchImpl.calls[0].url.includes('secret-key-value'));
      assert.equal(fetchImpl.calls[0].options.headers['x-goog-api-key'], 'secret-key-value');
    });
    check('the verdict never contains the key or the prompt', () => {
      const serialized = JSON.stringify(verdict);
      assert.ok(!serialized.includes('secret-key-value'));
      assert.ok(!serialized.includes(probe.PROMPT));
    });
  }

  /* ------------------------------------------------------- failure classification */
  const cases = [
    { name: 'HTTP 401 is an auth failure', plan: { status: 401, body: {} }, expect: 'auth' },
    { name: 'HTTP 403 is an auth failure', plan: { status: 403, body: {} }, expect: 'auth' },
    { name: 'HTTP 429 is a quota failure', plan: { status: 429, body: {} }, expect: 'quota' },
    { name: 'HTTP 400 is a request-shape failure', plan: { status: 400, body: {} }, expect: 'bad-request' },
    { name: 'HTTP 404 is a model-name failure', plan: { status: 404, body: {} }, expect: 'model-not-found' },
    { name: 'HTTP 500 is the provider failing, not the repository', plan: { status: 503, body: {} }, expect: 'provider-error' },
    { name: 'a non-JSON body is malformed, not empty', plan: { status: 200, badJson: true }, expect: 'malformed-json' },
    { name: 'an aborted request is a timeout', plan: { throws: 'AbortError' }, expect: 'timeout' },
    { name: 'a socket error is a network failure', plan: { throws: 'TypeError' }, expect: 'network' }
  ];
  for (const testCase of cases) {
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'true', GEMINI_API_KEY: 'k' }, fetchImpl: fakeFetch(testCase.plan) });
    check(testCase.name, () => assert.equal(verdict.status, testCase.expect));
  }

  /* ------------------------------------- the shapes that used to read "empty answer" */
  const bodies = [
    {
      name: 'a prompt blocked before generation reports blockReason',
      body: { promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', blocked: true }] }, candidates: [] },
      expect: 'blocked',
      detail: (verdict) => {
        assert.equal(verdict.details.block_reason, 'SAFETY');
        assert.deepEqual(verdict.details.block_categories, ['HARM_CATEGORY_HARASSMENT']);
      }
    },
    {
      name: 'a response with no candidates is distinguished from an empty answer',
      body: { candidates: [] },
      expect: 'empty-candidates'
    },
    {
      name: 'no candidates field at all is still empty-candidates',
      body: {},
      expect: 'empty-candidates'
    },
    {
      name: 'a candidate with no parts is empty-text',
      body: { candidates: [{ content: {}, finishReason: 'STOP' }] },
      expect: 'empty-text'
    },
    {
      name: 'parts that are all whitespace are empty-text',
      body: { candidates: [{ content: { parts: [{ text: '   ' }] }, finishReason: 'STOP' }] },
      expect: 'empty-text'
    },
    {
      name: 'finishReason=SAFETY with no text is blocked, not empty',
      body: { candidates: [{ content: { parts: [] }, finishReason: 'SAFETY', safetyRatings: [{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', probability: 'HIGH', blocked: true }] }] },
      expect: 'blocked',
      detail: (verdict) => assert.deepEqual(verdict.details.safety, ['HARM_CATEGORY_DANGEROUS_CONTENT=blocked'])
    },
    {
      name: 'finishReason=MAX_TOKENS with no text is truncated',
      body: { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] },
      expect: 'truncated'
    },
    {
      name: 'finishReason=MAX_TOKENS with partial text passes but is flagged',
      body: { candidates: [{ content: { parts: [{ text: 'جزئي' }] }, finishReason: 'MAX_TOKENS' }] },
      expect: 'truncated',
      detail: (verdict) => assert.equal(verdict.details.text_length, 4)
    }
  ];
  for (const testCase of bodies) {
    const verdict = await probe.probe_({ env: { LLM_SMOKE_ENABLED: 'true', GEMINI_API_KEY: 'k' }, fetchImpl: fakeFetch({ body: testCase.body }) });
    check(testCase.name, () => {
      assert.equal(verdict.status, testCase.expect);
      if (testCase.detail) testCase.detail(verdict);
    });
  }

  /* ------------------------------------------------------------ diagnostics quality */
  check('negligible safety ratings are not printed as noise', () => {
    const kept = probe.meaningfulSafety_({
      safetyRatings: [
        { category: 'HARM_CATEGORY_HARASSMENT', probability: 'NEGLIGIBLE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'MEDIUM' }
      ]
    });
    assert.deepEqual(kept, ['HARM_CATEGORY_HATE_SPEECH=medium']);
  });
  check('every verdict carries the same diagnostic keys', () => {
    const keys = Object.keys(probe.interpretBody_({}, 200, 'm').details).sort().join(',');
    const other = Object.keys(probe.httpFailure_(429, 'm').details).sort().join(',');
    assert.equal(keys, other);
  });
  {
    const verdict = await probe.probe_({
      env: { LLM_SMOKE_ENABLED: 'true', GEMINI_API_KEY: 'k' },
      fetchImpl: fakeFetch({ body: answer('ط'.repeat(1300)) })
    });
    check('an overlong answer is reported as overlong', () => assert.equal(verdict.status, 'overlong'));
  }

  if (failures.length) {
    failures.forEach((failure) => console.error(` ✗ ${failure}`));
    console.error(`\nLLM smoke probe: ${failures.length} of ${passed + failures.length} checks failed.`);
    process.exit(1);
  }
  console.log(`LLM smoke probe passed: ${passed} checks (switch, key, classification, diagnostics).`);
})();
