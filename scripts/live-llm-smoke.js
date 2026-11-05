#!/usr/bin/env node
'use strict';

/**
 * Optional live smoke test for the LLM provider (never part of unit tests).
 *
 * Reads configuration ONLY from the environment (never from argv or files):
 *   GEMINI_API_KEY    required to run; if absent the test skips (exit 0)
 *   LLM_MODEL         model name (non-sensitive, GitHub Variable)
 *   LLM_SMOKE_ENABLED "true" turns a missing key into a failure (rotation guard)
 *
 * Safety:
 *  - never prints the key, headers, or full URLs
 *  - rejects PII-shaped prompts before sending anything
 *  - hard timeout, single attempt, no retries (this is a probe, not the adapter)
 */

const KEY = process.env.GEMINI_API_KEY || '';

// Redaction is exact-match only, so transformed copies would leak. Nothing here
// derives a value today; this line documents the rule for future edits.
if (process.env.GITHUB_ACTIONS === 'true' && KEY) {
  console.log(`::add-mask::${KEY}`);
}
const MODEL = process.env.LLM_MODEL || 'gemini-2.5-flash';
const ENABLED = String(process.env.LLM_SMOKE_ENABLED || 'false').toLowerCase() === 'true';
const TIMEOUT_MS = 20000;
const PROMPT = 'ما هي خطوات تغيير موعد زيارة في العيادة؟ أجب في سطر واحد.';

function skip(reason) {
  console.log(`SKIPPED live LLM smoke: ${reason}. Unit tests and the booking flow do not need this.`);
  process.exit(0);
}
function fail(reason) {
  console.error(`LIVE LLM SMOKE FAILED: ${reason}`);
  process.exit(1);
}

if (!KEY) {
  if (ENABLED) fail('LLM_SMOKE_ENABLED=true but GEMINI_API_KEY is empty (rotate/restore the secret or unset the flag)');
  skip('GEMINI_API_KEY is not set');
}

// Defence in depth: the probe prompt must stay administrative.
if (/@|(?:\+?\d[\d\s().-]{7,}\d)/.test(PROMPT)) fail('probe prompt contains PII; refusing to send');

if (typeof fetch !== 'function') skip('global fetch is unavailable in this Node runtime');

const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

(async () => {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 64 }
      })
    });
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? `timed out after ${TIMEOUT_MS}ms` : 'network error';
    fail(reason);
  } finally {
    clearTimeout(timer);
  }

  const status = response.status;
  if (status === 401 || status === 403) fail(`provider rejected the credential (HTTP ${status}) — rotate GEMINI_API_KEY`);
  if (status === 429) fail(`provider quota exhausted (HTTP 429) — check the free-tier limits in AI Studio`);
  if (status < 200 || status >= 300) fail(`provider returned HTTP ${status}`);

  let body;
  try { body = await response.json(); }
  catch (error) { fail('provider returned a non-JSON body'); }

  const text = (body.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim();
  if (!text) fail('provider returned an empty answer');
  if (text.length > 1200) fail('answer exceeded the expected length; check the prompt contract');

  console.log(`Live LLM smoke passed — model "${MODEL}", HTTP ${status}, ${text.length} chars returned.`);
  console.log('No secret value, header, or prompt text was printed.');
  process.exit(0);
})();
