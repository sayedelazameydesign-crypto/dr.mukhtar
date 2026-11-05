#!/usr/bin/env node
'use strict';

/**
 * GoogleGateway — the one place that talks to Google (google-bridge.md §5).
 *
 * Interface (same shape for every adapter):
 *   storage : put(path, obj, meta) | get(path) | list(prefix) | exists(path) | move(a, b) | delete(path)
 *   table   : append(table, row) | read(table)
 *   calendar: addEvent(event) | listEvents(range)
 *   health  : whoami() | quota() | selftest()
 *
 * Adapters: `local` (default, zero credentials, what CI runs) and `google`
 * (OAuth refresh token → Drive/Sheets/Calendar REST). Callers never branch on
 * the adapter: they call the gateway. Swapping the account = changing the
 * profile's token, not the code (google-bridge.md §8).
 *
 * This module does not read secrets. The google adapter receives them through
 * its constructor, and they never appear in returned objects or logs.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');

const ENVELOPE_VERSION = 1;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON so an identical body always hashes identically (idempotent writes). */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function envelope({ id = null, type = 'note', source = '', tags = [], links = [], supersedes = null, body = {} }) {
  const now = new Date().toISOString();
  const hash = sha256(canonical({ type, source, tags, body }));
  return {
    id: id || `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    type,
    created: now,
    updated: now,
    version: ENVELOPE_VERSION,
    source,
    sha256: hash,
    tags,
    links,
    supersedes,
    body
  };
}

/* ------------------------------------------------------------------ local */

class LocalAdapter {
  constructor({ root }) {
    this.kind = 'local';
    this.root = root;
  }

  _resolve(key) {
    const clean = String(key).replace(/^\/+/, '');
    const target = path.resolve(this.root, clean);
    if (!target.startsWith(path.resolve(this.root))) throw new Error(`Path escapes the local store: ${key}`);
    return target;
  }

  async put(key, obj) {
    const target = this._resolve(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    return { ok: true, key, sha256: obj && obj.sha256 ? obj.sha256 : sha256(canonical(obj)) };
  }

  async get(key) {
    const target = this._resolve(key);
    if (!fs.existsSync(target)) return null;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  }

  async list(prefix = '') {
    const base = this._resolve(prefix);
    if (!fs.existsSync(base)) return [];
    const start = fs.statSync(base).isDirectory() ? base : path.dirname(base);
    const out = [];
    const walk = (dir) => {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) out.push(path.relative(this.root, full));
      });
    };
    walk(start);
    return out.sort();
  }

  async exists(key) {
    return fs.existsSync(this._resolve(key));
  }

  async move(from, to) {
    const source = this._resolve(from);
    const target = this._resolve(to);
    if (!fs.existsSync(source)) return { ok: false, reason: 'source missing' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return { ok: true, from, to };
  }

  async delete(key) {
    const target = this._resolve(key);
    if (!fs.existsSync(target)) return { ok: false, reason: 'missing' };
    fs.rmSync(target, { recursive: true, force: true });
    return { ok: true, key };
  }

  async append(table, row) {
    const file = this._resolve(`index/${table}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${canonical(row)}\n`, 'utf8');
    return { ok: true, table, appended: true };
  }

  async read(table) {
    const file = this._resolve(`index/${table}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  async addEvent(event) {
    const file = this._resolve('index/events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${canonical(event)}\n`, 'utf8');
    return { ok: true, event };
  }

  async listEvents(range = {}) {
    const all = await this.read('events');
    const from = range.from ? Date.parse(range.from) : -Infinity;
    const to = range.to ? Date.parse(range.to) : Infinity;
    return all.filter((item) => {
      const at = Date.parse(item.start || item.day || '');
      return Number.isNaN(at) ? true : at >= from && at <= to;
    });
  }

  async whoami() {
    return { adapter: 'local', account_label: 'filesystem', root: path.relative(ROOT, this.root) || '.', quota: null };
  }

  async quota() {
    return { used_bytes: null, limit_bytes: null, percent: null, note: 'local store has no Drive quota' };
  }

  async selftest() {
    const key = `inbox/selftest-${Date.now()}.json`;
    const doc = envelope({ type: 'note', source: 'selftest', body: { probe: true } });
    const steps = {};
    steps.write = await this.put(key, doc);
    steps.read = (await this.get(key))?.sha256 === doc.sha256;
    steps.list = (await this.list('inbox')).includes(key);
    steps.exists = await this.exists(key);
    steps.delete = (await this.delete(key)).ok;
    return { ok: Object.values(steps).every(Boolean), steps, adapter: 'local' };
  }
}

/* ----------------------------------------------------------------- google */

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * Google adapter. `fetchImpl` and `sleep` are injectable so the whole thing can
 * be exercised offline with a scripted fake — that is how tests cover retry,
 * backoff and error mapping without a token.
 */
class GoogleAdapter {
  constructor({ transport, layout, accountLabel = 'system', rootFolderName = 'celia-kids-memory', fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 4 }) {
    this.kind = 'google';
    this.transport = transport; // { accessToken() } — abstracts refresh-token vs bridge token
    this.layout = layout || {};
    this.accountLabel = accountLabel;
    this.rootFolderName = rootFolderName;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.attempts = attempts;
  }

  async _authorized(url, options = {}) {
    const token = await this.transport.accessToken();
    if (!token) throw new Error('Google transport returned no access token (invalid_grant → re-run the auth flow).');
    return this.fetchImpl(url, {
      ...options,
      headers: { ...(options.headers || {}), authorization: `Bearer ${token}` }
    });
  }

  /** 401 → one refresh and retry; 403/429/5xx → exponential backoff with jitter. */
  async _request(url, options = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const response = await this._authorized(url, options);
      if (response.ok) return response;
      const status = response.status;
      // 401 = the cached access token expired: invalidate it and retry once
      // through the transport (which will refresh). 403/429/5xx = backoff.
      const retryable = status === 401 || status === 403 || status === 429 || status >= 500;
      if (status === 401 && this.transport.invalidate) await this.transport.invalidate();
      if (!retryable || attempt === this.attempts) {
        const detail = await response.text().catch(() => '');
        lastError = new Error(`Google API HTTP ${status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`);
        lastError.status = status;
        throw lastError;
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 300 * 2 ** (attempt - 1)) + Math.random() * 250;
      await this.sleep(backoff);
    }
    throw lastError || new Error('Google API request failed');
  }

  async _json(url, options) {
    const response = await this._request(url, options);
    return response.json();
  }

  _folderId(slot) {
    const id = this.layout[slot];
    if (!id) throw new Error(`Profile has no "${slot}" id. Run: node scripts/google/bootstrap.js`);
    return id;
  }

  async put(key, obj) {
    const folderId = this._folderId(key.startsWith('evidence/') ? 'evidence' : 'memory/long');
    const name = path.basename(key);
    const body = JSON.stringify(obj, null, 2);
    const metadata = {
      name,
      parents: [folderId],
      appProperties: { type: String(obj.type || 'note'), sha256: String(obj.sha256 || sha256(canonical(obj))), version: String(ENVELOPE_VERSION) }
    };
    const boundary = `celia-${crypto.randomBytes(8).toString('hex')}`;
    const payload = [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', body, `--${boundary}--`, ''
    ].join('\r\n');
    const created = await this._json(`${UPLOAD_API}/files?uploadType=multipart&fields=id,name,appProperties`, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body: payload
    });
    return { ok: true, key, id: created.id, sha256: metadata.appProperties.sha256 };
  }

  async _find(key) {
    const name = path.basename(key).replace(/'/g, "\\'");
    const listing = await this._json(`${DRIVE_API}/files?q=name='${name}' and trashed=false&fields=files(id,name,appProperties,parents)`, {});
    return listing.files && listing.files[0] ? listing.files[0] : null;
  }

  async get(key) {
    const file = await this._find(key);
    if (!file) return null;
    const response = await this._request(`${DRIVE_API}/files/${file.id}?alt=media`);
    return response.json();
  }

  async list(prefix = '') {
    const folder = prefix.includes('/') ? prefix.split('/')[0] : null;
    const parent = folder && this.layout[folder] ? this.layout[folder] : this._folderId('memory/long');
    const listing = await this._json(`${DRIVE_API}/files?q='${parent}' in parents and trashed=false&fields=files(id,name,appProperties)&pageSize=1000`, {});
    return (listing.files || []).map((file) => `${folder || 'memory/long'}/${file.name}`);
  }

  async exists(key) {
    return Boolean(await this._find(key));
  }

  async move(from, to) {
    const file = await this._find(from);
    if (!file) return { ok: false, reason: 'source missing' };
    const targetParent = to.startsWith('archive/') ? this._folderId('archive') : this._folderId('memory/long');
    const previousParents = (file.parents || []).join(',');
    await this._request(`${DRIVE_API}/files/${file.id}?addParents=${targetParent}&removeParents=${previousParents}`, { method: 'PATCH' });
    return { ok: true, from, to };
  }

  async delete(key) {
    const file = await this._find(key);
    if (!file) return { ok: false, reason: 'missing' };
    await this._request(`${DRIVE_API}/files/${file.id}`, { method: 'DELETE' });
    return { ok: true, key };
  }

  async append(table, row) {
    const sheetId = this.layout.sheet_id;
    if (!sheetId) throw new Error('Profile has no sheet_id. Run: node scripts/google/bootstrap.js');
    const values = Object.values(row).map((value) => (typeof value === 'object' ? JSON.stringify(value) : String(value)));
    await this._json(`${SHEETS_API}/${sheetId}/values/${encodeURIComponent(`${table}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [values] })
    });
    return { ok: true, table, appended: true };
  }

  async read(table) {
    const sheetId = this.layout.sheet_id;
    if (!sheetId) throw new Error('Profile has no sheet_id. Run: node scripts/google/bootstrap.js');
    const data = await this._json(`${SHEETS_API}/${sheetId}/values/${encodeURIComponent(table)}`, {});
    return data.values || [];
  }

  async addEvent(event) {
    if (!this.layout.calendar_id) throw new Error('Profile has no calendar_id. Run: node scripts/google/bootstrap.js');
    const created = await this._json(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.layout.calendar_id)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event)
    });
    return { ok: true, id: created.id };
  }

  async listEvents(range = {}) {
    if (!this.layout.calendar_id) throw new Error('Profile has no calendar_id. Run: node scripts/google/bootstrap.js');
    const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
    if (range.from) params.set('timeMin', range.from);
    if (range.to) params.set('timeMax', range.to);
    const data = await this._json(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.layout.calendar_id)}/events?${params}`, {});
    return data.items || [];
  }

  async whoami() {
    const about = await this._json(`${DRIVE_API}/about?fields=user(displayName),storageQuota`, {});
    return {
      adapter: 'google',
      account_label: this.accountLabel,
      root_folder_name: this.rootFolderName,
      display_name: about.user ? about.user.displayName : 'unknown',
      quota: about.storageQuota || null
    };
  }

  async quota() {
    const about = await this._json(`${DRIVE_API}/about?fields=storageQuota`, {});
    const quota = about.storageQuota || {};
    const limit = Number(quota.limit || 0);
    const usage = Number(quota.usage || 0);
    return {
      used_bytes: usage || null,
      limit_bytes: limit || null,
      percent: limit ? Math.round((usage / limit) * 100) : null,
      note: limit ? 'Drive quota is shared with Gmail and Photos' : 'no limit reported (Workspace account or unlimited plan)'
    };
  }

  async selftest() {
    const key = `inbox/selftest-${Date.now()}.json`;
    const doc = envelope({ type: 'note', source: 'selftest', body: { probe: true, adapter: 'google' } });
    const steps = {};
    const written = await this.put(key, doc);
    steps.write = Boolean(written.ok);
    steps.read = (await this.get(key))?.sha256 === doc.sha256;
    steps.list = (await this.list('inbox')).some((item) => item.endsWith(path.basename(key)));
    steps.exists = await this.exists(key);
    steps.delete = (await this.delete(key)).ok;
    return { ok: steps.write && steps.read && steps.exists && steps.delete, steps, adapter: 'google' };
  }
}

/* ---------------------------------------------------------------- factory */

/**
 * Build a gateway for the active profile.
 * With no profile (or an unbootstrapped one) this returns the local adapter, so
 * CI and a fresh clone never need a credential (google-bridge.md §9).
 */
function createGateway({ profileName = process.env.GOOGLE_PROFILE || 'dev', transport = null, fetchImpl, localRoot } = {}) {
  const profileModule = require('./profile.js');
  const { profile } = profileModule.readProfile(profileName);
  const adapterKind = profileModule.activeAdapter(profile);
  const local = new LocalAdapter({ root: localRoot || path.join(ROOT, '.local-store') });
  if (adapterKind === 'google' && transport) {
    return {
      kind: 'google',
      profile: profileName,
      storage: new GoogleAdapter({ transport, layout: profile.layout, accountLabel: profile.account_label, rootFolderName: profile.root_folder_name, fetchImpl }),
      fallback: local
    };
  }
  return { kind: 'local', profile: profileName, storage: local, fallback: local, reason: transport ? 'profile not bootstrapped' : 'no transport configured' };
}

module.exports = {
  ENVELOPE_VERSION,
  canonical,
  sha256,
  envelope,
  LocalAdapter,
  GoogleAdapter,
  createGateway
};
