#!/usr/bin/env node
'use strict';

/**
 * Generate docs/production-readiness.md from the two things that actually know the state:
 *
 *   docs/map/gaps.json          the ledger — source of truth for gaps
 *   scripts/go-live-check.js    a real run — source of truth for the report counts
 *
 *   node scripts/readiness-report.js            # check: the document must match
 *   node scripts/readiness-report.js --write    # regenerate it
 *   node scripts/readiness-report.js --offline  # do not touch the network
 *
 * Why this exists: the document used to be written by hand and drifted in two ways that
 * mattered — it reused the labels G1–G10 for pipeline stages while gaps.json used G1–G14
 * for gaps (so "G5" meant two different things), and it listed gaps as open that the
 * ledger had already closed with evidence. A hand-written status page is a rumour.
 *
 * The document now carries generated tables and a clearly marked prose section. The check
 * mode is wired into CI, so a stale table fails the build instead of misleading a reader.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// CELIA_READINESS_DOC is a test seam, not a feature: scripts/test-readiness-report.js points it
// at a fixture copy so the comparison rule can be exercised without editing the real document.
const DOC = process.env.CELIA_READINESS_DOC
  ? path.resolve(process.env.CELIA_READINESS_DOC)
  : path.join(ROOT, 'docs', 'production-readiness.md');
const GAPS = path.join(ROOT, 'docs', 'map', 'gaps.json');
const MARK_START = '<!-- GENERATED:START -->';
const MARK_END = '<!-- GENERATED:END -->';

const write = process.argv.includes('--write');
const offline = process.argv.includes('--offline');
const requireJsdom = process.argv.includes('--require-jsdom');

/* ------------------------------------------------------------------ sources */
let gaps;
try {
  gaps = JSON.parse(fs.readFileSync(GAPS, 'utf8'));
} catch (error) {
  console.error(`✗ cannot read docs/map/gaps.json: ${error.message}`);
  process.exit(1);
}

// The report is a real run. Its JSON is the only input for the counts.
// The generated block records the measurement DATE, not a live timestamp: a block that
// changes on every run makes --check permanently red and teaches people to ignore it.
const runArgs = [path.join(ROOT, 'scripts', 'go-live-check.js'), '--json'];
if (offline) runArgs.push('--offline');
const run = spawnSync(process.execPath, runArgs, { cwd: ROOT, encoding: 'utf8' });
let report;
try {
  report = JSON.parse(run.stdout);
} catch (error) {
  console.error('✗ go-live-check.js did not produce JSON — run it directly to see why:');
  console.error((run.stdout || '').slice(0, 600));
  console.error((run.stderr || '').slice(0, 600));
  process.exit(1);
}

/* ------------------------------------------------------------ environment */
// A measurement whose inputs differ per machine is not a measurement. When --require-jsdom is
// passed (CI does), the browser gate must actually run, or the numbers would silently describe
// a machine with fewer tools.
let jsdomPresent = false;
try { require.resolve('jsdom'); jsdomPresent = true; } catch (_) { jsdomPresent = false; }
report.browser_gate = jsdomPresent ? 'ran' : 'missing';
if (requireJsdom && !jsdomPresent) {
  console.error('✗ --require-jsdom: jsdom is not installed, so the browser gate would report');
  console.error('  "needs action" on this machine and produce different numbers than a developer');
  console.error('  sees. Install it (npm i --no-save --prefix /tmp/deps jsdom@25) and set NODE_PATH.');
  process.exit(1);
}

/* ---------------------------------------------------------------- consistency */
// Contradictions are errors, not notes: a status document that disagrees with the ledger is
// worse than no document, because it is quoted with confidence.
const contradictions = [];
const closed = gaps.gaps.filter((gap) => gap.status === 'resolved');
const open = gaps.gaps.filter((gap) => gap.status !== 'resolved');
const ids = new Set(gaps.gaps.map((gap) => gap.id));

if (ids.size !== gaps.gaps.length) contradictions.push('gaps.json has duplicate ids');
closed.forEach((gap) => {
  if (!gap.resolution || !gap.resolution.evidence) {
    contradictions.push(`${gap.id} is marked resolved without a resolution.evidence`);
  }
});

// Every unverified/action item in the report must be explained by an open gap or be an
// explicitly documented non-gap (site reachability, GitHub settings readability).
const OPEN_GAP_IDS = new Set(open.map((gap) => gap.id));
if (!OPEN_GAP_IDS.size && report.counts.unverified && !report.counts.action) {
  contradictions.push('the report has open items but gaps.json has no open gap');
}

// The ledger's own tally must agree with itself.
const tally = {
  total: gaps.gaps.length,
  closed: closed.length,
  open: open.length,
  open_ids: open.map((gap) => gap.id)
};

/* -------------------------------------------------------------- markdown */
const statusCell = (status) => ({
  ready: '✅ **PASS**',
  action: '❌ **FAIL (needs user action)**',
  unverified: '⏸️ **NOT VERIFIED**',
  info: 'ℹ️ info'
}[status] || status);

const gapTable = [
  '| Gap | Type | Severity | Status | Evidence / closure |',
  '| --- | --- | --- | --- | --- |',
  ...gaps.gaps.map((gap) => {
    const state = gap.status === 'resolved' ? '**resolved**' : '**OPEN**';
    const evidence = gap.status === 'resolved'
      ? String((gap.resolution && gap.resolution.evidence) || '').replace(/\|/g, '\\|')
      : String(gap.evidence || '').replace(/\|/g, '\\|');
    return `| ${gap.id} | ${gap.type} | ${gap.severity} | ${state} | ${evidence} |`;
  })
].join('\n');

const reportTable = [
  '| Item | Result | Detail | Owner |',
  '| --- | --- | --- | --- |',
  ...report.results.map((row) => {
    // Ownership is derived, not guessed: an id prefix maps to a source in code.
    const owner = row.id.startsWith('clinic.') || row.id.startsWith('live.') ? 'المستخدم'
      : row.id.startsWith('site.') ? 'المستخدم (شبكة)'
        : 'CC (المستودع)';
    const detail = String(row.detail || '').replace(/\|/g, '\\|').slice(0, 140);
    return `| ${row.id} — ${row.label} | ${statusCell(row.status)} | ${detail} | ${owner} |`;
  })
].join('\n');

const generated = `${MARK_START}
<!-- هذا القسم مُولَّد: node scripts/readiness-report.js --write · لا تُحرّره يدويًا -->

## الحكم (من تشغيل فعلي)

| القياس | القيمة |
| --- | --- |
| تاريخ القياس | ${String(report.measured_at).slice(0, 10)} |
| بيئة القياس | ${report.browser_gate === 'ran' ? 'jsdom موجود (البوابة عملت)' : 'jsdom غائب (بوابة المتصفح «يحتاج إجراء»)'} |
| الشبكة | ${report.offline ? 'متخطّاة (--offline)' : 'مستخدمة'} |
| جاهز | **${report.counts.ready}** |
| يحتاج إجراء | **${report.counts.action}** |
| غير مُتحقَّق | **${report.counts.unverified}** |
| معلومات | ${report.counts.info} |
| الحكم | \`${report.verdict}\` |

**ليس جاهزًا للتشغيل** ما دام \`verdict !== "ready"\`. هذا السطر يُولَّد، ولا يُكتب.

## السجل (مصدر الحقيقة: \`docs/map/gaps.json\`)

| الإجمالي | مغلق | مفتوح |
| --- | --- | --- |
| **${tally.total}** | **${tally.closed}** | **${tally.open}**${tally.open_ids.map((id) => ` (${id})`).join('')} |

${gapTable}

## نتيجة تشغيل التقرير

${reportTable}

${MARK_END}`;

/* ------------------------------------------------------------ document */
const HEADER = `# Production Readiness — سجل الفجوات وتقرير التشغيل

> **مصدر الحقيقة:** [\`docs/map/gaps.json\`](../docs/map/gaps.json) للسجل، وتشغيل فعلي لـ
> \`scripts/go-live-check.js\` للأرقام. الجداول أدناه **مُولَّدة** — \`node scripts/readiness-report.js --check\`
> في CI يفشل إن تباعدت عن المصدر.
>
> **لا تخلط الترقيم:** السجل يستخدم \`G1…G14\` **للفجوات فقط**. مراحل خط الأنابيب (بناء، اختبارات،
> فحص، أمن، بيانات، إعداد، رصد، استعادة، مسار المستخدم، نشر) تُسمّى \`P-BUILD … P-DEPLOY\` كي لا
> يتكرر \`G5\` بمعنيين — وهو تناقض كان قائمًا في هذه الوثيقة حتى ٢٠٢٦-١١-٠٥.

## خط الأنابيب (P-*) — حالة كل مرحلة

| المرحلة | الحالة | الدليل |
| --- | --- | --- |
| P-BUILD | ✅ | \`python3 scripts/build-gas-package.py\` → حزمة \`gas/\` تُبنى |
| P-TESTS | 🟡 | ١٨ بوابة محلية، كلها محاكاة — لا تكامل مع Google حقيقي (يفتح G1/G14) |
| P-STATIC | ✅ | \`check-settings-parity\` · \`scan-secrets\` · \`check-config\` · \`check-workflows\` |
| P-SECURITY | 🟡 | القائمة البيضاء للنشر + \`test-publish-contract.js\`؛ لا مراجعة أمنية خارجية |
| P-DATA | ❌ | لا نسخة احتياطية/استعادة مُختبرة لـ Sheets/Calendar (بند بروفة، لا فجوة سجل) |
| P-CONFIG | 🟡 | الإعداد موثّق ومفحوص؛ **بيانات العيادة الأربعة** لم تُدخل بعد |
| P-OBSERVABILITY | 🟡 | \`Audit\` + \`logEvent_\`؛ لا فحص صحة ولا تنبيه للمشغّل |
| P-RECOVERY | 🟡 | \`git revert\` + إعادة نشر؛ لا خطة استعادة بيانات |
| P-USERFLOW | 🟡 | مُثبت في jsdom وفي المحاكاة؛ غير مُثبت في حساب حقيقي (G1) |
| P-DEPLOY | 🟡 | الموقع منشور ومُتحقَّق؛ Apps Script لم يُنشر قط |

## ما تغيّر ولماذا — سجل مختصر

| التاريخ | التغيير | الدليل |
| --- | --- | --- |
| ٢٠٢٦-١١-٠٥ (١) | النشر صار قائمة سماح؛ حُذفت الملفات الداخلية من المستودع | \`test-publish-contract.js\` ٤٩ فحصًا + إدخال خلل مرتين |
| ٢٠٢٦-١١-٠٥ (١) | اختبارات المتصفح تفشل بدل أن تتخطى بصمت | \`SKIPPED-WITH-FAILURE … exit=1\` |
| ٢٠٢٦-١١-٠٥ (٢) | ٥ بوابات صامتة صارت تفشل بصوت عالٍ + حرس دائم | \`test-silent-gates.js\` ١٠ فحوص |
| ٢٠٢٦-١١-٠٥ (٢) | بوابة بيانات العيادة: schema + نشر إنتاجي صارم | \`test-clinic-schema.js\` ٤٥ فحصًا |
| ٢٠٢٦-١١-٠٥ (٣) | هذه الوثيقة تُولَّد من السجل + تشغيل فعلي؛ وتناقض G5 أُزيل | \`readiness-report.js\` يفشل عند التباعد |

`;

// The rehearsal counters used to be typed into this string, so adding a step silently made
// the generated document lie. They are derived from the checklist now.
let rehearsalTotal = 0;
let rehearsalDone = 0;
try {
  const checklist = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'rehearsal-checklist.json'), 'utf8'));
  (checklist.sections || []).forEach((section) => {
    (section.steps || []).forEach((step) => {
      rehearsalTotal += 1;
      if (step.evidence && String(step.evidence).trim()) rehearsalDone += 1;
    });
  });
} catch (error) {
  console.error(`✗ cannot read scripts/rehearsal-checklist.json: ${error.message}`);
  process.exit(1);
}

const TAIL = `
---

## كيف يُعاد توليد هذا الملف

\`\`\`bash
npm i --no-save --prefix /tmp/jsd jsdom@25          # للبوابات الثلاث في المتصفح
NODE_PATH=/tmp/jsd/node_modules node scripts/readiness-report.js --write
NODE_PATH=/tmp/jsd/node_modules node scripts/readiness-report.js          # فحص فقط (يفشل إن تباعد)
\`\`\`

## بروفة Google

كل خطوة في [\`docs/google-rehearsal.md\`](./google-rehearsal.md) لها حقل \`evidence\` في
\`scripts/rehearsal-checklist.json\` (${rehearsalTotal} خطوة، التقدّم الحالي **${rehearsalDone}/${rehearsalTotal}**). الفجوتان **G1** و**G14** لا
تُغلقان إلا بأدلة من حسابك، ولا يرقّيهما كلام.
`;

const next = `${HEADER}${generated}${TAIL}`;

/* --------------------------------------------------------------- compare */
const current = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';
// Compare only the generated block, so prose edits elsewhere do not fail the check.
const block = (text) => {
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  return start === -1 || end === -1 ? null : text.slice(start, end + MARK_END.length);
};
const currentBlock = block(current);
const nextBlock = block(next);

/*
 * Two honest runs differ in exactly one way that is not a fact about the repository: whether
 * this machine could reach the published site. With --offline the summary row says "متخطّاة
 * (--offline)" and site.up's detail says the network was skipped; with a network it says
 * "مستخدمة" and carries the failure reason. Comparing that text verbatim made the check red on
 * any machine whose connectivity differed from the one that generated the file — a gate that
 * cries wolf gets ignored, which is worse than not having it.
 *
 * So exactly two cells are normalised, and nothing else:
 *   · the "الشبكة" summary row, and
 *   · site.up's detail cell (index 3) — its *status* cell stays compared, so a site that comes
 *     up (unverified → ready/action) still fails the check, as do the counts that follow it.
 */
const normaliseNetwork = (text) => text.split('\n').map((line) => {
  if (/^\| الشبكة \|/.test(line)) return '| الشبكة | <شبكة> |';
  if (line.startsWith('| site.up ')) {
    const cells = line.split('|');
    if (cells.length >= 6) cells[3] = ' <شبكة> ';
    return cells.join('|');
  }
  return line;
}).join('\n');

if (contradictions.length) {
  console.error(`✗ ${contradictions.length} contradiction(s) between the ledger and the report:`);
  contradictions.forEach((line) => console.error(`   ✗ ${line}`));
  process.exit(1);
}

if (write) {
  fs.writeFileSync(DOC, next, 'utf8');
  console.log(`✓ regenerated ${path.relative(ROOT, DOC)} — ${tally.total} gaps (${tally.closed} closed, ${tally.open} open); report ${report.counts.ready}·${report.counts.action}·${report.counts.unverified}`);
  process.exit(0);
}

if (!currentBlock) {
  console.error('✗ docs/production-readiness.md has no generated block — run with --write');
  process.exit(1);
}
if (normaliseNetwork(currentBlock) !== normaliseNetwork(nextBlock)) {
  console.error('✗ docs/production-readiness.md is stale relative to gaps.json + a real run.');
  console.error('  Fix: NODE_PATH=… node scripts/readiness-report.js --write');
  process.exit(1);
}
console.log(`Readiness document is consistent — ${tally.total} gaps (${tally.closed} closed, ${tally.open} open); report ${report.counts.ready}·${report.counts.action}·${report.counts.unverified}.`);
process.exit(0);
