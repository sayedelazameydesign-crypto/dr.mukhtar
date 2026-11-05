#!/usr/bin/env node
'use strict';

/**
 * Dependency-free secret scan over git-tracked files.
 *
 * Runs locally and in CI (no network). A hit fails the build. This is a
 * baseline gate, not a replacement for gitleaks, which runs afterwards in CI
 * when its binary can be downloaded.
 *
 *   node scripts/scan-secrets.js                 # scan git-tracked files
 *   node scripts/scan-secrets.js --all           # include untracked, non-ignored files
 *   node scripts/scan-secrets.js gas _site       # scan built artifact directories
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const includeUntracked = process.argv.includes('--all');
const explicitPaths = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

const SKIP_EXT = new Set(['.woff2', '.woff', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.tgz']);
const SKIP_PATH = /^(gas\/|node_modules\/|\.git\/|_site\/)/;

const PATTERNS = [
  { id: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g, note: 'Google API key' },
  { id: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g, note: 'GitHub token' },
  { id: 'github-pat-fine', re: /github_pat_[A-Za-z0-9_]{22,}/g, note: 'GitHub fine-grained PAT' },
  { id: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, note: 'OpenAI-style key' },
  { id: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, note: 'Anthropic key' },
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/g, note: 'AWS access key id' },
  { id: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g, note: 'Slack token' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, note: 'private key block' },
  { id: 'google-oauth-secret', re: /GOCSPX-[A-Za-z0-9_-]{20,}/g, note: 'Google OAuth client secret' },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, note: 'JWT (possible long-lived credential)' },
  // Assignment-shaped secrets: KEY = "long random value"
  { id: 'assigned-secret', re: /\b(?:api[_-]?key|secret|password|passwd|token|admin[_-]?pin)\b\s*[:=]\s*['"`]([A-Za-z0-9+/_\-=]{16,})['"`]/gi, note: 'hardcoded credential assignment' }
];

// Values that are obviously placeholders and safe to keep in docs/templates.
const ALLOWLIST = [
  /0000000000/,
  /fake-key/, /test-admin-secret/, /^x{16,}$/i, /^\.{3,}$/, /^<.*>$/, /e\.g\./i
];

function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (error) { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Explicit targets are scanned even if they sit in a normally-skipped
      // folder (gas/); only VCS and dependency trees stay out.
      if (entry.isDirectory()) {
        const rel = path.relative(ROOT, full) + '/';
        if (!/^(\.git|node_modules)\//.test(rel)) stack.push(full);
      }
      else out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

function trackedFiles() {
  const args = includeUntracked ? ['ls-files', '--cached', '--others', '--exclude-standard'] : ['ls-files'];
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    // Not a git checkout (tarball, exported artifact, CI cache restore): walk instead.
    console.log('· no git metadata available; walking the working tree');
    return walk(ROOT).filter((relative) => !SKIP_PATH.test(relative));
  }
}

const findings = [];
let scanned = 0;

const fileList = explicitPaths.length
  ? explicitPaths.flatMap((target) => {
      const full = path.resolve(ROOT, target);
      if (!fs.existsSync(full)) { console.log(`· skipped missing path: ${target}`); return []; }
      return fs.statSync(full).isDirectory() ? walk(full) : [path.relative(ROOT, full)];
    })
  : trackedFiles();

for (const relative of fileList) {
  // Explicit targets bypass the generated-folder skip so artifacts get read;
  // VCS metadata and dependencies are still excluded.
  const skipPath = explicitPaths.length ? /^(\.git|node_modules)\//.test(relative) : SKIP_PATH.test(relative);
  if (skipPath || SKIP_EXT.has(path.extname(relative).toLowerCase())) continue;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, relative), 'utf8'); }
  catch (error) { continue; }
  if (text.length > 2_000_000) continue;
  scanned += 1;

  text.split('\n').forEach((line, index) => {
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line)) !== null) {
        const value = match[1] || match[0];
        if (ALLOWLIST.some((allow) => allow.test(value))) continue;
        findings.push({ file: relative, line: index + 1, id: pattern.id, note: pattern.note, sample: `${value.slice(0, 6)}…` });
      }
    }
  });
}

if (findings.length) {
  console.error(`Secret scan FAILED — ${findings.length} potential secret(s):`);
  findings.forEach((f) => console.error(` ✗ ${f.file}:${f.line} — ${f.note} (${f.id}, ${f.sample})`));
  console.error('\nRotate the credential first, then remove it from history. Never commit real keys.');
  process.exit(1);
}

const scope = explicitPaths.length ? explicitPaths.join(', ') : 'tracked files';
console.log(`Secret scan passed — ${scanned} text files (${scope}), ${PATTERNS.length} rules, 0 findings.`);
