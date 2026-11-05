#!/usr/bin/env node
'use strict';

/**
 * Profile → profile copy (google-bridge.md §8 step 4).
 *
 *   node scripts/google/migrate.js --from dev --to clinic --dry-run
 *   node scripts/google/migrate.js --from dev --to clinic --apply
 *
 * Rules that make this safe:
 * - copies by LOGICAL path, never by raw id;
 * - verifies sha256 of every object and reports mismatches instead of "done";
 * - writes nothing to the target unless --apply is passed;
 * - never deletes or mutates the source: step 6 of the runbook (revoking A) stays
 *   a human decision after the report looks clean.
 *
 * Both profiles need their own tokens in the environment, by name only.
 */

const profileModule = require('./profile.js');
const gatewayModule = require('./gateway.js');
const { refreshTokenTransport } = require('./bootstrap.js');

function secretName(profileName) {
  return `GOOGLE_REFRESH_TOKEN_${String(profileName).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function transportFor(profileName) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  const refreshToken = process.env[secretName(profileName)] || '';
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`Missing credentials for profile "${profileName}" (needs ${secretName(profileName)} plus the shared client id/secret).`);
  }
  return refreshTokenTransport({ clientId, clientSecret, refreshToken });
}

/** Pure planning step so tests can cover it without a network or a token. */
function planMigration(sourceItems, targetItems) {
  const target = new Set(targetItems);
  const copy = sourceItems.filter((item) => !target.has(item));
  const skip = sourceItems.filter((item) => target.has(item));
  return { copy, skip, summary: { source: sourceItems.length, target: targetItems.length, copy: copy.length, skip: skip.length } };
}

function compareHashes(sourceDocs, targetDocs) {
  const mismatches = [];
  sourceDocs.forEach((doc) => {
    const other = targetDocs.find((candidate) => candidate.id === doc.id);
    if (!other) mismatches.push({ id: doc.id, reason: 'missing in target' });
    else if (other.sha256 !== doc.sha256) mismatches.push({ id: doc.id, reason: 'sha256 differs' });
  });
  return mismatches;
}

module.exports = { planMigration, compareHashes, secretName };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
  const from = value('--from');
  const to = value('--to');
  const apply = argv.includes('--apply');
  const dryRun = !apply;

  (async () => {
    if (!from || !to || from === to) {
      console.error('Usage: node scripts/google/migrate.js --from <profileA> --to <profileB> [--apply]');
      process.exit(2);
    }
    const source = profileModule.readProfile(from);
    const target = profileModule.readProfile(to);
    [source, target].forEach((entry) => {
      if (!entry.profile) { console.error(`Profile "${entry.name}" not found. Copy config/google.profile.example.json first.`); process.exit(2); }
      if (entry.problems.length) { entry.problems.forEach((problem) => console.error(` ✗ ${entry.name}: ${problem}`)); process.exit(2); }
    });

    const sourceGateway = gatewayModule.createGateway({ profileName: from, transport: transportFor(from) });
    const targetGateway = gatewayModule.createGateway({ profileName: to, transport: transportFor(to) });
    if (sourceGateway.kind !== 'google' || targetGateway.kind !== 'google') {
      console.error('Both profiles must be bootstrapped (layout ids filled) before migrating.');
      process.exit(2);
    }

    const items = await sourceGateway.storage.list('memory/long');
    const existing = await targetGateway.storage.list('memory/long');
    const plan = planMigration(items, existing);
    console.log(`Plan: copy ${plan.summary.copy}, skip ${plan.summary.skip} (source ${plan.summary.source}, target ${plan.summary.target}).`);
    if (dryRun) {
      plan.copy.slice(0, 20).forEach((item) => console.log(`  + ${item}`));
      if (plan.copy.length > 20) console.log(`  … ${plan.copy.length - 20} more`);
      console.log('\nDry run — nothing written. Re-run with --apply once this plan looks right.');
      process.exit(0);
    }

    const copied = [];
    for (const item of plan.copy) {
      const doc = await sourceGateway.storage.get(item);
      if (!doc) continue;
      await targetGateway.storage.put(item, doc);
      copied.push(doc);
    }
    const mismatches = compareHashes(copied, (await Promise.all(plan.copy.map((item) => targetGateway.storage.get(item)))).filter(Boolean));
    console.log(`Copied ${copied.length}. sha256 mismatches: ${mismatches.length}.`);
    mismatches.forEach((mismatch) => console.log(` ✗ ${mismatch.id}: ${mismatch.reason}`));
    console.log(mismatches.length
      ? 'Do NOT switch GOOGLE_PROFILE yet. Source is untouched; fix the mismatches and re-run.'
      : `Verified. Now: set GOOGLE_PROFILE=${to}, run the selftest, and only then revoke ${from} (§8 step 6).`);
    process.exit(mismatches.length ? 1 : 0);
  })().catch((error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exit(1);
  });
}
