#!/usr/bin/env node
'use strict';

// Narrow, convention-based contract checks; actionlint and a real GitHub run are
// still required to establish workflow validity and actual trigger behavior.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'tag-safety.yml'), 'utf8');
function validate(text) {
  const executable = text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.match(executable, /^on:\n  push:\n    tags: \['\*\*'\]\n  workflow_dispatch:\s*$/m, 'tag pushes and manual dispatch must remain configured');
  assert.match(executable, /^permissions:\n  contents: read\s*$/m);
  assert.equal((executable.match(/^\s*permissions:/gm) || []).length, 1, 'no job may escalate permissions');
  assert.doesNotMatch(executable, /\$\{\{\s*secrets\.|\b(?:contents|id-token|actions|pages):\s*write\b|^\s*environment:/m);
  assert.doesNotMatch(executable, /^\s*(?:ref|token):/m, 'do not replace checkout ref or provide a token');
  assert.match(executable, /^\s*persist-credentials: false\s*$/m);
  const actions = [...executable.matchAll(/^\s*- uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  assert.deepEqual(actions, [
    'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444'
  ]);
  const commands = [...executable.matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => match[1].trim());
  assert.deepEqual(commands, ['npm ci --ignore-scripts --no-audit --no-fund',
    'node scripts/test-tag-safety-workflow.js', 'npm test', 'npm run gates']);
  assert.doesNotMatch(executable, /continue-on-error:\s*true|\|\|\s*true\b/);
}
validate(workflow);
for (const [name, broken] of [
  ['missing tag trigger', workflow.replace("tags: ['**']", "branches: [main]")],
  ['write permission', workflow.replace('contents: read', 'contents: write')],
  ['secret reference', workflow + '\n    env:\n      TOKEN: ${{ secrets.SAMPLE }}\n'],
  ['persistent checkout', workflow.replace('persist-credentials: false', 'persist-credentials: true')],
  ['unpinned action', workflow.replace('actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444', 'actions/setup-node@main')],
  ['unsafe install', workflow.replace('npm ci --ignore-scripts --no-audit --no-fund', 'npm ci')],
  ['missing test', workflow.replace('run: npm test', 'run: echo tests-skipped')],
  ['missing gates', workflow.replace('run: npm run gates', 'run: echo gates-skipped')],
  ['escalated job permission', workflow.replace('    steps:', '    permissions:\n      contents: write\n    steps:')]
]) assert.throws(() => validate(broken), undefined, `${name} must be rejected`);
console.log('Tag safety workflow contract passed (static checks only; GitHub trigger unverified).');
