# الإصلاح الآلي المُقيَّد — CELIA Auto Debug & Repair

> **اقرأ هذا أولًا:** هذا النظام **يكتشف ويشخّص ويقترح**، ولا يدمج ولا ينشر ولا يعدّل `main`.
> كل تعديل يصل إلى المستودع عبر فرع مستقل + Pull Request **مسوّدة** يراجعها إنسان.
> إن لم يكن الدليل كافيًا، النظام **يرفض** ويترك التشخيص فقط. الرفض نتيجة صحيحة، وليس فشلًا.

---

## 1. لماذا وُجد

تشغيل `42169489664` فشل في خطوة `Probe the configured provider` ثم نجح عند إعادة التشغيل،
وسجلّه غير قابل للتحميل (خطأ EOF من GitHub). الدرس ليس «أعد التشغيل»: الدرس أن خطوة فاشلة
كانت تقول **جملة واحدة** لا تفرّق بين مفتاح مرفوض، وحصة مستهلكة، وطلب محجوب، وإجابة فارغة.
نظام من هذا النوع لا يُبنى على التخمين، فيُبنى على **تصنيف قابل للاختبار**.

## 2. الخلل المؤكد (وما ليس مؤكدًا)

| # | الحالة | الدليل |
| --- | --- | --- |
| 1 | **مؤكد بالكود والاختبار:** الفحص الحي كان يستدعي المزوّد متى وُجد المفتاح، متجاهلًا `LLM_SMOKE_ENABLED=false`. | `scripts/llm-smoke-probe.js` → `decide_()`؛ الاختبار `'a key with LLM_SMOKE_ENABLED=false is not used (no network call)'` |
| 2 | **مؤكد:** «إجابة فارغة» كانت تصنيفًا واحدًا يغطي ست حالات مختلفة. | `interpretBody_()` يفرّق الآن بين `blocked` / `empty-candidates` / `empty-text` / `truncated` |
| 3 | **مؤكد:** `scripts/env.js` لم يكن يُحلَّل في أي بوابة، وكان **غير قابل للتحليل** (فاصلة ناقصة). | `node scripts/check-script-syntax.js` يفشل قبل الإصلاح، ويمرّ بعده |
| 4 | **مؤكد:** إلغاء التشغيل بسبب `concurrency` لم يكن مفصولًا عن فشل حقيقي في أي تقرير. | `ci-error-scanner` يصنّف `cancelled` / `skipped` / `failure` منفصلة |
| 5 | **غير مؤكد ولن يُدّعى:** السبب المادي لفشل `42169489664` (مفتاح؟ حصة؟ شبكة؟). | لا سجل متاح. النظام الجديد يجعل التشغيل القادم **قابلًا للتشخيص**، ولا يعيد كتابة الماضي |

## 3. السلسلة — من اكتشاف إلى Pull Request

```
DETECT      ci-error-scanner.js     يقرأ التشغيلات (قراءة فقط) ويصنّف كل خطوة فاشلة
   ↓                                cancelled / skipped / failure مُفصولة، وبصمة تكرار
CLASSIFY    (نفس الملف)             ١٢ قاعدة مرتبة: auth · quota · provider-empty · timeout …
   ↓                                كل تصنيف يحمل severity + إجراءً مقترحًا
ANALYZE     ai-root-cause.js        Gemini يقترح السبب، ثم **يُدقَّق ضد المستودع**
   ↓                                ملف غير موجود ⇒ يُحذف · دالة غير موجودة ⇒ تُحذف · بلا دليل ⇒ ثقة 0
PROPOSE     ai-repair.js            يقترح Patch لا أوامر؛ والرفض هو الافتراضي
   ↓
GUARD       ai-patch-guard.js       المسارات، الحجم، الأسرار، الملفات المحمية، حذف الفحوص
   ↓
VALIDATE    ci.yml (verify job)     git apply --check ثم سلسلة الاختبارات الموجودة
   ↓
PR          ai-repair.yml (open-pr) فرع `ai-repair/<run_id>` + PR مسوّدة. لا دمج، لا نشر
   ↓
HUMAN       إنسان يراجع ويقرر
```

## 4. الخمسة عناصر لكل مرحلة

| المرحلة | Function | Input | Logic (القرار) | Output | Evidence |
| --- | --- | --- | --- | --- | --- |
| DETECT | `buildReport()` · `ci-error-scanner.js` | تشغيل + وظائف + خطوات + تعليقات | كل خطوة تُصنَّف؛ لا وظيفة بلا `jobs` تُعدّ ناجحة | JSON بـ `counts` و`complete` | `test-ai-repair.js`: 'the scan finds the real failure and not the cancelled run' |
| CLASSIFY | `classify()` | conclusion + رسالة | أول قاعدة مطابقة تفوز | severity + إجراء | 'a quota failure is its own category' / 'a timed-out step is its own category' |
| REDACT | `redact()` | أي نص | مفاتيح، JWT، بريد، هواتف مصرية | نص آمن + عدّاد | 'a phone number in a log is redacted' |
| FINGERPRINT | `fingerprint()` | وظيفة + خطوة + شكل الرسالة | الأرقام والـSHAs تُستبدل | `fp-xxxxxxxx` | 'identical shapes in different attempts share a fingerprint' |
| ANALYZE | `validateAnalysis_()` | إجابة النموذج | كل ادعاء يُتحقق منه في المستودع | تشخيص مُصنَّف `supported` / `partially-unsupported` | `ai-root-cause.js --self-test`: 'an invented file is removed and recorded' |
| PROPOSE | `preflight()` | تشخيص | ثقة ≥ 0.5 · مراجعة بشرية · تصنيف قابل للإصلاح | سماح أو رفض بسبب مسمّى | 'quota and auth failures are never repaired by patch' |
| GUARD | `checkPatch()` | نص الـPatch | ١ عدّاد: مسار/حجم/سر/محمي/تنفيذ | قبول أو قائمة مخالفات | `ai-patch-guard.js --self-test`: 16 حالة |
| VERIFY | `git apply --check` + الحزمة | Patch مقبول | لا تطبيق قبل نجاح الفحص | شجرة معدّلة + نتائج | `test-ai-repair.js`: 'apply is preceded by a check, and auto-merge is absent' |

## 5. الفصل بين الصلاحيات (الجزء الأمني الحقيقي)

| Job | المفتاح؟ | الكتابة؟ | ماذا ينفّذ |
| --- | --- | --- | --- |
| `analyse` | **نعم** (`GEMINI_API_KEY`) | **لا** (`contents: read`) | لا يشغّل كود المشروع |
| `verify` | لا | لا | يطبّق الـPatch ويشغّل الاختبارات |
| `open-pr` | لا | نعم (فرع + PR فقط) | لا يشغّل كودًا من PR، ولا يدمج |

هذه ليست تعليقات في التوثيق: `check-workflows.js` **يفشل** إن جمع job واحد مفتاحًا وصلاحية كتابة،
أو إن طبّق/ثبّت كودًا وهو يحمل المفتاح، أو إن كان `workflow_run` قادرًا على الكتابة.
الأدلة: `'a job holding the provider key and write access is rejected'`، `'a workflow_run triage job with write access is rejected'`.

كذلك: لا `pull_request_target`، ولا تشغيل كود PR في workflow بصلاحيات مرتفعة، وكل Action مثبّت
(tag رسمي أو SHA كامل) لأن `check-workflows.js` يرفض غير ذلك.

## 6. قواعد الرفض (Fail Safe)

| الحالة | النتيجة |
| --- | --- |
| تقرير المسح ناقص (تشغيل تعذّرت قراءته) | `incomplete` — لا تشخيص |
| النموذج أعاد نصًا لا JSON | `unparsable` — لا تشخيص |
| ادّعى ملفًا أو دالة غير موجودة | تُحذف من التقرير وتُسجَّل كفرضية |
| الثقة < 0.5 أو لا مراجعة بشرية | لا Patch |
| التصنيف quota / auth / network / cancelled | لا Patch — الإصلاح ليس في الكود |
| Patch يمسّ `.github/` أو `gas/` أو `clinic.json` أو صفحات الخصوصية أو أسرارًا | مرفوض |
| Patch يحذف فحصًا بلا بديل، أو يضيف `child_process`/`eval` | مرفوض |
| الاختبارات المطلوبة غير موجودة | مرفوض |

كل رفض يُطبع **بسببه**، ويُحفظ في `reports/repair-report.json`.

## 7. ما لم يُثبت بعد

| الادعاء | الحقيقة |
| --- | --- |
| «النظام يعمل على GitHub» | ملفان جديدان للـworkflow؛ **لم يُنفَّذا على GitHub بعد**، ولا سجل تشغيل لهما |
| «Gemini يعطي تشخيصًا صحيحًا» | لم يُستدعَ المزوّد في أي اختبار؛ كل الاختبارات بمزوّد وهمي |
| «إصلاح آلي أُنتج فعلًا» | لا Patch حقيقي حتى الآن — الرفض هو المسار الوحيد المُختبر |
| «فحص أمني» | لا مراجعة أمنية خارجية؛ الفصل بين الصلاحيات مُختبَر، لكن ليس ضمانًا مطلقًا |

## 8. التشغيل

```bash
# تشخيص بلا كتابة (آمن دائمًا)
node scripts/ci-error-scanner.js --fixture run.json --json reports/ci-errors.json
node scripts/ai-root-cause.js --report reports/ci-errors.json --out reports/root-cause.json
node scripts/ai-repair.js --analysis reports/root-cause.json --out-dir reports

# كل الاختبارات الذاتية
node scripts/ci-error-scanner.js --self-test
node scripts/ai-root-cause.js --self-test
node scripts/ai-patch-guard.js --self-test
node scripts/ai-repair.js --self-test
node scripts/test-ai-repair.js
node scripts/check-script-syntax.js
```

يدويًا من GitHub: **Actions → AI repair (manual, human-gated) → Run workflow** (`dry_run=true` مبدئيًا).
