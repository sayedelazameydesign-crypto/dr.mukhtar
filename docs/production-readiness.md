# Production Readiness — مصفوفة الأدلة (G1–G10)

> **القياس في:** ٢٠٢٦-١١-٠٥ · الفرع `arena/8ebde25c-dr-mukhtar` · `main` = `12e4a6d`
> **قاعدة:** كل سطر هنا ناتج أمر شُغّل فعلًا أو ملف فُحص. لا يوجد PASS بلا دليل، و**لا يوجد تحويل
> لـBLOCKED إلى PASS** بسبب غياب أداة.

## الحكم الحالي: **NOT PRODUCTION READY**

السبب الرئيسي ليس عيبًا في الكود: **التشغيل الحقيقي داخل حساب Google لم يحدث** (G5, G9, G10)،
والهوية السريرية للعيادة لم تُدخل بعد. البقية قابلة للإصلاح وقد أُصلح منها ثلاثة في هذه الجولة.

---

## المصفوفة

| البوابة | الحالة | الدليل (أمر/ملف) | ملاحظة |
| --- | --- | --- | --- |
| **G1 Build** | 🟡 **PARTIAL** | `python3 scripts/build-gas-package.py` → `Built gas/ (176,796 bytes)` | حزمة Apps Script تُبنى. لا يوجد «بناء» للموقع (ملفات ثابتة)، والتحقق من التجميع في `pages.yml` |
| **G2 Tests** | 🟡 **PARTIAL** | ١٢ بوابة خضراء (أسفل) | الاختبارات كلها **محاكاة**؛ لا اختبار تكامل مع Google حقيقي |
| **G3 Static checks** | ✅ **PASS** | `check-settings-parity`, `scan-secrets` (٧٥ ملفًا/١١ قاعدة/٠ نتيجة), `check-config` | لا TypeScript في المشروع؛ `python3 -m py_compile` في CI |
| **G4 Security** | 🟡 **PARTIAL** | `scan-secrets` أخضر، لكن **٨ ملفات كانت تُنشر للعامة** وفُصلت الآن + اختبار يمنع الرجوع | الأسرار سليمة؛ كان الخطر في **ما يُنشر** لا في القيمة |
| **G5 Data safety** | ❌ **BLOCKED** | لا نسخة احتياطية ولا استعادة مُختبرة لـ Sheets/Calendar | يحتاج حسابًا حقيقيًا — خارج قدرة الوكيل |
| **G6 Configuration** | 🟡 **PARTIAL** | `check-config` (٣٦ مفتاحًا)، `check-workflows` (٧ أسرار/٨ متغيّرات) | إعداد الإنتاج موثّق؛ **قيم العيادة غير مُدخلة** |
| **G7 Observability** | 🟡 **PARTIAL** | `Audit` sheet + `logEvent_` + تحذيرات اللوحة | لا فحص صحة (health check) ولا تنبيه عند فشل المشغّل |
| **G8 Recovery** | 🟡 **PARTIAL** | rollback = `git revert` + إعادة نشر Pages؛ `docs/exit-plan.md` | لا خطة استعادة لبيانات Sheets بعد تلفها |
| **G9 User flow** | ❌ **BLOCKED** | `node scripts/go-live-check.js` → «ليس جاهزًا للتشغيل» | المسار مُثبت في المتصفح (jsdom) لا في حساب حقيقي |
| **G10 Deployment** | 🟡 **PARTIAL** | موقع GitHub Pages منشور ومُتحقَّق (`?cb=12e4a6d`) | **Apps Script لم يُنشر قط**؛ لوحة الإعدادات الحقيقية لم تُستخدم |

---

## البوابات المحلية — نتيجة تشغيل فعلي

| الأمر | النتيجة | Exit |
| --- | --- | --- |
| `node scripts/check-workflows.js` | `Secrets contract OK — 7 secrets, 8 variables; 3 workflows` | 0 |
| `node scripts/check-workflows.js --self-test` | `Contract self-test passed: 16 cases` | 0 |
| `node scripts/scan-secrets.js` | `75 text files, 11 rules, 0 findings` | 0 |
| `node scripts/check-config.js` | `Config OK — 36 keys validated` | 0 |
| `node scripts/check-settings-parity.js` | `15 fields match, prices round-trip, profile ships services` | 0 |
| `node scripts/test-gas-simulated.js` | `passed: …daily per-number cap` | 0 |
| `node scripts/test-llm-adapter.js` | `15 tests` | 0 |
| `node scripts/test-google-bridge.js` | `29 tests` | 0 |
| `node scripts/test-setup-github.js` | `Setup checker tests passed: 4 cases` | 0 |
| `node scripts/test-go-live-check.js` | `14 checks` | 0 |
| `node scripts/test-ui-smoke.js` (jsdom) | `UI smoke test passed` | 0 |
| `node scripts/test-published-clinic.js` (jsdom) | `20 checks` | 0 |
| `node scripts/test-demo-availability.js` | `PASS` | 0 |
| `node scripts/test-publish-contract.js` | `Publish contract passed: 49 checks` | 0 |
| `python3 scripts/build-gas-package.py` | `Built gas/ (176,796 bytes Index.html, 475,498 bytes Fonts.html)` | 0 |

> ⚠️ الاختبارات الثلاثة الخاصة بالمتصفح تحتاج jsdom و`NODE_PATH=/tmp/node_modules`؛ **بدونهما
> تفشل الآن صراحةً** ولا تُبلَّغ كنجاح. هذا تغيير مُتعمَّد هذه الجولة (كانت تخرج بـ`exit 0`
> وتطبع SKIPPED). وقد شُغّلت الثلاثة فعليًا بـ jsdom@25: `UI smoke passed` · `20 checks` · `PASS`.

### حكم الجهوزية الفعلي (`go-live-check.js`)

| النتيجة | العدد | البنود |
| --- | --- | --- |
| ✓ جاهز | **5** | عقود سير العمل والأسرار · مسح الأسرار · تطابق الإعدادات · محاكاة الخادم · الواجهة في متصفح |
| ✗ يحتاج إجراء | **4** | اسم العيادة · هاتف العيادة · اسم الطبيب · رقم الترخيص |
| ? غير مُتحقَّق | **4** | الموقع المنشور (شبكة الرمل لا تصل إليه) · الخادم في حساب Google · حماية `main` · بروفة الموجة B |

**الحكم: ليس جاهزًا للتشغيل.** الأربعة «يحتاج إجراء» بيانات عيادة لا يملكها الوكيل ولا يجوز أن يخترعها.

---

## ما أُصلح في هذه الجولة

| # | العيب | الدليل قبل | الإصلاح | الدليل بعد |
| --- | --- | --- | --- | --- |
| P0-1 | **نشر ملفات داخلية للعامة** | `pages.yml` كان ينسخ المستودع كله (deny-list) → `Code.gs`, `Llm.gs`, `Settings.gs`, `.env.example`, `build-gas-package.py`, `app.config.ts` + **سجلّان طرفيان بحجم ٨٦ كيلوبايت** + صورة ملصقة ٧٢ كيلوبايت كانت تُنشر على موقع عام | allow-list صريحة في `pages.yml`، وحذف الملفات الأجنبية من المستودع، وفحص في `check-workflows.js` يرفض أي ملف داخلي في قائمة النشر | `✗ Code.gs is internal but appears in the publish list` عند إدخال الخلل عمدًا |
| P1-1 | **اختبار متخطّى يبدو ناجحًا** | `SKIPPED` + `exit 0` في اختبار المتصفح | `exit 1` افتراضيًا، والتخطي يحتاج `CELIA_ALLOW_SKIP_UI=1` صراحةً، و`require.resolve('jsdom')` في CI | `SKIPPED-WITH-FAILURE … exit=1` |
| P1-2 | تقرير الجهوزية كان يعدّ الاختبار المتخطّى «جاهزًا» أو «غير متحقق» | `add(..., skipped ? 'unverified' : 'ready')` | صار **«يحتاج إجراء»**، والاستثناء الوحيد بتفويض صريح | `✗ يحتاج إجراء الواجهة في متصفح` |
| P2-1 | **`GROQ_API_KEY` معلن بلا مستهلك** | يظهر في `.env.example` و`docs/secrets.md` كأنه مطلوب | موثّق كـ«اسم محجوز» في `docs/secrets.md §1b` مع سبب صريح | — |
| P2-2 | **نسخة مكررة من سكربت البناء** | `build-gas-package.py` في الجذر **يختلف** عن `scripts/build-gas-package.py` ومخرجاته خاطئة (`parents[1]`) | حُذفت | `ls build-gas-package.py` → غير موجود |
| P2-3 | `.env.example` في الجذر = ملف عام | كان يُنشر | نُقل إلى `config/.env.example`، والفحص يقبل الموضعين | `Secrets contract OK` |
| P2-4 | `test-demo-availability.js` كان يتخطى بصمت أيضًا | `SKIPPED … exit 0` | نفس القاعدة: `exit 1` إلا بتفويض صريح | `no-jsdom exit=1` |
| P2-5 | `actionlint` يُتخطى بتحذير إن غاب (G13) | `::warning::` | يُجلب إصدارًا مثبّتًا `1.7.7` ويفشل إن فشل | `yaml valid` |
| P2-6 | وثيقة النشر تقول «ستة عناصر» | أقدم من القائمة الفعلية | صُحّحت إلى العناصر العشرة + سبب التحوّل | `grep "ستة عناصر"` → لا نتيجة |
| P2-7 | لا اختبار يحمي قائمة النشر | — | `scripts/test-publish-contract.js` (٤٩ فحصًا) في CI | إدخال خلل مرّتين → `exit 1` |

---

## ما يبقى مفتوحًا (ولا يُغلق من هنا)

| # | البند | لماذا | من يغلقه |
| --- | --- | --- | --- |
| G5 | نسخة احتياطية واستعادة لـ Sheets/Calendar | يحتاج حسابًا حقيقيًا | ⟦أنت⟧ — `docs/go-live.md §3` خطوة B-6 |
| G7 | فحص صحة وتنبيه للمشغّل | يحتاج نشرًا وتشغيلًا | ⟦الوكيل⟧ في الموجة ٣ (مشغّلات) |
| G9/G10 | التشغيل الحقيقي | لم يُنفَّذ قط | ⟦أنت⟧ — سبع خطوات البروفة |
| — | بيان العيادة (اسم/هاتف/طبيب/ترخيص) | بيانات لا تُخترع | ⟦أنت⟧ — `clinic.json` أو لوحة الإعدادات (بعد B) |
| — | حماية `main` | جلسة الوكيل لا تملك صلاحية الإدارة | ⟦أنت⟧ — `sh scripts/bootstrap-github.sh` |

---

## كيف تُعاد هذه المصفوفة

```bash
# ١) البوابات المحلية (لا تحتاج شبكة ولا حسابًا)
node scripts/check-workflows.js && node scripts/check-workflows.js --self-test
node scripts/scan-secrets.js && node scripts/check-config.js && node scripts/check-settings-parity.js
node scripts/test-gas-simulated.js && node scripts/test-llm-adapter.js && node scripts/test-google-bridge.js
npm i --no-save --prefix /tmp jsdom
NODE_PATH=/tmp/node_modules node scripts/test-ui-smoke.js
NODE_PATH=/tmp/node_modules node scripts/test-published-clinic.js
NODE_PATH=/tmp/node_modules node scripts/test-demo-availability.js

# ٢) الحكم النهائي (يشمل الموقع المنشور وبيانات العيادة)
NODE_PATH=/tmp/node_modules node scripts/go-live-check.js
```
