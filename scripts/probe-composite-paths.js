#!/usr/bin/env node
'use strict';

// Diagnostic characterization of current Code.gs using the existing in-memory GAS
// fixture. Never connects to Google. Does not certify path parity or production safety.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'scripts/test-gas-simulated.js'), 'utf8');
const marker = '// Public intake must reject formula-shaped contact fields';
const end = source.indexOf(marker);
if (end < 0) { console.error('Cannot locate simulated fixture boundary; no probe ran.'); process.exit(2); }
const suffix = `
const claim = 'UNDER_CREATION::123e4567-e89b-42d3-a456-426614174000::60';
function setComposite(ref) {
  const location = context.findRequestLocation_(ref);
  if (!location || location.queueKey) throw new Error('synthetic request not found');
  sheets.get('Requests').rows[location.row - 1][2] = claim;
}
const a = assertSaved(request('09:00'), 'synthetic claim A');
setComposite(a.reference);
const available = context.getAvailableSlots(day, 'كشف جديد');
const approval = context.approveRequest(a.reference, pin);
const reschedule = context.proposeAlternative(a.reference, day, '11:00', pin);
const move = context.moveConfirmedAppointment(a.reference, day, '11:00', 'fixture', pin);
const cancelled = context.cancelRequest(a.reference, 'fixture', pin);
const b = assertSaved(request('09:00'), 'synthetic claim B');
setComposite(b.reference);
const phone = context.findRequest_(b.reference).phone;
const erased = context.deleteOwnRequestData(b.reference, phone, 'fixture');
process.stdout.write(JSON.stringify({
  availabilityReturnedClaimedSlot: !!(available.ok && available.slots.includes('09:00')),
  approvalAccepted: !!approval.ok, rescheduleAccepted: !!reschedule.ok, moveAccepted: !!move.ok,
  cancellationAccepted: !!cancelled.ok, guardianErasureAccepted: !!erased.ok
}) + '\\n');
`;
const script = source.slice(0, end).replace(/^#![^\n]*\n/, '') + suffix;
const child = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
if (child.error || child.status !== 0) { console.error('Simulated probe failed; no safety conclusion.'); if (child.stderr) console.error(child.stderr); process.exit(2); }
const last = child.stdout.trim().split('\n').pop();
try {
  const result = JSON.parse(last);
  console.log('Mock-only characterization:', JSON.stringify(result));
  if (result.availabilityReturnedClaimedSlot || result.approvalAccepted || result.rescheduleAccepted || result.moveAccepted || result.cancellationAccepted || result.guardianErasureAccepted) {
    console.log('INCOMPATIBLE: composite status must not be deployed.');
    process.exitCode = 1;
  } else {
    // Even if these individual probes pass, this is not complete path parity.
    console.log('Selected probes passed; full path parity and live behavior are NOT proven.');
  }
} catch (error) { console.error('Simulated probe returned malformed output.'); process.exitCode = 2; }
