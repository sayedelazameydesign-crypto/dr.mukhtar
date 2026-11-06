#!/usr/bin/env node
'use strict';

/**
 * The live provider probe, as a library with no side effects.
 *
 * `scripts/live-llm-smoke.js` is the thin CLI around this file; the tests import it
 * directly, which is why every branch below can be exercised offline with a fake fetch.
 *
 * Two decisions live here, and nothing else decides them:
 *   1. SHOULD WE CALL? — only when LLM_SMOKE_ENABLED is exactly "true". A key that exists
 *      is not consent: CI used to call Gemini whenever the secret was present, even with
 *      the switch at false, and reported the result as a failure.
 *   2. WHAT DID THE ANSWER MEAN? — "empty answer" was the whole diagnosis; it now resolves
 *      to auth / quota / model / block / empty-candidates / empty-text / truncated /
 *      malformed / timeout / network, each with the structural facts that produced it.
 *
 * What this file will never do: print the key, the endpoint, request headers, the prompt,
 * or the raw response body. Everything it reports is an enum, a count, or a reason string
 * written here.
 */

const PROMPT = 'ما هي خطوات تغيير موعد زيارة في العيادة؟ أجب في سطر واحد.';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MODEL = 'gemini-2.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Structural, secret-free facts about a response. */
function details_(fields) {
  const source = fields || {};
  const pick = (value) => (value === undefined ? null : value);
  return {
    http_status: pick(source.httpStatus),
    model: source.model || null,
    candidates: pick(source.candidates),
    block_reason: source.blockReason || null,
    block_categories: Array.isArray(source.blockCategories) ? source.blockCategories : [],
    finish_reason: source.finishReason || null,
    safety: Array.isArray(source.safety) ? source.safety : [],
    prompt_tokens: pick(source.promptTokens),
    output_tokens: pick(source.outputTokens),
    total_tokens: pick(source.totalTokens),
    text_length: pick(source.textLength)
  };
}

function verdict_(status, reason, fields) {
  return { status: status, reason: reason, details: details_(fields) };
}

/** Keep only ratings that carry information (drop UNSPECIFIED / NEGLIGIBLE noise). */
function meaningfulSafety_(candidate) {
  const ratings = (candidate && candidate.safetyRatings) || [];
  return ratings
    .filter((rating) => rating && rating.category)
    .filter((rating) => !/PROBABILITY_UNSPECIFIED$|^NEGLIGIBLE$/.test(String(rating.probability || '')))
    .map((rating) => `${rating.category}=${rating.blocked ? 'blocked' : String(rating.probability || 'unknown').toLowerCase()}`);
}

/** Gemini 2.x reports usage under usageMetadata; older bodies used tokenCount. */
function usage_(body) {
  const usage = (body && body.usageMetadata) || {};
  return {
    promptTokens: usage.promptTokenCount,
    outputTokens: usage.candidatesTokenCount,
    totalTokens: usage.totalTokenCount
  };
}

/**
 * The single interpretation step for an HTTP 2xx response.
 * Pure and total: every documented shape produces a verdict, never a throw.
 */
function interpretBody_(body, httpStatus, model) {
  const usage = usage_(body);
  const shared = {
    httpStatus: httpStatus,
    model: model,
    candidates: Array.isArray(body && body.candidates) ? body.candidates.length : 0,
    blockReason: body && body.promptFeedback && body.promptFeedback.blockReason,
    blockCategories: body && body.promptFeedback && Array.isArray(body.promptFeedback.safetyRatings)
      ? body.promptFeedback.safetyRatings.filter((rating) => rating && rating.blocked).map((rating) => String(rating.category || 'unknown'))
      : [],
    promptTokens: usage.promptTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens
  };

  if (shared.blockReason) {
    return verdict_('blocked', `the provider refused the request before generation (blockReason=${shared.blockReason})`, shared);
  }
  if (!shared.candidates) {
    return verdict_('empty-candidates', 'the response carried no candidates (nothing was generated)', shared);
  }

  const candidate = body.candidates[0];
  shared.finishReason = candidate && candidate.finishReason;
  shared.safety = meaningfulSafety_(candidate);

  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const text = parts.map((part) => (part && part.text) || '').join('').trim();
  shared.textLength = text.length;

  if (!text) {
    if (shared.finishReason === 'SAFETY') {
      return verdict_('blocked', 'the answer was withheld by a safety filter (finishReason=SAFETY)', shared);
    }
    if (shared.finishReason === 'MAX_TOKENS') {
      return verdict_('truncated', 'the answer stopped at the token limit before emitting text (finishReason=MAX_TOKENS)', shared);
    }
    return verdict_('empty-text', `the candidate carried no text parts (finishReason=${shared.finishReason || 'none'})`, shared);
  }
  if (shared.finishReason === 'MAX_TOKENS') {
    return Object.assign(verdict_('truncated', `the answer stopped at the token limit (${text.length} chars, finishReason=MAX_TOKENS)`, shared), { text: text });
  }
  return Object.assign(verdict_('ok', 'an answer was returned', shared), { text: text });
}

/** Map a thrown fetch (abort or socket error) to the same verdict shape. */
function transportFailure_(error, timeoutMs, model) {
  const aborted = error && error.name === 'AbortError';
  return verdict_(aborted ? 'timeout' : 'network',
    aborted ? `no response within ${timeoutMs}ms` : 'the request failed before a response arrived',
    { model: model });
}

/** Non-2xx statuses, each with the operator action it implies. */
function httpFailure_(status, model) {
  const base = { httpStatus: status, model: model };
  if (status === 400) return verdict_('bad-request', 'the provider rejected the request shape (HTTP 400) — check the model name and payload', base);
  if (status === 401 || status === 403) return verdict_('auth', `the provider rejected the credential (HTTP ${status}) — rotate GEMINI_API_KEY`, base);
  if (status === 404) return verdict_('model-not-found', 'the model name is not available to this key (HTTP 404) — check LLM_MODEL', base);
  if (status === 429) return verdict_('quota', 'provider quota exhausted (HTTP 429) — check the free-tier limits in AI Studio', base);
  if (status >= 500) return verdict_('provider-error', `the provider failed on its side (HTTP ${status}) — retry; not a defect in this repository`, base);
  return verdict_('http', `the provider returned HTTP ${status}`, base);
}

/**
 * Decide whether to probe at all. Pure: takes the environment as an argument.
 * @returns {{run:boolean, verdict?:object, model:string}}
 */
function decide_(env) {
  const read = (name) => (env && env[name] !== undefined && env[name] !== null ? String(env[name]) : '');
  const model = read('LLM_MODEL') || DEFAULT_MODEL;
  const enabled = read('LLM_SMOKE_ENABLED').toLowerCase() === 'true';
  const requireKey = read('LLM_SMOKE_REQUIRE_KEY').toLowerCase() === 'true';
  const key = read('GEMINI_API_KEY');

  if (!enabled) {
    return { run: false, model: model, verdict: verdict_('disabled', 'LLM_SMOKE_ENABLED is not "true" (opt-in switch)', { model: model }) };
  }
  if (!key) {
    if (requireKey) {
      return { run: false, model: model, verdict: verdict_('missing-key', 'LLM_SMOKE_REQUIRE_KEY=true but GEMINI_API_KEY is empty (rotate/restore the secret or unset the flag)', { model: model }) };
    }
    return { run: false, model: model, verdict: verdict_('no-key', 'GEMINI_API_KEY is not set', { model: model }) };
  }
  if (/@|(?:\+?\d[\d\s().-]{7,}\d)/.test(PROMPT)) {
    return { run: false, model: model, verdict: verdict_('pii-in-probe', 'the probe prompt contains PII-shaped text; refusing to send', { model: model }) };
  }
  return { run: true, model: model, key: key };
}

/**
 * Perform the probe. `fetchImpl` is injected so tests never touch the network.
 * Resolves to a verdict; the caller decides the exit code.
 */
async function probe_({ env, fetchImpl, timeoutMs } = {}) {
  const decision = decide_(env);
  if (!decision.run) return decision.verdict;
  const limit = timeoutMs || DEFAULT_TIMEOUT_MS;
  if (typeof fetchImpl !== 'function') return verdict_('no-fetch', 'global fetch is unavailable in this Node runtime', { model: decision.model });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  let response;
  try {
    response = await fetchImpl(`${ENDPOINT}/${encodeURIComponent(decision.model)}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': decision.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 64 }
      })
    });
  } catch (error) {
    return transportFailure_(error, limit, decision.model);
  } finally {
    clearTimeout(timer);
  }

  if (!(response.status >= 200 && response.status < 300)) return httpFailure_(response.status, decision.model);

  let body;
  try {
    body = await response.json();
  } catch (error) {
    return verdict_('malformed-json', 'the provider returned a body that is not JSON', { httpStatus: response.status, model: decision.model });
  }

  const interpreted = interpretBody_(body, response.status, decision.model);
  if (interpreted.status === 'ok' && interpreted.text.length > 1200) {
    return verdict_('overlong', 'the answer exceeded the expected length; check the prompt contract', Object.assign({}, interpreted.details, { textLength: interpreted.text.length }));
  }
  return interpreted;
}

module.exports = {
  PROMPT,
  ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  decide_,
  interpretBody_,
  httpFailure_,
  transportFailure_,
  meaningfulSafety_,
  probe_
};
