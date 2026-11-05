#!/usr/bin/env node
'use strict';

/**
 * Profile resolver for the Google bridge (`google-bridge.md` §3).
 *
 * Code resolves LOGICAL names ('memory/long', 'index_sheet') → profile layout
 * IDs. Nothing else in the repo may name an account, an email or a raw Drive id.
 *
 * Precedence: explicit --profile flag > GOOGLE_PROFILE env > "dev".
 * A missing profile file is NOT an error: the gateway then uses the local
 * fallback, which is what CI and every fresh clone run on (google-bridge.md §9).
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');
const DEFAULT_PROFILE = 'dev';
const LAYOUT_KEYS = ['memory/short', 'memory/long', 'evidence', 'inbox', 'archive', 'backups', 'index_sheet', 'sheet_id', 'calendar_id'];
const AUTH_MODES = ['oauth_user', 'apps_script_bridge', 'colab_mount', 'local'];
// Tokens for Google's own APIs. No value ever lives here: names only.
const ALLOWED_SCOPES = ['drive.file', 'drive.appdata', 'spreadsheets', 'calendar.events', 'calendar.readonly', 'tasks', 'contacts.readonly', 'gmail.send'];

function profilePath(name) {
  return path.join(CONFIG_DIR, `google.profile.${name}.json`);
}

function readProfile(name = DEFAULT_PROFILE) {
  const file = profilePath(name);
  if (!fs.existsSync(file)) {
    return { name, exists: false, file, profile: null, problems: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { name, exists: true, file, profile: null, problems: [`${path.basename(file)} is not valid JSON: ${error.message}`] };
  }
  const problems = validateProfile(parsed);
  return { name, exists: true, file, profile: parsed, problems };
}

/** Structural checks only — never reads a secret, never calls the network. */
function validateProfile(profile) {
  const problems = [];
  if (!profile || typeof profile !== 'object') return ['profile must be an object'];
  if (!profile.profile) problems.push('profile: name is required');
  if (!profile.account_label) problems.push('account_label is required (a label, never an email)');
  if (/@/.test(String(profile.account_label))) problems.push('account_label must not be an email address — keep accounts out of the repo');
  if (!AUTH_MODES.includes(profile.auth_mode)) problems.push(`auth_mode must be one of ${AUTH_MODES.join('|')}`);
  const scopes = Array.isArray(profile.scopes) ? profile.scopes : [];
  if (!scopes.length) problems.push('scopes must list at least one scope');
  scopes.filter((scope) => !ALLOWED_SCOPES.includes(scope))
    .forEach((scope) => problems.push(`scope "${scope}" is not on the allowlist (add it to ALLOWED_SCOPES with a reason first)`));
  // Short form only: a URL here would silently widen the allowlist check above.
  scopes.filter((scope) => /^https?:\/\//.test(String(scope)))
    .forEach((scope) => problems.push(`scope "${scope}" must be the short form, not a URL`));
  if (!profile.root_folder_name) problems.push('root_folder_name is required');
  if (!profile.fallback) problems.push('fallback is required (local | drive | sheets)');
  const layout = profile.layout || {};
  Object.keys(layout).filter((key) => !LAYOUT_KEYS.includes(key))
    .forEach((key) => problems.push(`layout."${key}" is not a known layout slot (${LAYOUT_KEYS.join(', ')})`));
  const fns = profile.function_map || {};
  if (!fns['memory.long']) problems.push('function_map must map at least memory.long');
  return problems;
}

/** Logical slot → id, or null when this profile has not been bootstrapped. */
function resolveSlot(profile, slot) {
  if (!LAYOUT_KEYS.includes(slot)) throw new Error(`Unknown Google bridge slot "${slot}". Known: ${LAYOUT_KEYS.join(', ')}`);
  const value = profile && profile.layout ? profile.layout[slot] : null;
  return value === undefined ? null : value;
}

/** Which adapter the app should use right now: 'google' only when bootstrapped. */
function activeAdapter(profile) {
  if (!profile) return 'local';
  if (profile.auth_mode === 'local') return 'local';
  const bootstrapped = Boolean(profile.layout && profile.layout['memory/long']);
  return bootstrapped ? 'google' : 'local';
}

function resolveProfileName(argv = process.argv.slice(2), env = process.env) {
  const index = argv.indexOf('--profile');
  if (index !== -1 && argv[index + 1]) return argv[index + 1];
  const flag = argv.find((arg) => arg.startsWith('--profile='));
  if (flag) return flag.split('=')[1];
  return env.GOOGLE_PROFILE || DEFAULT_PROFILE;
}

module.exports = {
  ROOT,
  CONFIG_DIR,
  DEFAULT_PROFILE,
  LAYOUT_KEYS,
  AUTH_MODES,
  ALLOWED_SCOPES,
  profilePath,
  readProfile,
  validateProfile,
  resolveSlot,
  activeAdapter,
  resolveProfileName
};
