#!/usr/bin/env node
'use strict';

/**
 * Startup environment contract (fail fast, names only, values never printed).
 *
 * The set of names is kept in sync with docs/secrets-manifest.json by
 * scripts/check-workflows.js — adding a secret there without adding it here
 * (or vice versa) fails CI.
 */

const ENV_SPECS = [
  { name: 'GEMINI_API_KEY', secret: true, required: false, pattern: null, hint: 'optional: administrative assistant only' },
  { name: 'GROQ_API_KEY', secret: true, required: false, pattern: null, hint: 'optional: reserved for the fallback provider' },
  { name: 'CELIA_ADMIN_PIN', secret: true, required: false, pattern: /^.{16,}$/, hint: 'optional locally; required for deployment (16+ chars)' },
  { name: 'APP_ENV', secret: false, required: false, pattern: /^(ci|preview|production)$/, hint: 'ci | preview | production' },
  { name: 'NODE_VERSION', secret: false, required: false, pattern: /^\d+(\.\d+){0,2}$/, hint: 'e.g. 20' },
  { name: 'LLM_PRIMARY', secret: false, required: false, pattern: /^[a-z][a-z0-9_]*$/, hint: 'provider id from Llm.gs' },
  { name: 'LLM_SMOKE_ENABLED', secret: false, required: false, pattern: /^(true|false)$/i, hint: 'true | false' },
  { name: 'PYTHON_VERSION', secret: false, required: false, pattern: /^3\.\d+$/, hint: 'e.g. 3.11' }
];

class EnvValidationError extends Error {
  constructor(names) {
    super(`Missing or invalid environment variables (names only): ${names.join(', ')}`);
    this.name = 'EnvValidationError';
    this.names = names;
  }
}

/** Returns { ok, problems: [{name, reason}] } — never includes values. */
function validateEnv(env = process.env) {
  const problems = [];
  for (const spec of ENV_SPECS) {
    const raw = env[spec.name];
    const present = raw !== undefined && String(raw).trim() !== '';
    if (!present) {
      if (spec.required) problems.push({ name: spec.name, reason: 'required but empty' });
      continue;
    }
    if (spec.pattern && !spec.pattern.test(String(raw).trim())) {
      problems.push({ name: spec.name, reason: `invalid format (${spec.hint || 'see docs/secrets.md'})` });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Throws EnvValidationError listing names only. */
function assertEnv(env = process.env) {
  const { ok, problems } = validateEnv(env);
  if (!ok) throw new EnvValidationError(problems.map((problem) => problem.name));
  return true;
}

/** Safe status summary: presence + validity, never values. */
function envStatus(env = process.env) {
  return ENV_SPECS.map((spec) => ({
    name: spec.name,
    secret: spec.secret,
    present: env[spec.name] !== undefined && String(env[spec.name]).trim() !== ''
  }));
}

module.exports = { ENV_SPECS, EnvValidationError, validateEnv, assertEnv, envStatus };

if (require.main === module) {
  const { ok, problems } = validateEnv();
  const status = envStatus();
  status.forEach((item) => console.log(`${item.present ? '·' : '○'} ${item.name}${item.secret ? ' (secret)' : ''}: ${item.present ? 'present' : 'absent'}`));
  if (!ok) {
    problems.forEach((problem) => console.error(` ✗ ${problem.name}: ${problem.reason}`));
    console.error('Values were not read into any log. Set the names above via .env or GitHub Secrets.');
    process.exit(1);
  }
  console.log('Environment contract OK — no values printed.');
}
