# BENCHMARKS — مقاييس المستودع القابلة لإعادة الإنتاج

> GENERATED FILE — لا تحرّره يدويًا. عدّل scripts/build-evidence-page.js ثم شغّل: npm run evidence
>
> لا يوجد في هذا الملف رقم لا يمكن إعادة قياسه بأمر مذكور أمامه. ما لم يُقَس لا يُذكر هنا.
> لا توجد (ولا تُنشر) أي مقارنة أداء مع منتجات أخرى؛ لا توجد لقطة زمنية اصطناعية.

**البيئة عند القياس:** Node 20 · JavaScript (CommonJS) · python 3.11 · 2026-11-06 · الالتزام `3b3ee22`.
الأرقام تنجرف مع كل تغيير — أعِد القياس عند الحاجة؛ `npm run evidence:check` يفشل عند أي اختلاف غير متعمد في الصفحة المولَّدة.

## المقاييس

| # | المقياس | القيمة (2026-11-06) | كيف تعيد قياسه |
|---|-----------|---------------------|----------------|
| 1 | حجم الموقع الثابت كاملًا (`_site` المسموح) | 580,176 بايت | `du -sb index.html privacy.html app.css app.js 404.html manifest.webmanifest robots.txt sitemap.xml clinic.json brand.svg assets` |
| 2 | `app.js` (واجهة كاملة، بلا bundler) | 109,677 بايت | `wc -c app.js` |
| 3 | ملفات التوثيق تحت `docs/` | 39 ملف · 527,889 بايت | `find docs -name '*.md' | wc -l` |
| 4 | ملفات الفحص تحت `scripts/` | 17 ملف `test-*.js` | `ls scripts/test-*.js | wc -l` |
| 5 | مسارات CI (سير العمل) | 12 ملف `.yml` — كلها SHA-pinned | `ls .github/workflows/*.yml | wc -l` |
| 6 | فجوات موثقة في السجل | 26 — محلولة 21 · مفتوحة 5 | `node scripts/readiness-report.js --offline` |
| 7 | مكوّنات وعلاقات خريطة المعمارية | 151 مكوّن · 95 علاقة · 22 نقطة دخول | `node -e "const p=require('./docs/map/project.json');console.log(p.nodes.length,p.edges.length,p.entrypoints.length)"` |
| 8 | تهديدات STRIDE موثقة | 16 صف · 12 مُسيطر · 0 حرجة مفتوحة | `grep -cE '^\| T-' docs/audit/threat-model-2026-11.md` |
| 9 | فحوص الخصوصية/الاحتفاظ | 24 فحصًا — تشغيل 2026-11-06 ✅ | `node scripts/test-privacy-health.js` |
| 10 | محاكاة Apps Script (انقطاعات + منافسة قفل) | تمر — شاملة طابورَي الانقطاع ورفض الامتلاء | `node scripts/test-gas-simulated.js` |
| 11 | خدمات خارجية حرة بلا بطاقة | 23 / 23 | `node -e "const d=require('./docs/free-tiers.json');console.log(d.services.filter(s=>!s.card_required).length+'/'+d.services.length)"` |
| 12 | تبعيات تشغيلية (runtime) | 0 — devDependencies فقط | `grep -A3 devDependencies package.json` |
| 13 | إمكانية الوصول (Lighthouse a11y) | ≥ 0.9 مطلوبة؛ تُقاس في CI لا محليًا | مهمة Lighthouse في [CI](https://github.com/sayedelazameydesign-crypto/dr.mukhtar/blob/main/.github/workflows/e2e.yml) |
| 14 | نشر الموقع | GitHub Pages من `main` — allow-list فقط | `.github/workflows/pages.yml` |
| 15 | زمن `npm test` على جهاز التحرير | ~11 ث أقل من 30 ثانية | `time npm test` (تختلف حسب الجهاز — لا تُقارَن حرفيًا) |
| 16 | سطور الشفرة المصدرية | لم تُقَس (لا معنى لرقم أسطر بلا بوابة تمنع انجرافه) | — |

## ما لا يوجد هنا عمدًا

- **لا «أسرع» ولا «أخف» مطلقًا.** هذه أرقام سياق لا تسويق.
- **لا زمن استجابة من الإنتاج.** لا يوجد تشغيل إنتاجي (الفجوة G1 مفتوحة)؛ محاكاة GAS لا تقيس زمن Google.
- **لا يُقارَن بـ«CeliaOS» ولا بأي منتج غير منشور.** ما ليس في المستودع لا تُنشر عنه أرقام.

## كيف يُولَّد ويُفحص

```bash
npm run evidence         # يعيد توليد evidence/index.html و BENCHMARKS.md
npm run evidence:check   # يفشل إن اختلفت أي منهما عن مخرجات المولّد الحالية
```

ملف `docs/production-readiness.md` يجب أن يبقى متسقًا مع السجل؛ أعِد توليده بعد أي إضافة ملفات:
`node scripts/readiness-report.js --offline --require-jsdom --write`
