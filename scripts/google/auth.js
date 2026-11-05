#!/usr/bin/env node
'use strict';

/**
 * One-time OAuth flow for the Google bridge (google-bridge.md §4 step 6).
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/google/auth.js [--profile dev] [--out .secrets/google-token.dev.json]
 *
 * - Opens the consent URL, waits for the code on a loopback listener, exchanges
 *   it once with access_type=offline & prompt=consent, then prints ONLY the name
 *   of the secret to store (`GOOGLE_REFRESH_TOKEN_<PROFILE_UPPER>`).
 * - The refresh token is written to a git-ignored file so you can paste it into
 *   `gh secret set` yourself; it is never printed and never passed as an argument.
 * - Requires a Desktop-app OAuth client (loopback redirect is allowed for those).
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const profileModule = require('./profile.js');
const ROOT = profileModule.ROOT;

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPES_BY_NAME = {
  'drive.file': 'https://www.googleapis.com/auth/drive.file',
  'drive.appdata': 'https://www.googleapis.com/auth/drive.appdata',
  spreadsheets: 'https://www.googleapis.com/auth/spreadsheets',
  'calendar.events': 'https://www.googleapis.com/auth/calendar.events',
  'calendar.readonly': 'https://www.googleapis.com/auth/calendar.readonly',
  tasks: 'https://www.googleapis.com/auth/tasks',
  'contacts.readonly': 'https://www.googleapis.com/auth/contacts.readonly',
  'gmail.send': 'https://www.googleapis.com/auth/gmail.send'
};

function secretNameFor(profileName) {
  return `GOOGLE_REFRESH_TOKEN_${String(profileName).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function buildAuthUrl({ clientId, redirectUri, scopes, state, loginHint }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.map((scope) => SCOPES_BY_NAME[scope] || scope).join(' '));
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent'); // without this Google may omit the refresh token
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  if (loginHint) url.searchParams.set('login_hint', loginHint);
  return url.toString();
}

function maskEmail(value) {
  const text = String(value || '');
  const at = text.indexOf('@');
  if (at < 1) return 'unknown';
  return `${text[0]}***${text.slice(at)}`;
}

if (require.main !== module) {
  module.exports = { secretNameFor, buildAuthUrl, maskEmail, SCOPES_BY_NAME, TOKEN_ENDPOINT };
} else {
  const argv = process.argv.slice(2);
  const profileName = profileModule.resolveProfileName(argv);
  const outIndex = argv.indexOf('--out');
  const outFile = outIndex !== -1 && argv[outIndex + 1]
    ? path.resolve(argv[outIndex + 1])
    : path.join(ROOT, '.secrets', `google-token.${profileName}.json`);
  const { profile, problems } = profileModule.readProfile(profileName);

  if (!profile) {
    console.error(`No config/google.profile.${profileName}.json. Copy the example first:`);
    console.error(`  cp config/google.profile.example.json config/google.profile.${profileName}.json`);
    process.exit(2);
  }
  if (problems.length) {
    console.error('Profile is invalid — fix these before authorising:');
    problems.forEach((problem) => console.error(` ✗ ${problem}`));
    process.exit(2);
  }
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) {
    console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in this shell (from the Desktop OAuth client).');
    console.error('They are secrets: never paste them into a file, an issue or a chat.');
    process.exit(2);
  }
  if (fs.existsSync(outFile)) {
    console.error(`${path.relative(ROOT, outFile)} already exists. Delete it (or pass --out elsewhere) — a refresh token is never overwritten silently.`);
    process.exit(2);
  }

  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer();
  server.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
    const url = buildAuthUrl({ clientId, redirectUri, scopes: profile.scopes, state, loginHint: process.env.GOOGLE_LOGIN_HINT });
    console.log('1) Open this URL in the browser where the SYSTEM account is signed in:\n');
    console.log(`   ${url}\n`);
    console.log('2) Approve the scopes, then return here. The loopback listener stops after one code.\n');

    let finished = false;
    const finish = (code, message) => {
      if (finished) return;
      finished = true;
      console.log(message);
      server.close();
      process.exit(code);
    };

    server.on('request', (request, response) => {
      const incoming = new URL(request.url, `http://127.0.0.1:${port}`);
      if (incoming.pathname !== '/oauth2callback') {
        response.writeHead(404).end('not found');
        return;
      }
      const error = incoming.searchParams.get('error');
      const code = incoming.searchParams.get('code');
      if (error) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('authorisation denied');
        finish(1, `Authorisation failed: ${error}`);
        return;
      }
      if (incoming.searchParams.get('state') !== state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state mismatch');
        finish(1, 'State mismatch — start again.');
        return;
      }
      if (!code) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('missing code');
        finish(1, 'No authorisation code in the callback.');
        return;
      }

      const body = new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });
      fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      }).then(async (tokenResponse) => {
        const payload = await tokenResponse.json().catch(() => ({}));
        if (!tokenResponse.ok || !payload.refresh_token) {
          response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('token exchange failed');
          const reason = payload.error || `HTTP ${tokenResponse.status}`;
          finish(1, `Token exchange failed: ${reason}${payload.error === 'invalid_client' ? ' (is this a Desktop client?)' : ''}`);
          return;
        }
        const record = {
          profile: profileName,
          scope: payload.scope,
          token_type: payload.token_type,
          obtained_at: new Date().toISOString(),
          expires_in: payload.expires_in,
          refresh_token: payload.refresh_token,
          account_hint: payload.id_token ? 'see id_token' : 'unknown'
        };
        fs.mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end('<p style="font-family:system-ui">تم. يمكنك إغلاق هذه الصفحة والعودة إلى الطرفية.</p>');
        console.log(`3) Token saved to ${path.relative(ROOT, outFile)} (git-ignored, mode 600). It is NOT printed.`);
        console.log(`4) Store it as the secret ${secretNameFor(profileName)}:`);
        console.log(`   gh secret set ${secretNameFor(profileName)} < ${path.relative(ROOT, outFile)}  # adjust to the field you need, or paste manually`);
        console.log(`   then delete the local file: rm ${path.relative(ROOT, outFile)}`);
        finish(0, `Authorised profile "${profileName}" (scopes: ${(payload.scope || '').split(' ').length}).`);
      }).catch((error) => {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('token exchange failed');
        finish(1, `Token exchange error: ${error.message}`);
      });
    });
  });
}
