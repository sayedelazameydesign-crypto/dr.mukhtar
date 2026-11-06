#!/usr/bin/env node
'use strict';

/**
 * Optional live smoke test for the LLM provider (never part of unit tests).
 *
 * This file is the CLI only. The decisions live in scripts/llm-smoke-probe.js:
 *   - call the provider ONLY when LLM_SMOKE_ENABLED is exactly "true"
 *   - with the switch off, a key that happens to exist is not used
 *   - an unusable answer is classified (auth, quota, block, empty, truncated, …) instead
 *     of collapsing into "provider returned an empty answer"
 *
 * Exit codes: 0 = passed or deliberately skipped, 1 = the probe ran and failed.
 * A skip prints an Actions notice so a green check cannot be mistaken for a probe.
 *
 * Never printed: the key, request headers, the endpoint, the prompt, or a raw body.
 * GitHub masks repository secrets in logs on its own; this script adds no echo of the
 * value (an `::add-mask::<key>` line would still be a copy of the secret in the log).
 */

const { probe_ } = require('./llm-smoke-probe');

const VERDICT_ENV_NOTES = {
  disabled: 'This job proves nothing about the provider today.',
  'no-key': 'This job proves nothing about the provider today.',
  'missing-key': 'The opt-in flag demands a key and none is present.',
  'no-fetch': 'The runtime cannot fetch; nothing was sent.',
  'pii-in-probe': 'The probe prompt was rejected locally; nothing was sent.'
};

async function main() {
  const verdict = await probe_({ env: process.env, fetchImpl: globalThis.fetch });
  const inActions = process.env.GITHUB_ACTIONS === 'true';

  if (verdict.status === 'ok') {
    console.log(`Live LLM smoke passed — model "${verdict.details.model}", HTTP ${verdict.details.http_status}, ${verdict.details.text_length} chars returned.`);
    console.log(`diagnostics: ${JSON.stringify(verdict.details)}`);
    console.log('No secret value, header, endpoint, or prompt text was printed.');
    return 0;
  }

  if (verdict.status === 'disabled' || verdict.status === 'no-key') {
    // A skipped probe is not a pass: say so in the check itself, not only in the log.
    console.log(`SKIPPED live LLM smoke: ${verdict.reason}. Unit tests and the booking flow do not need it.`);
    if (inActions) {
      console.log(`::notice title=live LLM smoke NOT executed::${verdict.reason}. ${VERDICT_ENV_NOTES[verdict.status] || ''}`.trim());
    }
    return 0;
  }

  console.error(`LIVE LLM SMOKE FAILED: ${verdict.reason}`);
  console.error(`diagnostics: ${JSON.stringify(verdict.details)}`);
  console.error('No key, header, endpoint, prompt text, or response body was printed.');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    // A crash inside the probe is a failure of the smoke test, never a silent pass.
    console.error(`LIVE LLM SMOKE FAILED: the probe itself crashed (${error && error.name ? error.name : 'unknown error'}).`);
    process.exit(1);
  });
