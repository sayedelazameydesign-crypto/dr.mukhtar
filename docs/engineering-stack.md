# خط الأنابيب الهندسية AI-Native — `CELIA-GITHUB-ENGINEERING-STACK-001`

> **الهدف:** تمكين مطوّر واحد من إدارة وكلاء AI، صيد الثغرات قبل الإنتاج، وتحويل فكرة إلى إصدار قابل للتحقق بـ **$0/شهر** — دون Visa أو بطاقة ائتمان أو تشغيل فوترة.
>
> **قاعدة الحكم في هذا المستودع:** لا تُضاف أداة لا تغلق فجوة مسجّلة أو تقوّي بوابة موجودة أو تنتج دليلًا رسميًا. كل أداة أدناه مرتبطة بإنجاز محدد، وكل استثناء أو تنازل مكتوب هنا مع سببه.

---

## ١. الصورة الكبيرة

```
GitHub Issue (المشكلة + الهدف + معايير القبول)
        │
        ▼
AI Coding Agent — Antigravity / Copilot   (بيئة محلية للمالك، لا تعمل في CI)
        │  يُنشئ خطة وتغييرات في فرع معزول
        ▼
Pull Request ──► CodeRabbit (مراجعة AI، إن تحقق شرط المصدر المفتوح)
        │     ──► CodeQL (SAST → Security tab)
        │     ──► OSV-Scanner (ثغرات التبعيات)
        │     ──► zizmor (أمن الـActions)
        │     ──► gitleaks + scan-secrets (موجودة مسبقًا، لا تُستبدل)
        │     ──► Playwright + Lighthouse CI (تحقّق المتصفح)
        │     ──► actionlint + scripts/check-workflows.js (موجودان)
        ▼
CI Verification — `lint · typecheck · test · build · audit` (البوابة: مكتملة عبر ci.yml + e2e.yml)
        ▼
موافقة بشرية ثم الدمج  (لا دمج تلقائي من وكيل AI — أبدًا)
        ▼
Release Please  (يفتح/يحدّث PR الإصدار + CHANGELOG — الدمج يدوي)
```

ثلاث مفاهيم لا تُمس (وراثةً من `AGENTS.md`):

1. **لا دمج تلقائي.** الوكيل يقترح، الإنسان يدمج، وCI أخضر شرط مسبق.
2. **لا وصول للأسرار لوكيل يكتب الكود.** Jobs التي تحمل `GEMINI_API_KEY` لا تملك صلاحية كتابة (مفروضة في `scripts/check-workflows.js` — مع اختبار).
3. **لا نشر للعيادة دون موافقة.** النشر عبر Pages من `main` فقط، والعيادة الحقيقية عبر Apps Script بعد تجربة بشرية.

---

## ٢. ما الذي نُفِّذ في هذه الدورة، وما الذي يبقى عند المالك

### الإنجاز الأول — Developer Environment

| البند | الحالة | الدليل / الموضع |
| --- | --- | --- |
| قواعد الوكلاء (`AGENTS.md`) | ✅ موجودة ومحدّثة في هذا الإنجاز (قسم الأوامر) | `AGENTS.md` §3، والإشارة لـ`npm run e2e` |
| بيئة الوكيل الأساسية (Antigravity) | ⏸ عند المالك | تثبيت شخصي على جهازه؛ لا يصل CI |
| مساعد إضافي (Copilot Free) | ⏸ عند المالك | حساب شخصي GitHub؛ 2,000 إكمال/شهر دون بطاقة |
| عدم الاعتماد على Gemini CLI 10 | ✅ لا يوجد في المستودع | بحث كامل في `*.gs/js/yml` — لا ذكر له |
| قواعد `AGENTS.md` للدمج البشري + عدم automerge | ✅ | هذا المستند §١ · `renovate.json` (`"automerge": false`) |

### الإنجاز الثاني — Automated Engineering

| البند | الحالة | الدليل |
| --- | --- | --- |
| **GitHub Rulesets (حماية `main`)** | ⏸ **عند المالك — التوكن المرفوع لا يملك الصلاحية (403)** | الأمر الجاهز في §٥ أدناه؛ `scripts/bootstrap-github.sh` صُحِّح (السياق كان `quality` وهو job id — لا يوجد كرن check run؛ الصحيح «lint · typecheck · test · build · audit»، مع استبعاد اشتراط مراجعة مراجِع واحد لحساب منفرد + `enforce_admins=true`) |
| **Renovate** | ✅ الإعداد في المستودع — ⏸ تفعيل التطبيق عند المالك | `renovate.json` — مجمّع، أسبوعي، Africa/Cairo، quarantine 7 أيام، **بلا automerge**، و`vulnerabilityAlerts.enabled=false` (الأمن شأن Dependabot) |
| **Dependabot** | ✅ `.github/dependabot.yml` — ⏸ تفعيل «Dependabot security updates» في الإعدادات عند المالك | npm + github-actions، `open-pull-requests-limit: 0` (لا PRs إصدارات — Renovate مالكها) + cooldown 7 أيام |
| **CodeQL** | ✅ | `.github/workflows/codeql.yml` — `javascript-typescript` + `python`، `build-mode: none`، push/PR/أسبوعية، نتائج → Security tab (مجاني للمستودعات العامة) |
| **OSV-Scanner** | ✅ | `.github/workflows/osv-scan.yml` — workflow مُعاد استخدامه مثبّت بـSHA `b1d267a…`، full-tree `-r ./`، `fail-on-vuln: true`، SARIF → code scanning |
| **zizmor** | ✅ بوابة جديدة + تنظيف كامل للمستودع | `.github/workflows/zizmor.yml` — `min-confidence: medium`، SARIF؛ **كل Action (هنا وفي الـ7 workflows القائمة) مثبّت الآن على commit SHA كامل مع تعليق `# vX.Y.Z`؛ ونتائج zizmor عولجت صراحة: `artipacked` (أُضيف `persist-credentials: false` لكل checkout لا يدفع — الواقف الوحيد هو job الدفع في ai-repair)، و`excessive-permissions` (`id-token` على job النشر حصريًا، و`pages: write` على job البناء فقط لـ`configure-pages`)، و`dangerous-triggers` (استثناء موثّق inline في ci-error-triage.yml)** |
| **OpenSSF Scorecard** | ✅ | `.github/workflows/scorecard.yml` — أسبوعي + push إلى `main`، SARIF + نشر النتيجة (badge/API) عبر OIDC (`id-token: write` في الـjob فقط) |
| **Release Please** | ✅ | `.github/workflows/release-please.yml` + `release-please-config.json` + `.release-please-manifest.json` (`node`، مجمّع من الحزمة الحالية 1.0.0) — يفتح PR إصدار فقط عند commits من نوع `feat:`/`fix:`؛ **لا ينشر ولا يدمج** دون إنسان |
| gitleaks · actionlint · `scan-secrets.js` · `check-workflows.js` · `ai-patch-guard.js` | ✅ **لم تُستبدل** | بنيت عليها بدل استبدالها، كما توصي الخطة |

### الإنجاز الثالث — Verification

| البند | الحالة | الدليل |
| --- | --- | --- |
| **Playwright E2E (demo mode)** | ✅ خمس رحلات حقيقية على Chromium | `e2e/clinic.spec.mjs` + `playwright.config.mjs` + `.github/workflows/e2e.yml` (job `e2e`): حجز كامل ← «لم يتأكد» في النتيجة ولا يظهر الهاتف ← التتبع يرفض مرجعًا بلا هاتف ← PIN الموظف 2468 ← موافقة تنتقل للأسبوع ← RTL/تخطي/طوارئ/لا تسمية مزوّد نموذج؛ SHA-pinned، بيانات وهمية فقط، صفر حجوزات حقيقية |
| **Lighthouse CI** | ✅ مع بوابة a11y حقيقية | job `lighthouse` في `e2e.yml` + `.lighthouserc.json`: **a11y بوابة خطأ (≥0.9)**، وperformance/SEO/best-practices تحذير مع أرضية مسجّلة؛ desktop preset؛ filesystem upload — لا خدمة خارجية، لا بطاقة |
| **Accessibility (RTL، التركيز، القراءة)** | ✅ ضمن E2E + Lighthouse | `lang=ar`، `dir=rtl`، skip-link، طوارئ `role=note`، حسم `getByLabel` للحقول |
| **Privacy (لا تسريب هاتف)** | ✅ assert مباشر في E2E | نتيجة الحجز ونتيجة التتبع لا تحتويان الرقم أبدًا |
| **الأداء (السرعة وحجم الملفات)** | ✅ كمراقبة (warn) لا بوابة | عتبات تحذير مسجلة في `.lighthouserc.json`؛ ترقية إلى خطأ بعد قياس أول 7 تشغيلات |

### مراجعة شهرية تلقائية

`.github/workflows/monthly-tools-watch.yml` — يفتح issue بعنوان `[monthly-tools-watch] المراجعة الشهرية…` في الأول من كل شهر (06:00 UTC) مع checklist جاهزة (إعادة توثيق الحصص، `reverify_by`، أهلية CodeRabbit…). **هذا هو جواب "من سيتابع شهريًا":** الوكيل لا يعمل بين الجلسات؛ المستودع هو من يذكّر. إيقافه = حذف هذا الملف فقط.

---

## ٣. الخارطة الكاملة من الخطة (١٢ أداة + ما بعدها)

| # | الأداة | الأولوية في الخطة | قرار هذا المستودع |
| --- | --- | --- | --- |
| 1 | GitHub Rulesets | P0 | ⏸ تفعيل عند المالك (التوكن 403) — الإعداد جاهز والأمر مكتوب §٥ |
| 2 | Google Antigravity | Individual $0 | ✅ يُعتمد كواكيل أساسي (قرار المالك الشخصي)؛ لا شيء يُثبَّت في CI |
| 3 | Copilot Free | دون بطاقة | ✅ مساعد إضافي؛ الوكلاء الكاملون/مراجعة PR الكاملة **ليسا** ضمن المجانية — لا نعتمد عليهما |
| 4 | Renovate | مجاني للعام والخاص | ✅ أُعدت (`renovate.json`)؛ التفعيل متصفح-فقط |
| 5 | CodeQL | P0، مجاني للعام | ✅ §٢ |
| 6 | Gitleaks + OSV-Scanner | P0 | ✅ Gitleaks كان موجودًا وثُبّت الآن بـSHA؛ OSV أُضيف |
| 7 | zizmor | P0 | ✅ §٢ |
| 8 | Playwright | بعده Lighthouse | ✅ §٢ |
| 9 | Lighthouse CI | P1 | ✅ §٢ |
| 10 | CodeRabbit | مجاني للمصدر المفتوح المؤهل | ⏸ **مشروط**: هذا المستودع **بلا LICENSE** — أهلية OSS (وربما شروط الخطة) غير محققة؛ لا تثبيت قبل قرار المالك بالترخيص. عند الإضافة: PR فقط، بلا automerge |
| 11 | OpenSSF Scorecard | P1 | ✅ §٢ |
| 12 | Release Please | مفتوح المصدر | ✅ §٢ |
| — | Semgrep CE | P1 | ❌ مؤجَّل عمدًا: CodeQL يغطي JS/Python هنا؛ طبقة ثانية بلا فجوة مسجلة = ضجيج |
| — | Qodo | تجربة 14 يوم بلا بطاقة | ❌ مرفوض: لا توجد خطة مجانية دائمة؛ البوابات الذاتية + CodeQL + zizmor تكفي |
| — | Gemini CLI (حساب شخصي) | — | ❌ مرفوض: انتهى دعم الأفراد 2026-06-18؛ وبديله المعتمد Antigravity |
| — | CodeRabbit / Copilot Cloud / Claude-mem وشبهها | — | ❌ لا أسرار عبر خدمات مستضافة؛ لا بيانات مرضى خارج Script Properties (قاعدة المشروع) |
| — | Actions على استضافة ذاتية (self-hosted) | — | ❌ ممنوعة بقاعدة المستودع (`check-workflows.js`) |
| — | أي أداة ببطاقة | — | ❌ Zero-Card: إن ظهر حقل بطاقة تتوقف وتسجَّل وتختار البديل |

---

## ٤. Zero-Card والالتزامات

كل خدمة مذكورة أعلاه مسجّلة في `docs/free-tiers.json` (حقل `card_required: false`، وتاريخ `checked: 2026-11-06`) مع **fallback** لكل واحدة، وقيد مقابل في `docs/exit-plan.md` (استبدال كل مزوّد خلال يوم أو أقل). الأدوات OSS (Playwright، zizmor، gitleaks، actionlint) تعمل محليًا وفي CI دون أي حساب. **لا خدمة خارجية مستضافة تتلقى بيانات مرضى**؛ التقارير كلها ملفات داخل تشغيلات GitHub (artifacts)، والفحوص الأمنية تقرأ الكود فقط.

Fوترة Actions للمستودعات العامة: مجانية ضمن حدود الخطة (لا تحتسب دقائق على runners المعيارية للمستودعات العامة). Jobs النادرة (أسبوعيًا) أصغر بكثير من الحصة.

---

## ٥. ما يجب على المالك فعله — بالترتيب

> التوكن المتاح في جلسات الوكيل يملك admin على المستودع لكن **لا يملك صلاحية Administration/Dependabot/Secrets** (403 موثّق 2026-11-06). الخطوات التالية مؤكدة على حسابك في المتصفح أو `gh` من جهازك.

1. **احمِ `main`** (10 دقائق، الأمر جاهز بعد تصحيح `scripts/bootstrap-github.sh`):
   ```bash
   sh scripts/bootstrap-github.sh --no-protect   # البيئة + المتغيرات فقط (بلا أسرار اختيارية إن لم ترد)
   ```
   أو مباشرة الحماية فقط:
   ```bash
   gh api -X PUT repos/sayedelazameydesign-crypto/dr.mukhtar/branches/main/protection \
     -H "Accept: application/vnd.github+json" \
     -F "required_status_checks[strict]=true" \
     -F "required_status_checks[contexts][]=lint · typecheck · test · build · audit" \
     -F "enforce_admins=true" \
     -F "required_pull_request_reviews=null" \
     -F "restrictions=null"
   ```
   ملاحظتان عمديتان عن فرق هذا الأمر عن نسخة السكربت القديمة:
   - **السياق** هو اسم check run («lint · typecheck · test · build · audit») — كتابة `quality` كانت ستجعل الحماية **تستحيل** (لا يعمل أبدًا، فتُغلق main).
   - **لا اشتراط مراجعة مراجِع واحد**: أنت المالك والمراجِع الوحيد، واشتراط موافقة لن يقدر عليها **أحد** — ومع `enforce_admins=true` ستُغلق main نهائيًا لأي دمج. موافقتك البشرية هي الدمج نفسه. إن انضم مراجع ثانٍ يومًا ما، أعد `required_approving_review_count=1` بنفس السكربت.
   إن فضّلت **Repository Rulesets**: نفس القواعد هناك متاحة في الخطة المجانية للمستودعات العامة وتُقرأ بتوكن Actions — وهي الأسلم مستقبلًا.
2. **فعّل Dependabot security updates**: Settings → Code security → «Dependabot alerts» ثم «Dependabot security updates» (توثيق الأسعار: مجاني دائمًا، بلا بطاقة).
3. **ثبّت تطبيق Renovate** (github.com/apps/renovate) على المستودع فقط. أول run سيفتح PR «Configure Renovate» — راجعه ويكفي ذلك؛ بعدها يعمل حسب `renovate.json`.
4. **بعد أول تشغيل أخضر للـe2e**: أضف `Browser E2E (Chromium, demo mode)` و `CodeQL (javascript-typescript)` إلى نفس الحماية كفحوص مطلوبة بالطريقة نفسها (اختياري لكنه الأقوى).
5. **قرار الترخيص (`LICENSE`)**: إن أردت CodeRabbit المجاني للمصدر المفتوح، هذا قرارك وحدك (MIT/Apache-2.0؟). بدونه → لا CodeRabbit.
6. **Copilot / Antigravity**: تثبيت شخصي على جهازك، حسابك الشخصي — لا تشارك التوكنات.
7. **راقب الـissue الشهرية** `[monthly-tools-watch]`: 20 دقيقة أول كل شهر تكفي للحفاظ على $0/شهر حقيقة.

---

## ٦. التحقق — ما شُغِّل فعلًا في هذه الجلسة

```bash
node scripts/check-workflows.js   # ✅ "Secrets contract OK — 12 workflows" (تحذيرات موجودة أصلًا فقط)
zizmor --persona regular --min-confidence medium .   # ✅ No findings (قبل/بعد: 48 → 0)
npx playwright test --list        # ✅ 5 اختبارات مسجّلة (التنفيذ الفعلي على CI — المتصفح لا يُنزَّل هنا)
python3 scripts/build-gas-package.py  # ✅ gas/ تُبنى (197 KB / 475 KB) وgas/ لا تُرسَل للـgit
npm test                          # ✅ (privacy-health + gas-simulated + ui-smoke)
node scripts/readiness-report.js --offline --require-jsdom  # ✅ consistent
```

**لم يُختبر في هذه الجلسة ولماذا:**
- **تشغيل Playwright على متصفح حقيقي**: `cdn.playwright.dev` محجوب في هذه البيئة؛ التشغيل الفعلي يحدث في job `e2e` على هذا الـPR — راقبه بـ`gh pr checks`، وإن فشل يرجع بـscreenshot+trace كـartifact مرفق تلقائيًا.
- **درجة Lighthouse الحقيقية**: لا يوجد Chrome محلي هنا. البوابة مضبوطة على أ11y ≥0.9 (خطأ)؛ إن فشل CI سترى الدرجة والعنصر المسبب في التقرير المرفق — إما نُصلح العنصر أو نوجد مسمى بدليل، بلا مواربة.
- **Branch protection**: التوكن 403 — خطوة المالك §٥.
- **Runs المجدولة** (CodeQL أسبوعيًا، Scorecard أسبوعيًا، monthly issue): تُفعَّل بعد الدمج على `main`.

---

## ٧. الانحرافات الموثقة عن الخطة الأصلية

1. **كل Action مثبّت على commit SHA** (وليس "official بإصدار major" كما تقبل بوابة المستودع): طلب الخطة صراحةً SHA للاعتماديات الخارجية، و`Renovate` سيُبقي SHAs محدّثة بتعليق `# vX.Y.Z`.
2. **سياق فحص `main` الصحيح** — السكربت كان سيحبس كل دمج (انظر §٥-١).
3. **لا اشتراط مراجعة مراجِع** في الحماية — قرار هندسي لحساب منفرد (§٥-١)، ويُعاد بكل بساطة عند انضمام مراجع.
4. **Lighthouse perf/SEO بوابة تحذير لا خطأ** — لا نتحكم في تباين runners؛ أ11y هو ما يمكن فرضه بلا عشوائية.
5. **Qodo مستبعَد** (لا خطة دائمة) و**Semgrep مؤجل** (لا فجوة فوق CodeQL) و**CodeRabbit مشروط بقرار ترخيص**.
6. **`exit-plan.md`/`free-tiers.json` حُدِّثا معًا** — أي أداة خارج هذا الانقلاب تخرق عقد Zero-Card.

## ٨. حدود هذا التوثيق

- درجات Lighthouse، وعدد دقائق Actions المستهلكة شهريًا، ونجاح runs المجدولة — كلها تُقاس بعد الدمج؛ لا رقم هنا مُخترع.
- أهلية CodeRabbit OSS تتطلب قراءة شروطهم يوم التقديم مع ترخيصك — يمكن أن تكون محدودة أكثر مما نتصور.
- هذا المستودع ليس فيه بعد طلب حقيقي واحد إلى التقويم (G1) — الخط الأنابيبي يجعل وصوله آمنًا، لا أسرع بالضرورة.
