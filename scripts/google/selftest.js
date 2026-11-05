#!/usr/bin/env node
'use strict';

/**
 * Profile health check (google-bridge.md §4 step 9, §12 "health").
 *
 *   node scripts/google/selftest.js [--profile dev] [--local]
 *
 * Runs the same five-step probe (write → read → list → exists → delete) against
 * whichever adapter is active, then reports whoami + quota + scope warnings.
 * Default is the local adapter, so CI never needs a credential; pass a profile
 * with a live token to check the real account. Exit 0 only when every step ran.
 */

const path = require('node:path');
const profileModule = require('./profile.js');
const gatewayModule = require('./gateway.js');
const { refreshTokenTransport } = require('./bootstrap.js');

const ROOT = profileModule.ROOT;
const QUOTA_ALERT_PERCENT = 80;

function secretName(profileName) {
  return `GOOGLE_REFRESH_TOKEN_${String(profileName).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

async function runSelftest({ adapter, gateway, profile }) {
  const report = { at: new Date().toISOString(), adapter, profile: profile ? profile.profile : null, steps: {}, ok: false, warnings: [] };
  const health = gateway.storage;
  report.whoami = await health.whoami();
  report.quota = await health.quota();
  if (report.quota.percent !== null && report.quota.percent >= QUOTA_ALERT_PERCENT) {
    report.warnings.push(`Drive quota at ${report.quota.percent}% — Drive is shared with Gmail and Photos; archive to backups/ and prune.`);
  }
  report.selftest = await health.selftest();
  report.ok = Boolean(report.selftest.ok);
  if (profile && profile.auth_mode === 'apps_script_bridge' && String(profile.auth_mode).length && profile.auth_mode_reason && /known|re-authoris|periodic/i.test(String(profile.auth_mode_reason))) {
    report.warnings.push('apps_script_bridge: watch for periodic re-authorization reports before relying on it.');
  }
  return report;
}

function printReport(report) {
  console.log(`Adapter   ${report.adapter}`);
  console.log(`Profile   ${report.profile || '(none — local fallback)'}`);
  console.log(`Account   ${report.whoami.account_label || report.whoami.account}  (${report.whoami.display_name || report.whoami.root || 'local'})`);
  const quota = report.quota || {};
  console.log(`Quota     ${quota.percent === null ? 'n/a' : `${quota.percent}% of ${(quota.limit_bytes / 1e9).toFixed(1)} GB`} — ${quota.note || ''}`);
  const steps = report.selftest.steps || {};
  console.log(`Probe     ${Object.entries(steps).map(([name, value]) => `${name}:${value ? 'ok' : 'FAIL'}`).join('  ')}`);
  (report.warnings || []).forEach((warning) => console.log(`· ${warning}`));
  console.log(report.ok ? 'SELFTEST OK' : 'SELFTEST FAILED');
}

module.exports = { runSelftest, printReport, secretName, QUOTA_ALERT_PERCENT };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const forceLocal = argv.includes('--local');
  const profileName = profileModule.resolveProfileName(argv);
  const { file, profile, problems } = profileModule.readProfile(profileName);
  if (problems.length) {
    problems.forEach((problem) => console.error(` ✗ ${problem}`));
    process.exit(2);
  }

  (async () => {
    let gateway;
    if (forceLocal || !profile) {
      gateway = gatewayModule.createGateway({ profileName, localRoot: path.join(ROOT, '.local-store') });
    } else {
      const clientId = process.env.GOOGLE_CLIENT_ID || '';
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
      const refreshToken = process.env[secretName(profileName)] || '';
      if (!clientId || !clientSecret || !refreshToken) {
        console.error(`Live selftest needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and ${secretName(profileName)}.`);
        console.error('Use --local to exercise the adapter contract offline (that is what CI does).');
        process.exit(2);
      }
      const transport = await refreshTokenTransport({ clientId, clientSecret, refreshToken });
      gateway = gatewayModule.createGateway({ profileName, transport });
      if (gateway.kind !== 'google') {
        console.error(`Profile "${profileName}" is not bootstrapped (${path.relative(ROOT, file)} layout ids are null).`);
        console.error(`Run: node scripts/google/bootstrap.js --profile ${profileName}`);
        process.exit(2);
      }
    }
    const report = await runSelftest({ adapter: gateway.kind, gateway, profile });
    printReport(report);
    process.exit(report.ok ? 0 : 1);
  })().catch((error) => {
    const hint = /invalid_grant/.test(error.message)
      ? '\n→ Testing-status tokens die in 7 days. Publish the app ("In production"), re-run scripts/google/auth.js, update the secret.'
      : '';
    console.error(`Selftest error: ${error.message}${hint}`);
    process.exit(1);
  });
}
