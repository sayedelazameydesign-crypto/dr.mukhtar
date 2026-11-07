#!/usr/bin/env node
'use strict';

/**
 * Checks the GitHub-side secrets/variables/environment state against
 * docs/secrets-manifest.json — NAMES ONLY.
 *
 *   node scripts/setup-github.js
 *
 * Requires a token with administration access (the session agent token does not
 * have it, by design). Values are never read: GitHub does not expose them and
 * this script never asks for them.
 *
 * Exit codes: 0 = everything declared is present, 1 = gaps found, 2 = cannot read.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'secrets-manifest.json'), 'utf8'));
const repo = process.env.GITHUB_REPOSITORY || manifest.repo;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// NOTE: requiring this module (for tests) must never exit the process. Token
// checks happen inside the CLI branch only — a module that calls process.exit
// on import silently kills any consumer, including test runners without a token.

const api = async (endpoint) => {
  const response = await fetch(`https://api.github.com/repos/${repo}${endpoint}`, {
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'celia-kids-setup-check'
    }
  });
  if (response.status === 403 || response.status === 404) return { status: response.status, data: null };
  if (!response.ok) throw new Error(`GET ${endpoint} → HTTP ${response.status}`);
  return { status: response.status, data: await response.json() };
};

/** Pure comparison used by the CLI and by scripts/test-setup-github.js. */
function compare(manifestData, settings) {
  const declaredSecrets = (manifestData.secrets || []).filter((entry) => entry.level === 'repo').map((entry) => entry.name);
  const declaredEnvSecrets = (manifestData.secrets || []).filter((entry) => entry.level.startsWith('environment:'));
  const declaredVars = (manifestData.variables || []).map((entry) => entry.name);

  const haveSecrets = new Set(settings.secrets || []);
  const haveVars = new Set(settings.variables || []);
  const haveEnvs = new Set(settings.environments || []);

  const gaps = [];
  declaredVars.filter((name) => !haveVars.has(name))
    .forEach((name) => gaps.push(`variable ${name} missing → gh variable set ${name} --body "<value>" --repo ${settings.repo}`));
  declaredSecrets.filter((name) => !haveSecrets.has(name))
    .forEach((name) => gaps.push(`secret ${name} missing → gh secret set ${name} --repo ${settings.repo}  (hidden prompt)`));
  // Environment secrets cannot be listed without admin access, so only a
  // *missing environment* is a reportable gap; an existing one is "confirm in UI".
  const pendingEnvSecrets = [];
  declaredEnvSecrets.forEach((entry) => {
    const env = entry.level.split(':')[1];
    if (haveEnvs.has(env)) {
      pendingEnvSecrets.push(entry.name);
    } else {
      gaps.push(`environment "${env}" missing → gh api -X PUT repos/${settings.repo}/environments/${env}  then  gh secret set ${entry.name} --env ${env} --repo ${settings.repo}`);
    }
  });
  return {
    pendingEnvSecrets,
    declared: { secrets: declaredSecrets.length, variables: declaredVars.length, environments: [...new Set(declaredEnvSecrets.map((entry) => entry.level.split(':')[1]))] },
    have: { secrets: [...haveSecrets], variables: [...haveVars], environments: [...haveEnvs] },
    gaps
  };
}

const isCli = require.main === module;

if (!isCli) {
  module.exports = { compare };
} else (async () => {
  if (!token) {
    console.error('No GH_TOKEN/GITHUB_TOKEN in the environment. Run: gh auth login (or export GH_TOKEN).');
    process.exit(2);
  }
  const declaredSecrets = (manifest.secrets || []).filter((entry) => entry.level === 'repo').map((entry) => entry.name);
  const declaredEnvSecrets = (manifest.secrets || []).filter((entry) => entry.level.startsWith('environment:'));
  const declaredVars = (manifest.variables || []).map((entry) => entry.name);

  const secrets = await api('/actions/secrets');
  const vars = await api('/actions/variables');
  const envs = await api('/environments');

  if (!secrets.data || !vars.data) {
    console.error(`Cannot read repository settings (HTTP ${secrets.status || vars.status}).`);
    console.error('This token lacks administration/actions permissions. Use the UI or a `gh auth login` token.');
    process.exit(2);
  }

  const haveSecrets = new Set((secrets.data.secrets || []).map((item) => item.name));
  const haveVars = new Set((vars.data.variables || []).map((item) => item.name));
  const haveEnvs = new Set((envs.data && envs.data.environments || []).map((item) => item.name));

  const settings = {
    repo,
    secrets: (secrets.data.secrets || []).map((item) => item.name),
    variables: (vars.data.variables || []).map((item) => item.name),
    environments: (envs.data && envs.data.environments || []).map((item) => item.name)
  };
  const result = compare(manifest, settings);
  console.log(`Repository: ${repo}`);
  console.log(`Secrets   ${haveSecrets.size ? [...haveSecrets].join(', ') : '(none)'}`);
  console.log(`Variables ${haveVars.size ? [...haveVars].join(', ') : '(none)'}`);
  console.log(`Environments ${haveEnvs.size ? [...haveEnvs].join(', ') : '(none)'}`);

  if (result.gaps.length) {
    console.log(`\n${result.gaps.length} gap(s) — values are supplied by you, never by an agent:`);
    result.gaps.forEach((gap) => console.log(` ✗ ${gap}`));
    process.exit(1);
  }

  // Environment-scoped secrets cannot be listed without admin, so report them as manual.
  console.log(`\nRepository-level names OK (${result.declared.secrets} secrets, ${result.declared.variables} variables).`);
  if (result.pendingEnvSecrets.length) {
    console.log('Environment exists; confirm these names in the UI (values are never listable):');
    result.pendingEnvSecrets.forEach((name) => console.log(` · ${name}`));
  }
  process.exit(0);
})().catch((error) => {
  console.error(`Setup check failed: ${error.message}`);
  process.exit(2);
});
