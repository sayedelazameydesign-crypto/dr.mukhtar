# نموذج التهديد — dr.mukhtar · دفعة ٢٠٢٦‑١١

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
| TB7 | مراقبة → نقطة الصحة | `?token=` → `doGetHealth` | `Code.gs:537` |

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
| T-07 | Info disclosure | تسريب بيانات ولي الأمر في السجلات | `logEvent_` | السجلات تحمل أحداثًا وعدّادات فقط | `Code.gs:124` | **مُسيطَر** — مثبت باختبار · 'health is green on a healthy clinic and carries no personal data' | 
| T-08 | Info disclosure | بيانات ولي الأمر في التقويم | `createEvent` | الوصف يحمل المرجع فقط + «بيانات طبية: غير محفوظة» | `Code.gs:646` | **مُسيطَر** · 'result never claims confirmation' | 
| T-09 | Info disclosure | نقطة الصحة تُسرّب قائمة الطلبات | `doGetHealth` | رمز إلزامي + مقارنة ثابتة الزمن + عدّادات فقط | `Code.gs:537`, `Code.gs:992` | **ثغرة مؤكدة** — انظر T-10 |
| T-10 | **Spoofing — ثغرة مؤكدة** | **مقارنة ثابتة الزمن لا تقارن الطول**: بادئة صحيحة تُقبل | `constantTimeEquals_` | لا شيء | `Code.gs:992` | **حرج** — يفتح `doGetHealth` بادئة الرمز، و`verifyStaffPin_` ببادئة البصمة (انظر §4) |
| T-11 | DoS | إغراق بوابة الحجز بطلبات | `createRequest` | سقف ٣ طلبات/رقم/يوم | `Code.gs:305` | **مُسيطَر جزئيًا** — لا حدّ على عدد الأرقام |
| T-12 | DoS | استنزاف حصة Gemini | `llmBudgetReserve_` | حصة يومية وساعية + دائرة قطع | `Llm.gs:161` | **مُسيطَر** · 'a hung slot read falls back instead of spinning' | 
| T-13 | Elevation | استدعاء دالة موظف من الصفحة العامة | `google.script.run` | كل دالة موظف تتحقق من الرمز أولًا | `Code.gs:626` | **مُسيطَر** — لكن `deleteOwnRequestData` بلا رمز عن قصد (تصميم) · 'the correct PIN is refused while the lock is armed' | 
| T-14 | Elevation | حقن `<`/`>` في الاسم | `validateRequest_` | تنقية + `textContent` في الواجهة | `Code.gs:1004` | **مُسيطَر** · 'phone never rendered in result' | 
| T-15 | Info disclosure | `HEALTH_TOKEN` في رابط يُسجَّل في سجلات الوسيط | `?token=` | لا شيء — الرمز في الـURL | `Code.gs:540` | **مخاطرة قائمة** — يُفضَّل ترويسة أو مسار غير مسجَّل |
| T-16 | Repudiation | حذف بيانات ولي الأمر بلا أثر | `deleteOwnRequestData` | يُبقي صف التدقيق، ويمحو الاسم والهاتف | `Settings.gs:646` | **مُسيطَر** · 'deletion blanks name and phone but keeps the administrative trail' | 

---

## ٣. ما لم يُغطَّ

| البند | السبب |
| --- | --- |
| سلسلة توريد GitHub Actions | مثبّتة بـSHA، لكن لا مراجعة لكل إصدار |
| Apps Script نفسه (منصة Google) | خارج نطاق سيطرتنا |
| WhatsApp Cloud API | الوضع `off`؛ عند التفعيل يلزم نموذج تهديد منفصل |
| الاستدلال بالبصمة الزمنية | لم يُقس؛ المحاكاة لا تُنتج زمنًا حقيقيًا |

---

## ٤. الثغرة المؤكدة — تفصيل

```
Code.gs:992
function constantTimeEquals_(a, b) { let result = 0; for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i); return result === 0; }
```

الحلقة تدور على **طول `a`** فقط. إن كان `a` بادئة صحيحة لـ`b`، لا تُفحص بقية `b` إطلاقًا، والنتيجة `true`.

**إثبات (نُفِّذ فعلًا):**

```
$ node -e "… same function …"
prefix of real accepted? true
equal accepted? true
wrong shorter than stored? false
```

**الأثر:**
1. `doGetHealth` (`Code.gs:540`): من يعرف بادئة `HEALTH_TOKEN` يحصل على عدّادات الصحة.
2. `verifyStaffPin_` (`Settings.gs:163`): إن كان `candidate` بصمةً مُدخلة (64 حرفًا) فالبادئة تُقبل —
   أي أن أي بادئة صحيحة لبصمة الرمز تفتح بوابة الموظف. والرمز الحقيقي ١٦+ حرفًا، فالفضاء لا يزال
   كبيرًا، لكن هذا **يتجاوز الحماية كلها** إن تسرّبت أي بادئة.

**السيطرة المقترحة:** مقارنة الطول أولًا ثم حلقة على طول ثابت، مع اختبار يفشل قبل الإصلاح:
`'a prefix of the secret is not accepted'` في `scripts/test-privacy-health.js`.

**الحالة:** مفتوحة كـ**G25** بانتظار إصلاح + اختبار.

---

## ٥. كيف تُقرأ هذه الوثيقة

```bash
node scripts/check-audit-doc.js        # كل دليل هنا موجود فعلًا؟
node scripts/test-privacy-health.js    # ينفّذ جزءًا من هذه السيطرة
```

«مُسيطَر» هنا تعني: يوجد كود يمنع التهديد واختبار يثبته. «مخاطرة قائمة» تعني: الكود لا يمنعه،
والمخاطرة مقبولة الآن أو تحتاج قرارًا. لا صف يقول «مؤمَّن» بلا دليل.
