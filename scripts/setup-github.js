#!/usr/bin/env node
'use strict';

/**
 * Compare declared GitHub configuration with repository settings, NAMES ONLY.
 * An unavailable API result is unknown, never an empty list. Optional settings
 * are reported separately and never treated as required. This does not verify
 * secret values, Script Properties, branch protection or production readiness.
 * Exit: 0 = all applicable checks complete; 1 = required names missing;
 *       2 = one or more checks cannot be completed.
 */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'secrets-manifest.json'), 'utf8'));
const repo = process.env.GITHUB_REPOSITORY || manifest.repo;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

/** Read every page or report the whole category as unknown; never log response bodies. */
async function listNames(fetchImpl, repository, credential, endpoint, field) {
  const names = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${endpoint}?per_page=100&page=${page}`, {
      headers: { authorization: `token ${credential}`, accept: 'application/vnd.github+json', 'user-agent': 'celia-kids-setup-check' }
    });
    if (!response.ok) return { status: response.status, names: null };
    const data = await response.json();
    if (!data || !Array.isArray(data[field]) || !Number.isInteger(data.total_count) || data.total_count < 0 ||
        data[field].some((item) => !item || typeof item.name !== 'string')) {
      return { status: response.status, names: null };
    }
    names.push(...data[field].map((item) => item.name));
    if (names.length >= data.total_count) return { status: response.status, names };
    if (!data[field].length) return { status: response.status, names: null };
  }
  return { status: 0, names: null };
}

/** Pure comparison; null means inaccessible, while [] is a verified empty list. */
function compare(manifestData, settings) {
  const secrets = (manifestData.secrets || []).filter((entry) => entry.level === 'repo');
  const envSecrets = (manifestData.secrets || []).filter((entry) => entry.level.startsWith('environment:'));
  const variables = manifestData.variables || [];
  const required = (entry) => !!(entry.validation && entry.validation.required === true);
  const gaps = []; const optionalMissing = []; const unknown = []; const pendingEnvSecrets = [];
  [...secrets, ...envSecrets, ...variables].forEach((entry) => {
    if (!entry.validation || typeof entry.validation.required !== 'boolean') {
      unknown.push(`required/optional classification unavailable for ${entry.name}`);
    }
  });
  function compareNames(label, entries, available) {
    if (!Array.isArray(available)) {
      if (entries.length) unknown.push(`${label} names unavailable`);
      return;
    }
    const present = new Set(available);
    entries.filter((entry) => entry.validation && typeof entry.validation.required === 'boolean' && !present.has(entry.name)).forEach((entry) => {
      (required(entry) ? gaps : optionalMissing).push(`${label} ${entry.name} missing`);
    });
  }
  compareNames('secret', secrets, settings.secrets);
  compareNames('variable', variables, settings.variables);
  if (!Array.isArray(settings.environments)) {
    if (envSecrets.length) unknown.push('environment names unavailable');
  } else {
    const present = new Set(settings.environments);
    envSecrets.forEach((entry) => {
      if (!entry.validation || typeof entry.validation.required !== 'boolean') return;
      const env = entry.level.slice('environment:'.length);
      if (!present.has(env)) {
        (required(entry) ? gaps : optionalMissing).push(`environment ${env} missing for secret ${entry.name}`);
      } else {
        pendingEnvSecrets.push(`${entry.name}@${env}`);
        unknown.push(`environment secret ${entry.name}@${env} requires manual verification`);
      }
    });
  }
  return {
    gaps, optionalMissing, unknown, pendingEnvSecrets,
    declared: { secrets: secrets.length, variables: variables.length, environments: [...new Set(envSecrets.map((entry) => entry.level.slice('environment:'.length)))] }
  };
}

function exitCode(result) { return result.unknown.length ? 2 : result.gaps.length ? 1 : 0; }

if (require.main !== module) {
  module.exports = { compare, exitCode, listNames };
} else (async () => {
  if (!token) {
    console.error('Cannot check GitHub settings: no authenticated token is available. Check names in the GitHub UI.');
    process.exitCode = 2;
    return;
  }
  const results = {};
  for (const [key, endpoint, field] of [
    ['secrets', '/actions/secrets', 'secrets'],
    ['variables', '/actions/variables', 'variables'],
    ['environments', '/environments', 'environments']
  ]) {
    try { results[key] = await listNames(fetch, repo, token, endpoint, field); }
    catch (error) { results[key] = { status: 0, names: null }; }
  }
  const result = compare(manifest, {
    secrets: results.secrets.names, variables: results.variables.names, environments: results.environments.names
  });
  console.log(`Repository: ${repo}`);
  for (const key of ['secrets', 'variables', 'environments']) {
    const entry = results[key];
    console.log(`${key}: ${entry.names === null ? 'UNKNOWN' + (entry.status ? ` (HTTP ${entry.status} or unexpected response)` : ' (request failed)') : entry.names.length + ' names read'}`);
  }
  result.gaps.forEach((message) => console.log(`MISSING REQUIRED: ${message}`));
  result.optionalMissing.forEach((message) => console.log(`OPTIONAL, NOT CONFIGURED: ${message}`));
  result.unknown.forEach((message) => console.log(`NOT VERIFIED: ${message}`));
  const code = exitCode(result);
  if (code === 0) console.log('All applicable name checks completed; runtime values and branch protection were not checked.');
  if (code === 2) console.log('Settings check incomplete. Review names in the GitHub UI; no secret values are requested.');
  process.exitCode = code;
})().catch(() => {
  console.error('Setup check could not be completed. No response details were logged.');
  process.exitCode = 2;
});
