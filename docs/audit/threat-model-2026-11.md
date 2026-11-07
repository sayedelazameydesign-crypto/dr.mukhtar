# نموذج التهديد — dr.mukhtar · دفعة ٢٠٢٦‑١١

> آخر تصحيح: 2026-11-06 — أُعيدت كتابة صفّي T-09 وT-10 وقسم ٤ بعد التحقق من الكود والفحوص: كانت الوثيقة تُظهرهما كقابلتين للاستغلال بعد إغلاقهما فعليًا على `main`. كل ادعاء في هذه الوثيقة يتبع الكود، لا نيةً سابقة.

> **الطريقة:** STRIDE على حدود الثقة، بسطور من الكود لا بوصف عام. كل صف يحمل **دليلًا** على شكل
> `ملف:سطر`؛ البوابة `scripts/check-audit-doc.js` ترفض أي دليل لا وجود له في المستودع.
>
> **حدود هذه الوثيقة:** كُتبت بمراجعة كود يدوية + أدوات، **ولا تُعدّ مراجعة أمنية خارجية**.
> لا اختبار اختراق، ولا تحليل ثنائي، ولا مراجعة قانونية. ما هنا قابل للتحقق، لا كامل.
>
> **الأداة المستخدمة:** منهج [grim-prompter](https://github.com/jmanico/grim-prompter) (36 مسار عمل،
> 29 مطالبة تحليل). لم تُشغَّل المهارة داخل هارنس هنا؛ استُخدم إطارها (حدود الثقة → STRIDE → سيطرة
> قائمة → تقدير) وطُبّق يدويًا، وهذا مذكور بصراحة بدل الإيهام بأنها شُغّلت.

---

## ١. حدود الثقة

| # | الحد | من → إلى | الدليل |
| --- | --- | --- | --- |
| TB1 | الإنترنت → صفحة الحجز | متصفح ولي الأمر → `app.js` | `index.html:1`, `app.js:421` |
| TB2 | صفحة → Apps Script | `google.script.run` → دوال `Code.gs` | `app.js:421`, `Code.gs:300` |
| TB3 | Apps Script → Sheets | `requestsSheet_()` / `Audit` | `Code.gs:1085` |
| TB4 | Apps Script → Calendar | `createEvent` | `Code.gs:646` |
| TB5 | Apps Script → Internet | `UrlFetchApp` (WhatsApp / Gemini) | `WhatsApp.gs:242`, `Llm.gs:40` |
| TB6 | موظف → لوحة | رمز PIN → أفعال الموظف | `Settings.gs:150` |
| TB7 | مراقبة → الصحة | `doGetHealth` مساعد غير مربوط بـHTTP؛ `?health=liveness` عام وثابت فقط | `Code.gs:537` |

---

## ٢. التهديدات والسيطرة القائمة

| ID | STRIDE | التهديد | الموقع | السيطرة القائمة | الدليل | التقييم |
| --- | --- | --- | --- | --- | --- | --- |
| T-01 | Spoofing | رمز موظف ضعيف/افتراضي يُخمَّن | بوابة الموظف | حد أدنى ١٦ حرفًا ورفض `2468` + قفل بعد محاولات | `Code.gs:988`, `Settings.gs:180` | **مُسيطَر جزئيًا** — الحساب مشترك بلا هوية فردية (G17) |
| T-02 | Spoofing | رمز PIN صحيح يُستخدم من عدة أشخاص | `isStaff_` | رمز واحد للعيادة | `Code.gs:986` | **مقبول مؤقتًا** — لا أدوار ولا تتبّع فردي |
| T-03 | Spoofing | نفاد محاولات PIN يُقفل العيادة (حرمان) | `staffPinLocked_` | القفل على مستوى السكربت كله | `Settings.gs:180` | **مخاطرة قائمة** — مهاجم يستطيع قفل الموظفين |
| T-04 | Tampering | تغيير حالة طلب عبر إعادة الإرسال | `approveRequest` | قفل + إعادة فحص الحالة + التحقق من الحدث | `Code.gs:630` | **مُسيطَر** · 'overlapping approval is rejected while the script lock is held' | 
| T-05 | Tampering | تعديل صفوف Sheets يدويًا | ورقة `Requests` | لا شيء — مالك الجدول يستطيع كل شيء | `Code.gs:1085` | **مقبول** — خارج نموذج التهديد، يُدار بالوصول للحساب |
| T-06 | Repudiation | لا يُعرف أي موظف فعل ماذا | `Audit` | `staffActor_()` — لكن الهوية رمز مشترك | `Code.gs:646` | **مُسيطَر جزئيًا** |
| T-07 | Info disclosure | تسريب بيانات ولي الأمر في السجلات | `logEvent_` | السجلات تحمل أحداثًا وعدّادات فقط | `Code.gs:124` | **مُسيطَر** — مثبت باختبار · 'health flags the unsafe legacy retention path and carries no personal data' |
| T-08 | Info disclosure | بيانات ولي الأمر في التقويم | `createEvent` | الوصف يحمل المرجع فقط + «بيانات طبية: غير محفوظة» | `Code.gs:646` | **مُسيطَر** · 'result never claims confirmation' | 
| T-09 | Info disclosure | كشف تفاصيل الصحة أو قائمة الطلبات | `doGetHealth` | مساعد برمز ولا يوجد مسار HTTP له؛ `liveness` ثابت لا يفحص بيانات العيادة | `Code.gs:537`, `Code.gs:999` | **مخاطرة قائمة** — اختبارات محلية فقط؛ لا تفترض جاهزية مراقبة خارجية |
| T-10 | Spoofing | مقارنة ثابتة الزمن لا تقارن الطول — بادئة صحيحة تُقبل (تاريخيًا) | `constantTimeEquals_` | مقارنة الطول أولًا (غير سرّية: بصمة PIN دائمًا ٦٤ حرفًا) ثم حلقة كاملة ثابتة الزمن | `Code.gs:999`, `scripts/test-privacy-health.js:454` | **مُسيطَر** — مثبت باختبار 'a prefix of the secret is not accepted' و'a prefix of the staff PIN digest does not unlock the dashboard' · الإغلاق G25 |
| T-11 | DoS | إغراق بوابة الحجز بطلبات | `createRequest` | سقف ٣ طلبات/رقم/يوم | `Code.gs:305` | **مُسيطَر جزئيًا** — لا حدّ على عدد الأرقام |
| T-12 | DoS | استنزاف حصة Gemini | `llmBudgetReserve_` | حصة يومية وساعية + دائرة قطع | `Llm.gs:161` | **مُسيطَر** · 'a hung slot read falls back instead of spinning' | 
| T-13 | Elevation | استدعاء دالة موظف من الصفحة العامة | `google.script.run` | كل دالة موظف تتحقق من الرمز أولًا | `Code.gs:626` | **مُسيطَر** — لكن `deleteOwnRequestData` بلا رمز عن قصد (تصميم) · 'the correct PIN is refused while the lock is armed' | 
| T-14 | Elevation | حقن `<`/`>` في الاسم | `validateRequest_` | تنقية + `textContent` في الواجهة | `Code.gs:1004` | **مُسيطَر** · 'phone never rendered in result' | 
| T-15 | Info disclosure | `HEALTH_TOKEN` في رابط يُسجَّل في سجلات الوسيط | `?token=` | لا شيء — الرمز في الـURL | `Code.gs:540` | **مخاطرة قائمة** — يُفضَّل ترويسة أو مسار غير مسجَّل |
| T-16 | Repudiation | حذف بيانات ولي الأمر بلا أثر | `deleteOwnRequestData` | يُبقي صف التدقيق، ويمحو الاسم والهاتف | `Settings.gs:646` | **مُسيطَر** · 'deletion blanks name and phone but keeps the administrative trail' |
| T-17 | Tampering | نص خارجي يبدأ بعلامة صيغة يُكتب في Sheets | `createRequest` | رفض أولي لاسم ولي الأمر والهاتف اللذين يبدآن بـ`=`؛ لا حماية شاملة لمسارات الكتابة أو البيانات القديمة | `Code.gs:1251`, `Code.gs:411` | **مخاطرة قائمة** — G27؛ اختبار محلي فقط، واختبار Google لم يُنفّذ |

---

## ٣. ما لم يُغطَّ

| البند | السبب |
| --- | --- |
| سلسلة توريد GitHub Actions | مثبّتة بـSHA، لكن لا مراجعة لكل إصدار |
| Apps Script نفسه (منصة Google) | خارج نطاق سيطرتنا |
| WhatsApp Cloud API | الوضع `off`؛ عند التفعيل يلزم نموذج تهديد منفصل |
| الاستدلال بالبصمة الزمنية | لم يُقس؛ المحاكاة لا تُنتج زمنًا حقيقيًا |

---

## ٤. الثغرة المؤكدة — أُغلقت قبل هذا التحديث

**الاكتشاف الأصلي** (أثناء كتابة هذا النموذج، G25): الحلقة كانت تدور على **طول المرشّح `a`** فقط. إن كان `a` بادئة صحيحة لـ`b`، لا تُفحص بقية `b` إطلاقًا، والنتيجة `true`.

```js
// الشكل القديم (تاريخي) — Code.gs قبل الإصلاح
function constantTimeEquals_(a, b) { let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
```

**الأثر الأصلي (تاريخي):**
1. `doGetHealth` (`Code.gs:537`) — بادئة `HEALTH_TOKEN` كانت تكفي لقراءة عدّادات نقطة الصحة.
2. `verifyStaffPin_` (`Settings.gs:163`) — بادئة من ٣٢ حرفًا من ٦٤ (بصمة الرمز) كانت تفتح بوابة الموظف.

**الإغلاق الفعلي (موجود على `main` الآن):**
1. المقارنة الآن **تُقارن الأطوال أولًا** (طول بصمة PIN ثابت ٦٤ حرفًا — لا يفشي السر) ثم تُدور الحلقة على **كامل السلسلة** — `Code.gs:999`.
2. ثلاثة فحوص تفشل على الكود القديم وتنجح على الجديد (`scripts/test-privacy-health.js:454`، `:464`، `:472`):
   - `a prefix of the secret is not accepted`
   - `a prefix of the health token does not open the uptime endpoint`
   - `a prefix of the staff PIN digest does not unlock the dashboard`
3. **G25 → محلول** في السجل بأدلته (`docs/map/gaps.json`) — وهذا التحديث يُصحّح الوثيقة التي ظنت نفسها تفصّل ثغرة مفتوحة.

**ما يبقى قائمًا:** الرمز في رابط URL للصحة (T-15) — موثق وقائم كما هو.

---

## ٥. كيف تُقرأ هذه الوثيقة

```bash
node scripts/check-audit-doc.js        # كل دليل هنا موجود فعلًا؟
node scripts/test-privacy-health.js    # ينفّذ جزءًا من هذه السيطرة
```

«مُسيطَر» هنا تعني: يوجد كود يمنع التهديد واختبار يثبته. «مخاطرة قائمة» تعني: الكود لا يمنعه،
والمخاطرة مقبولة الآن أو تحتاج قرارًا. لا صف يقول «مؤمَّن» بلا دليل.
