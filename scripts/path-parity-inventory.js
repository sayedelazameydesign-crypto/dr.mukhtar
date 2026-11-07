#!/usr/bin/env node
'use strict';

// Read-only lexical inventory, NOT a parser, proof of path parity or a go-live gate.
// It intentionally never declares a source tree safe, even if no pattern matches.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['Code.gs', 'Settings.gs', 'Staff.gs', 'app.js'];
const STATUS_RE = /(?:\bstatus\b|\bstatusText\b|\bstatusClass\b|\biStatus\b|\bopen\.includes\b)/i;
const CHECKPOINTS = [
  { id: 'staff_cancel', file: 'Code.gs', anchor: 'function cancelRequest(', note: 'Review cancellation and event deletion for composite/unknown states.' },
  { id: 'guardian_delete', file: 'Settings.gs', anchor: 'function deleteOwnRequestData(', note: 'Review guardian erasure and Calendar ambiguity for claimed rows.' },
  { id: 'availability', file: 'Code.gs', anchor: 'function isSlotAvailable_(', note: 'Review interval claims as well as Calendar/closures; no inference from event absence.' },
  { id: 'approval', file: 'Code.gs', anchor: 'function approveRequest(', note: 'Review lock scope, ownership, verification and ambiguous writes.' },
  { id: 'reschedule', file: 'Code.gs', anchor: 'function proposeAlternative(', note: 'Review rescheduling and overlaps against claimed intervals.' },
  { id: 'move', file: 'Code.gs', anchor: 'function moveConfirmedAppointment(', note: 'Review moving a confirmed event into a claimed interval.' },
  { id: 'complete', file: 'Code.gs', anchor: 'function completeRequest(', note: 'Review completion and unknown status handling.' },
  { id: 'closure', file: 'Code.gs', anchor: 'function closeDay(', note: 'Review closures against outstanding claims and concurrent writes.' },
  { id: 'duplicates', file: 'Code.gs', anchor: 'function findOpenDuplicate_(', note: 'Review duplicate-intake behavior for claims.' },
  { id: 'queue_sync', file: 'Code.gs', anchor: 'function syncOutageQueue_(', note: 'Review queue synchronization and cross-path locking.' },
  { id: 'staff_dashboard', file: 'app.js', anchor: 'function renderDashboard(', note: 'Review filtering and warnings so claims do not disappear.' },
  { id: 'status_label', file: 'app.js', anchor: 'function formatStatus(', note: 'Review unknown-status fallback and avoid exposing claim identifiers.' },
  { id: 'demo_api', file: 'app.js', anchor: "if (method === 'cancelRequest')", note: 'Review demo cancel, modify, completion and delete behavior separately from GAS.' },
  { id: 'staff_permission', file: 'Staff.gs', anchor: 'function requirePermission_(', note: 'Review permissions and stale sessions independently; status rules do not replace authorization.' }
];
function scan(sources) {
  const missing = FILES.filter((file) => typeof sources[file] !== 'string');
  if (missing.length) return { ok: false, code: 'SOURCE_MISSING', missing };
  const hits = [];
  for (const file of FILES) {
    sources[file].split(/\r?\n/).forEach((line, index) => {
      if (STATUS_RE.test(line)) hits.push({ file, line: index + 1 });
    });
  }
  const checkpoints = CHECKPOINTS.map((item) => {
    const pos = sources[item.file].indexOf(item.anchor);
    return { id: item.id, file: item.file, line: pos < 0 ? null : sources[item.file].slice(0, pos).split('\n').length, state: 'MANUAL_REVIEW_REQUIRED', note: item.note };
  });
  return { ok: false, code: 'MANUAL_REVIEW_REQUIRED', hits, checkpoints };
}
function main() {
  const sources = {};
  try { FILES.forEach((file) => { sources[file] = fs.readFileSync(path.join(ROOT, file), 'utf8'); }); }
  catch (error) { console.error('Path inventory unavailable:', error.code || 'READ_ERROR'); process.exitCode = 1; return; }
  const result = scan(sources);
  console.log('MANUAL REVIEW REQUIRED — lexical inventory only; not a path-parity certificate.');
  for (const file of FILES) console.log(`${file}: ${result.hits.filter((hit) => hit.file === file).length} status-related line(s)`);
  for (const item of result.checkpoints) console.log(`${item.id}: ${item.file}:${item.line === null ? 'ANCHOR_MISSING' : item.line} — ${item.note}`);
  if (process.argv.includes('--details')) result.hits.forEach((hit) => console.log(`status-candidate: ${hit.file}:${hit.line}`));
  if (process.argv.includes('--strict')) process.exitCode = 1; // human review is unresolved by design
}
if (require.main === module) main();
module.exports = { scan, FILES, CHECKPOINTS };
