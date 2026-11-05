#!/usr/bin/env node
'use strict';

/**
 * Idempotent layout bootstrap (google-bridge.md §4 step 8).
 *
 *   node scripts/google/bootstrap.js [--profile dev] [--dry-run]
 *
 * Creates the logical folders + index sheet inside the profile's root folder and
 * writes their ids back into config/google.profile.json (git-ignored). Running it
 * twice creates nothing twice: every step looks up by name under the same parent
 * before creating (Drive has no uniqueness constraint, so lookup-first is the
 * only safe idempotency).
 *
 * With --dry-run it prints exactly which calls it would make and writes nothing.
 */

const fs = require('node:fs');
const path = require('node:path');

const profileModule = require('./profile.js');
const ROOT = profileModule.ROOT;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

const FOLDERS = ['memory/short', 'memory/long', 'evidence', 'inbox', 'archive', 'backups'];
const SHEET_TITLE = 'index';

/** Drive accepts the same name many times, so lookup-before-create is the idempotency key. */
function folderQuery(name, parentId) {
  const safe = String(name).replace(/'/g, "\\'");
  return `name='${safe}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
}

class Bootstrapper {
  constructor({ transport, rootFolderName, dryRun = false, fetchImpl = globalThis.fetch, log = () => {} }) {
    this.transport = transport;
    this.rootFolderName = rootFolderName;
    this.dryRun = dryRun;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.actions = [];
  }

  async _call(url, options = {}) {
    if (this.dryRun) {
      this.actions.push(`${options.method || 'GET'} ${url}`);
      return { dry_run: true };
    }
    const token = await this.transport.accessToken();
    const response = await this.fetchImpl(url, { ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Drive HTTP ${response.status} — ${detail.slice(0, 200)}`);
    }
    return response.json();
  }

  async _ensureFolder(name, parentId) {
    const listing = await this._call(`${DRIVE_API}/files?q=${encodeURIComponent(folderQuery(name, parentId))}&fields=files(id,name)`);
    if (listing.dry_run) {
      this.actions.push(`would create folder "${name}" under ${parentId}`);
      return `dry-run-${name.replace(/\W+/g, '-')}`;
    }
    if (listing.files && listing.files.length) {
      this.log(`· folder "${name}" exists`);
      return listing.files[0].id;
    }
    const created = await this._call(`${DRIVE_API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    });
    this.log(`+ folder "${name}"`);
    return created.id;
  }

  async run() {
    const layout = {};
    // 1. root: a folder the app owns, so drive.file sees everything inside it.
    const rootListing = await this._call(`${DRIVE_API}/files?q=${encodeURIComponent(`name='${this.rootFolderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)`);
    let rootId;
    if (rootListing.dry_run) {
      this.actions.push(`would create root folder "${this.rootFolderName}"`);
      rootId = 'dry-run-root';
    } else if (rootListing.files && rootListing.files.length) {
      rootId = rootListing.files[0].id;
      this.log(`· root "${this.rootFolderName}" exists`);
    } else {
      const created = await this._call(`${DRIVE_API}/files?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.rootFolderName, mimeType: 'application/vnd.google-apps.folder' })
      });
      rootId = created.id;
      this.log(`+ root "${this.rootFolderName}"`);
    }

    // 2. sub-folders for each logical slot.
    for (const slot of FOLDERS) {
      layout[slot] = await this._ensureFolder(slot, rootId);
    }

    // 3. index sheet (Sheets, not a Drive file, so it needs its own lookup).
    // A spreadsheet IS a Drive file, so the same lookup-first rule applies to it.
    // (A Sheets API call cannot be searched by name; this query can.)
    const sheetQuery = encodeURIComponent(`name='${SHEET_TITLE}' and '${rootId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`);
    const sheetListing = await this._call(`${DRIVE_API}/files?q=${sheetQuery}&fields=files(id,name)`);
    if (sheetListing.dry_run) {
      this.actions.push(`would create spreadsheet "${SHEET_TITLE}" under ${rootId}`);
      layout.index_sheet = 'dry-run-sheet';
      layout.sheet_id = 'dry-run-sheet';
    } else if (sheetListing.files && sheetListing.files.length) {
      layout.index_sheet = sheetListing.files[0].id;
      layout.sheet_id = sheetListing.files[0].id;
      this.log(`· spreadsheet "${SHEET_TITLE}" exists`);
    } else {
      const created = await this._call('https://sheets.googleapis.com/v4/spreadsheets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          properties: { title: SHEET_TITLE },
          sheets: [{ properties: { title: 'index' } }]
        })
      });
      layout.index_sheet = created.spreadsheetId;
      layout.sheet_id = created.spreadsheetId;
      this.log(`+ spreadsheet "${SHEET_TITLE}"`);
    }

    return { rootFolderId: rootId, layout };
  }
}

/** Write ids back into the git-ignored profile, never into the template. */
function writeLayout(profileFile, layout, { dryRun = false } = {}) {
  const raw = fs.readFileSync(profileFile, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.layout = { ...(parsed.layout || {}), ...layout };
  parsed.bootstrapped_at = new Date().toISOString();
  if (dryRun) return parsed;
  fs.writeFileSync(profileFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return parsed;
}

async function refreshTokenTransport({ clientId, clientSecret, refreshToken, fetchImpl = globalThis.fetch }) {
  let cached = null;
  let expiresAt = 0;
  return {
    async accessToken() {
      if (cached && Date.now() < expiresAt - 60_000) return cached;
      const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
      const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.access_token) {
        const reason = payload.error || `HTTP ${response.status}`;
        const hint = payload.error === 'invalid_grant'
          ? ' — token expired or revoked: check the app is "In production", re-run scripts/google/auth.js'
          : '';
        throw new Error(`Refresh token rejected (${reason})${hint}`);
      }
      cached = payload.access_token;
      expiresAt = Date.now() + (Number(payload.expires_in || 3600) * 1000);
      return cached;
    },
    invalidate() { cached = null; expiresAt = 0; }
  };
}

module.exports = { Bootstrapper, writeLayout, refreshTokenTransport, FOLDERS, SHEET_TITLE, folderQuery };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const profileName = profileModule.resolveProfileName(argv);
  const { file, profile, problems } = profileModule.readProfile(profileName);

  (async () => {
    if (!profile) {
      console.error(`No ${path.relative(ROOT, file)}. Start with: cp config/google.profile.example.json config/google.profile.${profileName}.json`);
      process.exit(2);
    }
    if (problems.length) {
      problems.forEach((problem) => console.error(` ✗ ${problem}`));
      process.exit(2);
    }
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    const refreshToken = process.env[`GOOGLE_REFRESH_TOKEN_${profileName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] || '';
    if (!clientId || !clientSecret || !refreshToken) {
      console.error('Bootstrap needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the profile refresh token, all by name only:');
      console.error(`  GOOGLE_REFRESH_TOKEN_${profileName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`);
      console.error('Load them into this shell yourself (see docs/google-setup.md §4). An agent never supplies values.');
      process.exit(2);
    }
    const transport = await refreshTokenTransport({ clientId, clientSecret, refreshToken });
    const bootstrapper = new Bootstrapper({ transport, rootFolderName: profile.root_folder_name, dryRun, log: (line) => console.log(line) });
    const { rootFolderId, layout } = await bootstrapper.run();
    if (dryRun) {
      console.log('\nDry run — nothing was created or written. Planned calls:');
      bootstrapper.actions.forEach((action) => console.log(`  ${action}`));
      process.exit(0);
    }
    writeLayout(file, layout);
    console.log(`\nProfile "${profileName}" bootstrapped (root ${rootFolderId}).`);
    console.log(`Next: node scripts/google/selftest.js --profile ${profileName}`);
  })().catch((error) => {
    console.error(`Bootstrap failed: ${error.message}`);
    process.exit(1);
  });
}
