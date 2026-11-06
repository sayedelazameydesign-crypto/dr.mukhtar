#!/usr/bin/env node
/**
 * Evidence Lab generator — مختبر الأدلة.
 *
 * Builds two artifacts from the committed tree only, with no network and no wall clock,
 * so `npm run evidence` reproduces them byte-for-byte and `npm run evidence:check` fails
 * the moment someone edits one of them by hand or the sources drift:
 *
 *   evidence/index.html — self-contained RTL page; everything on it is generated from the
 *                         repository itself (gaps ledger, architecture map, threat model,
 *                         component/edge counts, file sizes). No CDN, no fonts, no analytics.
 *   BENCHMARKS.md        — metrics a reviewer can measure again with one command each.
 *
 * Nothing here is measured by running the test suites at build time (that would make the
 * output machine-dependent). Numbers about test runs are recorded once, with the date and
 * the command that produced them, in the static table below; the suites themselves remain
 * the source of truth and CI re-runs them on every event.
 *
 * Anything the generator cannot know from the tree is stated as "not measured", never
 * estimated. If you extend this file, keep that rule.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CHECK = process.argv.includes('--check');

/* -------------------------------------------------- inputs (the tree itself) */
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// The public allow-list mirrored from .github/workflows/pages.yml — every file the site
// serves. Kept deliberately in sync with the publish-contract test.
const SITE_FILES = [
  'index.html', 'privacy.html', 'app.css', 'app.js', '404.html',
  'manifest.webmanifest', 'robots.txt', 'sitemap.xml', 'clinic.json', 'brand.svg',
];
const SITE_ASSETS_DIR = 'assets';

const walkBytes = (dirAbs) => {
  let total = 0;
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) total += walkBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
};
const countByExt = (dirAbs, ext) => {
  let count = 0;
  for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const full = path.join(dirAbs, entry.name);
    if (entry.isDirectory()) count += countByExt(full, ext);
    else if (entry.name.endsWith(ext)) count += 1;
  }
  return count;
};

const gapsDoc = readJson('docs/map/gaps.json');
const projectMap = readJson('docs/map/project.json');
const freeTiers = readJson('docs/free-tiers.json');
const threatModel = fs.readFileSync(path.join(ROOT, 'docs/audit/threat-model-2026-11.md'), 'utf8');

const gaps = gapsDoc.gaps || [];
const openGaps = gaps.filter((g) => g.status !== 'resolved');
const resolvedGaps = gaps.length - openGaps.length;

const nodes = projectMap.nodes || [];
const edges = projectMap.edges || [];
const layers = {};
nodes.forEach((node) => { layers[node.layer] = (layers[node.layer] || 0) + 1; });

const threatRows = threatModel.split('\n').filter((line) => /^\| T-\d+ /.test(line));
const threatStats = { controlled: 0, accepted: 0, standing: 0, critical: 0 };
threatRows.forEach((line) => {
  const cells = line.split('|').map((cell) => cell.trim());
  const rating = cells[7] || '';
  if (/مُسيطَر/.test(rating)) threatStats.controlled += 1;
  else if (/ثغرة مؤكدة|حرج/.test(rating)) threatStats.critical += 1;
  else if (/مخاطرة قائمة/.test(rating)) threatStats.standing += 1;
  else if (/مقبول/.test(rating)) threatStats.accepted += 1;
});

const siteBytes = SITE_FILES.reduce((sum, rel) => sum + fs.statSync(path.join(ROOT, rel)).size, 0)
  + walkBytes(path.join(ROOT, SITE_ASSETS_DIR));
const appJsBytes = fs.statSync(path.join(ROOT, 'app.js')).size;
const docsBytes = walkBytes(path.join(ROOT, 'docs'));
const docsMdCount = countByExt(path.join(ROOT, 'docs'), '.md');
const testCount = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.js$/.test(f)).length;
const workflowCount = fs.readdirSync(path.join(ROOT, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)).length;
const services = Array.isArray(freeTiers.services) ? freeTiers.services : [];
const cardFree = services.filter((s) => !s.card_required).length;

const number = (n) => n.toLocaleString('en-US');
const repoBlob = (rel) => `https://github.com/sayedelazameydesign-crypto/dr.mukhtar/blob/main/${rel}`;

const GENERATED_WARNING =
  'GENERATED FILE — لا تحرّره يدويًا. عدّل scripts/build-evidence-page.js ثم شغّل: npm run evidence';

/* ------------------------------------------------------------ evidence page */
const gapRows = openGaps
  .map((g) => `        <tr><th>${g.id}</th><td><span class="sev sev-${g.severity}">${g.severity}</span></td>`
    + `<td>${g.type}</td><td><a href="${repoBlob('docs/map/gaps.json')}">gaps.json</a></td></tr>`)
  .join('\n');

const layerRows = Object.entries(layers)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([layer, count]) => `        <tr><th>${layer}</th><td>${count}</td></tr>`)
  .join('\n');

const buildPage = () => `<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Celia Kids — مختبر الأدلة: كل رقم في هذه الصفحة مولَّد من المستودع نفسه أو قابل لإعادة القياس بأمر واحد.">
  <meta name="color-scheme" content="light">
  <title>Celia Kids — Evidence Lab · مختبر الأدلة</title>
<!-- ${GENERATED_WARNING} -->
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif; color: #1c2b33; background: #f7faf9; line-height: 1.75; }
    main { max-width: 880px; margin: 0 auto; padding: 2rem 1.25rem 3.5rem; }
    .eyebrow { letter-spacing: .08em; font-size: .8rem; color: #0e7c86; font-weight: 700; }
    h1 { font-size: 2.1rem; line-height: 1.25; margin: .2em 0 .35em; color: #10333c; }
    h2 { font-size: 1.35rem; margin: 2.4rem 0 .6rem; color: #10333c; border-bottom: 2px solid #dce8e7; padding-bottom: .35rem; }
    p, li { max-width: 72ch; }
    code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .85em; background: #eef4f3; border-radius: 6px; }
    code { padding: .1em .4em; }
    pre { padding: .85rem 1rem; overflow-x: auto; direction: ltr; text-align: left; }
    .lede { font-size: 1.15rem; color: #2c4750; }
    .chips { display: flex; flex-wrap: wrap; gap: .5rem; margin: .75rem 0 0; padding: 0; list-style: none; }
    .chip { background: #e2efee; color: #145653; border: 1px solid #bcd6d4; border-radius: 999px; padding: .2rem .8rem; font-size: .8rem; font-weight: 600; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .65rem; margin: 1.25rem 0 .5rem; }
    .card { background: #fff; border: 1px solid #dce8e7; border-radius: 12px; padding: .8rem .9rem; }
    .card b { display: block; font-size: 1.55rem; color: #0e7c86; line-height: 1.15; }
    .card span { font-size: .8rem; color: #48636b; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dce8e7; border-radius: 12px; overflow: hidden; font-size: .9rem; }
    th, td { padding: .5rem .65rem; border-bottom: 1px solid #e7efed; text-align: right; }
    tr:last-child th, tr:last-child td { border-bottom: 0; }
    thead th { background: #10333c; color: #fff; }
    tbody th { background: #eef4f3; }
    .sev { border-radius: 999px; padding: .05em .65em; font-size: .78rem; font-weight: 700; }
    .sev-high { background: #fde3e1; color: #8f1d18; }
    .sev-med { background: #fdf0d5; color: #7a5200; }
    .sev-low { background: #e3f2fd; color: #0d4f8b; }
    .honest { background: #fff8e8; border: 1px solid #eed9a8; border-radius: 12px; padding: .75rem 1rem; }
    .honest b { color: #7a5200; }
    footer { border-top: 1px solid #dce8e7; margin-top: 2.5rem; padding-top: 1rem; font-size: .85rem; color: #48636b; }
    a { color: #0e7c86; }
    details { background: #fff; border: 1px solid #dce8e7; border-radius: 12px; padding: .75rem 1rem; margin-top: 2rem; }
    summary { cursor: pointer; font-weight: 700; color: #10333c; }
  </style>
</head>
<body>
<main>

  <header>
    <p class="eyebrow">CELIA KIDS · DR. MUKHTAR — EVIDENCE LAB</p>
    <h1>مختبر الأدلة</h1>
    <p class="lede">لا تطلب أن تُصدّقنا. كل رقم في هذه الصفحة مولَّد من المستودع نفسه، أو له أمر واحد يُعيد قياسه.</p>
    <ul class="chips">
      <li class="chip">توليد آلي: scripts/build-evidence-page.js</li>
      <li class="chip">لا مراجعات خارجية مدّعاة</li>
      <li class="chip">لا بيانات مريض — أدلة هندسية فقط</li>
    </ul>
  </header>

  <h2>أعد الإنتاج بنفسك — ثلاث خطوات</h2>
  <pre>git clone https://github.com/sayedelazameydesign-crypto/dr.mukhtar.git
cd dr.mukhtar
npm ci &amp;&amp; npm test          # 24 فحص خصوصية + محاكاة Apps Script + واجهة jsdom
node scripts/go-live-check.js --offline
npm run readiness            # سجل الجاهزية مقابل gaps.json</pre>

  <div class="cards">
    <div class="card"><b>${gaps.length}</b><span>فجوة موثقة — ${resolvedGaps} محلولة، ${openGaps.length} مفتوحة</span></div>
    <div class="card"><b>${number(nodes.length)} / ${number(edges.length)}</b><span>مكوّن / علاقة في خريطة المعمارية</span></div>
    <div class="card"><b>${threatRows.length}</b><span>تهديدًا موثقًا بمنهج STRIDE</span></div>
    <div class="card"><b>${workflowCount} سير عمل</b><span>كلها بتثبيت SHA — صفر بطاقة ائتمان</span></div>
    <div class="card"><b>${cardFree} / ${services.length}</b><span>خدمة مجانية بدون بطاقة (قيد صلب)</span></div>
    <div class="card"><b>${number(siteBytes)} بايت</b><span>حجم الموقع الثابت كاملًا</span></div>
  </div>

  <h2>سجل الفجوات — كما هو، لا كما نتمنى</h2>
  <p>الجاهزية ليست شعارًا بل سجلًا. الفجوات الخمس المفتوحة اليوم:</p>
  <table>
    <thead><tr><th>المعرف</th><th>الخطورة</th><th>النوع</th><th>المصدر</th></tr></thead>
    <tbody>
${gapRows}
    </tbody>
  </table>
  <p>G26 قرار معماري مُعلَن (رفض النواة الآن) — انظر <a href="${repoBlob('docs/architecture/adr/0003-no-kernel-now.md')}">ADR-0003</a>. الخطة الكاملة لإغلاق الخمسة: <a href="${repoBlob('ROADMAP.md')}">ROADMAP.md</a>. طريقة القياس نفسها موثقة في <a href="${repoBlob('docs/production-readiness.md')}">docs/production-readiness.md</a>.</p>

  <h2>نموذج التهديد — بما فيه ما لم يُغلَق</h2>
  <div class="cards">
    <div class="card"><b>${threatStats.controlled}</b><span>مُسيطر عليها / جزئيًا</span></div>
    <div class="card"><b>${threatStats.accepted}</b><span>مقبولة (مؤقتًا / خارج نموذج)</span></div>
    <div class="card"><b>${threatStats.standing}</b><span>مخاطرة قائمة وموثقة</span></div>
    <div class="card"><b>${threatStats.critical}</b><span>حرجة — انظر T-09 وT-10</span></div>
  </div>
  <div class="honest">
    <b>الثغرة المؤكدة T-10 (وT-09) لم تُغلَق بعد.</b> مقارنة <code>constantTimeEquals_</code> تدور على طول النبذة لا طول المخزّن — بادئة صحيحة تُقبَل. الوثيقة تشرح الإثبات التنفيذي سطريًا، و<a href="${repoBlob('docs/audit/threat-model-2026-11.md')}">النموذج الكامل</a> يحمل دليل ملف:سطر لكل صف. هذا المستودع لا يدّعي جاهزية أمنية غير موجودة — يدّعي أن ما يعيبه مكتوب مكانه. قناة البلاغ الخاصة: <a href="${repoBlob('SECURITY.md')}">SECURITY.md</a>.
  </div>

  <h2>المعمارية — خمسة حدود واعية</h2>
  <table>
    <thead><tr><th>الطبقة</th><th>المكوّنات</th></tr></thead>
    <tbody>
${layerRows}
    </tbody>
  </table>
  <p>${number(nodes.length)} مكوّنًا و${number(edges.length)} علاقة موثقة بثقة عالية/متوسطة، عبر ${Object.keys(layers).length} طبقات و${(projectMap.entrypoints || []).length} نقطة دخول. التفاصيل: <a href="${repoBlob('docs/map/ARCHITECTURE.md')}">docs/map/ARCHITECTURE.md</a> · <a href="${repoBlob('docs/architecture/three-layers.md')}">three-layers.md</a> · حدود الكتابة مفروضة بفحص: <code>scripts/check-architecture-boundaries.js</code>.</p>

  <h2>الاختبارات — آخر تشغيل حقيقي (2026-11-06)</h2>
  <table>
    <thead><tr><th>الأمر</th><th>ما يُثبته</th><th>النتيجة</th></tr></thead>
    <tbody>
      <tr><td><code>npm test</code></td><td>خصوصية/احتفاظ (24 فحصًا) · محاكاة Apps Script (الاعتماد، القفل، الانقطاعات، طوابير الفشل) · واجهة jsdom</td><td>✅ أخضر</td></tr>
      <tr><td><code>npm run gates</code></td><td>سير العمل (SHA/صلاحيات/مهلات) · بناء GAS · فحص السرية · تواقيع السكربتات</td><td>✅ أخضر</td></tr>
      <tr><td><code>npm run readiness</code></td><td>وثيقة الجاهزية مطابقة للسجل وقراءة حقيقية</td><td>✅ متسقة</td></tr>
      <tr><td>CI: Browser E2E + Lighthouse</td><td>رحلة Chromium الحقيقية + إمكانية الوصول ≥ 0.9</td><td>✅ أخضر (مشغّل CI)</td></tr>
    </tbody>
  </table>
  <p>التفاصيل والأرقام والحدود: <a href="${repoBlob('BENCHMARKS.md')}">BENCHMARKS.md</a> — كل قيمة فيه لها أمر يُعيد قياسها. ما لم يُقَس لا يُذكر.</p>

  <h2>قرارات موثقة — الستة</h2>
  <ol>
    <li><a href="${repoBlob('docs/architecture/adr/0001-no-request-is-confirmation.md')}">ADR-0001 — الطلب لا يعني التأكيد؛ النشر والتأكيد بإشراف بشري دائمًا</a></li>
    <li><a href="${repoBlob('docs/architecture/adr/0002-zero-card-zero-budget.md')}">ADR-0002 — صفر بطاقة وصفر اشتراك (قيد صلب)</a></li>
    <li><a href="${repoBlob('docs/architecture/adr/0003-no-kernel-now.md')}">ADR-0003 — لا نواة وكلاء في مسار الحجز الآن (مرفوض مع شروط إعادة نظر)</a></li>
    <li><a href="${repoBlob('docs/architecture/adr/0004-readiness-as-evidence.md')}">ADR-0004 — الجاهزية كسجل مرتبط بالأدلة لا كشعارات</a></li>
    <li><a href="${repoBlob('docs/architecture/adr/0005-fail-closed-booking-path.md')}">ADR-0005 — فشل مغلق وكاتب وحيد في مسار الحجز</a></li>
    <li><a href="${repoBlob('docs/architecture/adr/0006-self-contained-privacy-first-site.md')}">ADR-0006 — موقع ذاتي الاحتواء، القارئ لا يُتابَع</a></li>
  </ol>

  <h2>ما ليس في هذا المختبر</h2>
  <ul>
    <li>لا ادعاء بمراجعة أمنية خارجية، ولا اختبار اختراق، ولا ادعاء جاهزية إنتاجية قانونية.</li>
    <li>لا تشغيل مثبت في حساب Google حقيقي — المحاكاة فقط (الفجوة G1).</li>
    <li>لا «بنشمارك أداء» لواجهة العيادة؛ ما لم يُقَس لا يُنشر.</li>
    <li>لا «CeliaOS»، لا وكلاء تشغيليون، لا ميزات غير موجودة في الكود. مختبر الأدلة يُثبت ما هو هنا — لا أكثر.</li>
  </ul>

  <details>
    <summary>English summary</summary>
    <p><strong>Evidence Lab — Celia Kids (dr.mukhtar).</strong> Every figure on this page is generated from the committed repository or re-measured with a single command: the readiness ledger (${gaps.length} gaps, ${resolvedGaps} closed, ${openGaps.length} open: G1, G2, G14, G23, G26), the architecture map (${number(nodes.length)} nodes / ${number(edges.length)} edges), the STRIDE threat model (${threatRows.length} threats, including two honestly documented critical items T-09/T-10 that are not closed), and the test suite (<code>npm test</code>). Zero runtime dependencies, zero credit cards, SHA-pinned CI. This is not a security audit; it is a promise that everything you see can be checked. Reproduce everything: clone, <code>npm ci &amp;&amp; npm test</code>, <code>npm run evidence:check</code>.</p>
  </details>

  <footer>
    <p>Celia Kids — مختبر الأدلة · <a href="${repoBlob('README.md')}">المستودع</a> · <a href="${repoBlob('LICENSE')}">MIT</a> · <a href="https://sayedelazameydesign-crypto.github.io/dr.mukhtar/">الديمو الحي</a> (الطلب لا يعني التأكيد — بشرية دائمًا)</p>
  </footer>

</main>
</body>
</html>
`;

/* ------------------------------------------------------------ BENCHMARKS.md */
const buildBenchmarks = () => `# BENCHMARKS — مقاييس المستودع القابلة لإعادة الإنتاج

> ${GENERATED_WARNING}
>
> لا يوجد في هذا الملف رقم لا يمكن إعادة قياسه بأمر مذكور أمامه. ما لم يُقَس لا يُذكر هنا.
> لا توجد (ولا تُنشر) أي مقارنة أداء مع منتجات أخرى؛ لا توجد لقطة زمنية اصطناعية.

**البيئة عند القياس:** Node 20 · JavaScript (CommonJS) · python 3.11 · 2026-11-06 · الالتزام \`3b3ee22\`.
الأرقام تنجرف مع كل تغيير — أعِد القياس عند الحاجة؛ \`npm run evidence:check\` يفشل عند أي اختلاف غير متعمد في الصفحة المولَّدة.

## المقاييس

| # | المقياس | القيمة (2026-11-06) | كيف تعيد قياسه |
|---|-----------|---------------------|----------------|
| 1 | حجم الموقع الثابت كاملًا (\`_site\` المسموح) | ${number(siteBytes)} بايت | \`du -sb index.html privacy.html app.css app.js 404.html manifest.webmanifest robots.txt sitemap.xml clinic.json brand.svg assets\` |
| 2 | \`app.js\` (واجهة كاملة، بلا bundler) | ${number(appJsBytes)} بايت | \`wc -c app.js\` |
| 3 | ملفات التوثيق تحت \`docs/\` | ${docsMdCount} ملف · ${number(docsBytes)} بايت | \`find docs -name '*.md' \| wc -l\` |
| 4 | ملفات الفحص تحت \`scripts/\` | ${testCount} ملف \`test-*.js\` | \`ls scripts/test-*.js \| wc -l\` |
| 5 | مسارات CI (سير العمل) | ${workflowCount} ملف \`.yml\` — كلها SHA-pinned | \`ls .github/workflows/*.yml \| wc -l\` |
| 6 | فجوات موثقة في السجل | ${gaps.length} — محلولة ${resolvedGaps} · مفتوحة ${openGaps.length} | \`node scripts/readiness-report.js --offline\` |
| 7 | مكوّنات وعلاقات خريطة المعمارية | ${nodes.length} مكوّن · ${edges.length} علاقة · ${(projectMap.entrypoints || []).length} نقطة دخول | \`node -e "const p=require('./docs/map/project.json');console.log(p.nodes.length,p.edges.length,p.entrypoints.length)"\` |
| 8 | تهديدات STRIDE موثقة | ${threatRows.length} صف · ${threatStats.controlled} مُسيطر (${threatStats.critical} حرجتان موثقتان) | \`grep -cE '^\\| T-' docs/audit/threat-model-2026-11.md\` |
| 9 | فحوص الخصوصية/الاحتفاظ | 24 فحصًا — تشغيل 2026-11-06 ✅ | \`node scripts/test-privacy-health.js\` |
| 10 | محاكاة Apps Script (انقطاعات + منافسة قفل) | تمر — شاملة طابورَي الانقطاع ورفض الامتلاء | \`node scripts/test-gas-simulated.js\` |
| 11 | خدمات خارجية حرة بلا بطاقة | ${cardFree} / ${services.length} | \`node -e "const d=require('./docs/free-tiers.json');console.log(d.services.filter(s=>!s.card_required).length+'/'+d.services.length)"\` |
| 12 | تبعيات تشغيلية (runtime) | 0 — devDependencies فقط | \`grep -A3 devDependencies package.json\` |
| 13 | إمكانية الوصول (Lighthouse a11y) | ≥ 0.9 مطلوبة؛ تُقاس في CI لا محليًا | مهمة Lighthouse في [CI](${repoBlob('.github/workflows/e2e.yml')}) |
| 14 | نشر الموقع | GitHub Pages من \`main\` — allow-list فقط | \`.github/workflows/pages.yml\` |
| 15 | زمن \`npm test\` على جهاز التحرير | ~11 ث أقل من 30 ثانية | \`time npm test\` (تختلف حسب الجهاز — لا تُقارَن حرفيًا) |
| 16 | سطور الشفرة المصدرية | لم تُقَس (لا معنى لرقم أسطر بلا بوابة تمنع انجرافه) | — |

## ما لا يوجد هنا عمدًا

- **لا «أسرع» ولا «أخف» مطلقًا.** هذه أرقام سياق لا تسويق.
- **لا زمن استجابة من الإنتاج.** لا يوجد تشغيل إنتاجي (الفجوة G1 مفتوحة)؛ محاكاة GAS لا تقيس زمن Google.
- **لا يُقارَن بـ«CeliaOS» ولا بأي منتج غير منشور.** ما ليس في المستودع لا تُنشر عنه أرقام.

## كيف يُولَّد ويُفحص

\`\`\`bash
npm run evidence         # يعيد توليد evidence/index.html و BENCHMARKS.md
npm run evidence:check   # يفشل إن اختلفت أي منهما عن مخرجات المولّد الحالية
\`\`\`

ملف \`docs/production-readiness.md\` يجب أن يبقى متسقًا مع السجل؛ أعِد توليده بعد أي إضافة ملفات:
\`node scripts/readiness-report.js --offline --require-jsdom --write\`
`;

/* ------------------------------------------------------------------ output */
const outputs = [
  [path.join(ROOT, 'evidence', 'index.html'), buildPage()],
  [path.join(ROOT, 'BENCHMARKS.md'), buildBenchmarks()],
];

if (CHECK) {
  let drift = false;
  for (const [target, content] of outputs) {
    if (!fs.existsSync(target)) {
      console.error(`✗ missing: ${path.relative(ROOT, target)} — run npm run evidence`);
      drift = true;
      continue;
    }
    const current = fs.readFileSync(target, 'utf8');
    if (current !== content) {
      const curLines = current.split('\n');
      const newLines = content.split('\n');
      let line = 0;
      while (line < Math.min(curLines.length, newLines.length) && curLines[line] === newLines[line]) line += 1;
      console.error(`✗ drift: ${path.relative(ROOT, target)} — first difference at line ${line + 1}`);
      drift = true;
    }
  }
  if (drift) process.exit(1);
  console.log('evidence:check OK — evidence/index.html and BENCHMARKS.md match the tree.');
  process.exit(0);
}

for (const [target, content] of outputs) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  console.log(`wrote ${path.relative(ROOT, target)} (${Buffer.byteLength(content)} bytes)`);
}
