#!/usr/bin/env node
'use strict';

/**
 * Unit tests for the setup checker's comparison logic (no network).
 * Proves the checker reports gaps correctly and never emits values.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { compare } = require('./setup-github.js');

const manifest = JSON.parse(require('node:fs').readFileSync(path.join(__dirname, '..', 'docs', 'secrets-manifest.json'), 'utf8'));
const repoSecrets = manifest.secrets.filter((entry) => entry.level === 'repo').map((entry) => entry.name);
const envSecretEntries = manifest.secrets.filter((entry) => entry.level.startsWith('environment:'));
const allVars = manifest.variables.map((entry) => entry.name);

// 1) nothing configured yet (today's real state)
const empty = compare(manifest, { repo: 'o/r', secrets: [], variables: [], environments: [] });
assert.equal(empty.gaps.filter((gap) => gap.startsWith('variable')).length, allVars.length, 'every variable is a gap');
assert.equal(empty.gaps.filter((gap) => gap.startsWith('secret')).length, repoSecrets.length, 'every repo secret is a gap');
assert.equal(empty.gaps.filter((gap) => gap.includes('missing → gh api')).length, envSecretEntries.length, 'missing environments are reported');
console.log('✓ empty state: every declared name is reported as a gap');

// 2) variables only → repo secrets still missing
const partial = compare(manifest, { repo: 'o/r', secrets: [], variables: allVars, environments: [] });
assert.equal(partial.gaps.filter((gap) => gap.startsWith('variable')).length, 0);
assert.ok(partial.gaps.some((gap) => gap.startsWith('secret GEMINI_API_KEY')));
console.log('✓ variables-only state: secret gap still reported');

// 3) fully configured → no gaps, environment names flagged for UI confirmation only
const full = compare(manifest, { repo: 'o/r', secrets: repoSecrets, variables: allVars, environments: ['production'] });
assert.equal(full.gaps.length, 0, `unexpected gaps: ${full.gaps.join(' | ')}`);
assert.equal(full.pendingEnvSecrets.length, envSecretEntries.length);
console.log('✓ fully configured state: zero gaps (environment secrets move to "confirm in UI")');

// 4) no secret material can appear: output is names and commands only
const rendered = JSON.stringify(full) + JSON.stringify(empty);
assert.ok(!/AIza|sk-|ghp_/.test(rendered), 'no secret-shaped material in output');
console.log('✓ output contains names and copy-paste commands only');

console.log('\nSetup checker tests passed: 4 cases.');
