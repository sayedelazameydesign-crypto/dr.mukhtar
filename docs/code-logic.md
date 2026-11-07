# منطق الكود — الفكرة إلى تعليمات يفهمها الكمبيوتر، على هذا المستودع

> هذه الصفحة تربط عناصر منطق الكود الاثني عشر بالملفات **الفعلية** التي تنفّذها، وتذكر
> **أين يختلف المنطق هنا عن النموذج العام** — لأن الاختلافات في هذا المشروع مقصودة، ولها سبب.
>
> كل مسار أدناه مأخوذ من الكود في `main` (`Code.gs` · `Settings.gs` · `app.js`) مع رقم الدالة،
> ومقابله اختبار قابل للتشغيل. **معيار بلا اختبار = وعد.**

## المعادلة الأساسية كما طُبِّقت

```
INPUT      ولي الأمر: نوع الزيارة · اليوم · الوقت · الاسم · الهاتف · موافقة
   ↓
VALIDATE   validateRequest_  →  ثم  isSlotAvailable_  (تقويم + دوام + إغلاق)
   ↓
DECIDE     الطلب يُقبل كـ PENDING_APPROVAL أو REQUESTED (لا تأكيد)
   ↓
EXECUTE    requestsSheet_().appendRow  →  أو  queueOutageRequest_ عند الانقطاع
   ↓
VERIFY     العيادة: approveRequest → إعادة فحص → createEvent → CONFIRMED
   ↓
OUTPUT     publicBooking_ (بلا بيانات زائدة) + سجل Audit لمن قرأ وقراره
```

## العناصر الاثنا عشر → أين هي في الكود

| # | العنصر | التنفيذ هنا | الاختبار الذي يثبته |
| --- | --- | --- | --- |
| ١ | **Problem** | `AGENTS.md §1`: طلب موعد لولي أمر، و**قرار بشري** هو الطريق الوحيد للتأكيد. لا بيانات طبية | `test-privacy-health` (لا PII في المخرجات) |
| ٢ | **Input** | `payload` من النموذج: `visitType · guardianName · phone · day · time · consent` (`app.js` → `createRequest`) | `test-ui-smoke` (المسار كاملًا) |
| ٣ | **Data Structure** | صفّ واحد في `Requests` باثني عشر عمودًا (`CK.REQUEST_HEADERS`)، و`Audit` سبعة، و`Closures` خمسة؛ التحويل ذهابًا وعودة `requestToRow_` / `rowToRequest_` | `test-gas-simulated` (قراءة/كتابة الصفوف) |
| ٤ | **Validation** | `validateRequest_`: موافقة إلزامية، نوع زيارة من كتالوج الإعداد (لا نص حر)، اسم ≥٢، أرقام الهاتف ≥٨، `YYYY-MM-DD` + `HH:MM`، ومستقبلي فعلًا | `test-gas-simulated` (رفض كل حالة)، `test-clinic-schema` (أرقام الهاتف) |
| ٥ | **Algorithm** | `getAvailableSlots`: من `WORK_START` إلى آخر بداية تسمح بانتهاء الزيارة قبل `WORK_END`، بخطوة `SLOT_MINUTES`، مع `paddedStartIndex_` لزيارة ٤٥ دقيقة على شبكة ٣٠ | `test-demo-availability` + `test-ui-smoke` |
| ٦ | **Conditions** | `isSlotAvailable_`: يوم عمل؟ داخل الدوام؟ إغلاق؟ تقاطع مع حدث؟ — ثم في الموافقة **إعادة الفحص** بذات الشروط | `test-gas-simulated` (تعارض، إغلاق، منافسة) |
| ٧ | **Loops** | بناء الشبكة الزمنية، قراءة كل الصفوف، تفريغ طوابير الانقطاع (`syncOutageQueue_`)، ودفعة الاحتفاظ (`purgeExpiredRequests_`) | `test-privacy-health` (الاحتفاظ) · `test-gas-simulated` (الطوابير) |
| ٨ | **Functions** | حدود واحدة لكل مزوّد: `llmAnswer_` · `whatsappNotify_` · `getCalendar_` · `*Sheet_` — تبديل مزوّد = ملف واحد (`docs/exit-plan.md`) | `test-llm-adapter` · `test-whatsapp-adapter` · `test-google-bridge` |
| ٩ | **Execution** | `LockService.tryLock(25000)` حول كل كتابة؛ `appendRow` أو الطابور؛ `calendar.createEvent` **فقط** داخل الموافقة | `test-gas-simulated` (قفل، فشل جزئي، إعادة محاولة) |
| ١٠ | **Output** | `publicBooking_` يعيد سبعة حقول فقط؛ الواجهة لا تعرض الهاتف ولا تدّعي تأكيدًا | `test-ui-smoke` («لا يدّعي التأكيد»، «الهاتف لا يظهر») |
| ١١ | **Error Handling** | أخطاء مصنَّفة (`CONFIG_INVALID` …)، `logEvent_` بصيغة JSON بلا PII، طابور انقطاع محدود، `auditBestEffort_`، وحالة `REQUESTED` عند تعذّر التقويم | `test-gas-simulated` (انقطاع Sheets/Calendar/Audit) · `test-privacy-health` |
| ١٢ | **Testing** | ٢٦ بوابة محلية + `clinic-ready` + `go-live-check` + `readiness-report` | `ci.yml` (كلها تعمل في كل PR) |

## أين يختلف النموذج العام عن هذا المشروع — ولماذا

النموذج الشائع يقول: «هل الموعد متاح؟ نعم → سجّل → **أرسل التأكيد**». هنا **يُمنع ذلك**:

```
استقبال البيانات
   ↓
التحقق  ──(خطأ)──→ رسالة عربية واحدة تُسمّي السبب (بلا تفاصيل داخلية)
   ↓
فحص التقويم ──(تعذّر)──→ REQUESTED  «التقويم غير متاح؛ الطلب محفوظ كتفضيل»
   ↓
حفظ الطلب (أو طابور الانقطاع)  ← لا يوجد أي حدث في التقويم بعد
   ↓
PENDING_APPROVAL  (ولي الأمر يرى: «بانتظار موافقة العيادة»)
   ↓
موظف + رمز  →  approveRequest
   ↓
إعادة فحص التوفر ← قد يفشل الآن ويُرفض بوضوح
   ↓
createEvent ثم CONFIRMED  ← التأكيد يحدث هنا فقط
   ↓
WhatsApp يدوي (اختياري، مطفأ افتراضيًا) + سطر في Audit
```

**أربعة قرارات لا تُخترق** (وهي مغطّاة باختبارات، لا بنوايا):

1. لا `CONFIRMED` بلا فعل بشري **و** حدث تقويم محفوظ.
2. الكاش (٣٠ ثانية) يخدم القراءة فقط، ولا يُستخدم في قرار الموافقة — ويُبطَل لليوم الملموس.
3. كل كتابة تحت قفل، وإعادة الفحص بعد القفل (حالة سباق مغطّاة باختبار).
4. لا بيانات صحية في أي حقل أو سجل أو رابط.

## ميثاق المراجعة — خمسة عناصر لكل سطر (بأدلة حقيقية من الكود)

هذا هو الجرد الكامل لسلسلة التنفيذ. عمود **Evidence** يذكر **نص التحقق حرفيًا** كما هو مكتوب
في ملف الاختبار، بحيث تستطيع التحقق منه بأمر واحد بدل تصديق الجدول:

```bash
grep -rn "نص التحقق" scripts/
```

**قاعدة الصياغة:** نصوص التحقق المنقولة حرفيًا بين `'…'` (كما في ملفات الاختبار)؛ علامات `«…»`
محفوظة للنثر العربي ولسياسات المشروع. فحص آلي يتحقق من كل نص منقول بهذه الطريقة:

```bash
node scripts/check-doc-evidence.js   # يفشل إن تغيّر اسم اختبار ولم تتغير الصفحة
```

| # | Function | Input | Logic (القرار) | Output | Evidence (نص التحقق) |
| --- | --- | --- | --- | --- | --- |
| ١ | `createRequest(payload)` · `Code.gs:300` | `visitType · guardianName · phone · day · time · consent` | قفل → سقف ٣ طلبات/رقم/يوم → منع طلب مفتوح مكرر → `isSlotAvailable_` → حفظ | `{ok, booking, savedLocally, warning}` | `test-gas-simulated.js`: 'three rows for that number and day are counted' · 'the fourth request that day is refused' |
| ٢ | `validateRequest_(payload)` · `Code.gs:993` | نفس الحقول | موافقة إلزامية · نوع من كتالوج الإعداد · اسم ≥٢ · هاتف ≥٨ أرقام · `YYYY-MM-DD`+`HH:MM` · مستقبلي · تنقية `<`/`>` | كائن نظيف أو `Error` عربي واحد | `test-gas-simulated.js` (مسار الحجز) + `test-clinic-schema.js` (أرقام الهاتف ٤٥ فحصًا) |
| ٣ | `isSlotAvailable_(day,time,dur,excludeId)` · `Code.gs:1046` | يوم · وقت · مدة · حدث مستثنى | مستقبلي · يوم عمل · داخل الدوام · محاذاة الشبكة · نهاية قبل `WORK_END` · لا إغلاق · لا تقاطع حدث | `true/false` فقط | `test-gas-simulated.js`: 'a closed day is a valid day with no slots' · `test-demo-availability.js` |
| ٤ | `getAvailableSlots(day,type)` · `Code.gs:218` | يوم · نوع زيارة | كاش ٣٠ث للقراءة فقط → شبكة بخطوة `SLOT_MINUTES` → `paddedStartIndex_` يمنع بداية تتجاوز الإغلاق | `{slots:[…]}` | `test-gas-simulated.js`: 'the primed list offers 10:00' |
| ٥ | `approveRequest(ref,pin)` · `Code.gs:625` | مرجع · بصمة الرمز | رمز → قفل → الطلب ليس من الطابور → حالة تسمح → **إعادة فحص** → `createEvent` → `CONFIRMED` | `{ok, booking, warning}` | `test-gas-simulated.js`: 'overlapping approval is rejected while the script lock is held' |
| ٦ | `invalidateSlotCacheFor_(day)` · `Code.gs:63` | يوم | إبطال مفاتيح اليوم لكل خدمة (وليس كل الكاش) | `test-gas-simulated.js`: 'the approved time disappears from the cached slot list' |
| ٧ | `queueOutageRequest_(record)` · `Code.gs:1114` | طلب | حد ٢٥ طلبًا و٨٠٠٠ بايت، وإلا خطأ صريح | مفتاح `CKQ_*` في Script Properties | `test-gas-simulated.js` ('request-queue-full rejection') |
| ٨ | `auditBestEffort_(…)` · `Code.gs:1167` | مرجع · فاعل · فعل · من/إلى | يكتب في `Audit`، وإن فشل يضع في طابور التدقيق (حد ١٠٠) | `true/false` — يُبلَّغ للموظف | `test-gas-simulated.js`: 'the approval was written to the Audit sheet' · 'queued audit is written when Sheets returns' |
| ٩ | `publicBooking_(record)` · `Code.gs:1092` | سجل داخلي | تقليص إلى ٧ حقول (لا شيء زائد) | كائن عام | `test-ui-smoke.js`: 'result never claims confirmation' · 'phone never rendered in result' |
| ١٠ | `lookupOwnRequest / deleteOwnRequestData` · `Settings.gs` | مرجع · **هاتف** | تطابق الهاتف أولًا (المرجع ليس اعتمادًا) → رفض إن كان في الطابور → رفض إن كان الحدث قائمًا → محو الاسم والهاتف وإبقاء التدقيق | `{ok, booking}` / رسالة رفض | `test-privacy-health.js`: 'deletion blanks name and phone but keeps the administrative trail' · 'a live calendar appointment blocks deletion until it is cancelled' |
| ١١ | `healthCheck_() / getHealthReport(pin)` · `Code.gs` | لا شيء / رمز | إعداد · Sheets · تقويم · طوابير · رمز مؤقت · احتفاظ · آخر فحص | تقرير بلا أي بيانات شخصية | `test-privacy-health.js`: the health report flags unsafe retention and carries no personal data · 'the staff health endpoint refuses a bad PIN' |
| ١٢ | `purgeExpiredRequests_()` · `Code.gs` | إعدادا `RETENTION` و`RETENTION_MONTHS` | متوقف افتراضيًا؛ المسار القديم عند تفعيله غير جاهز ويحتاج معالجة انقطاع التقويم والتداخل والنسخ الاحتياطي | متوقف أو عدد المحذوف/الفاشل | `test-privacy-health.js`: اختبار التوقف الافتراضي والمسار القديم بالمحاكاة فقط |
| ١٣ | `verifyStaffPin_(candidate)` · `Settings.gs` | بصمة SHA-256 | قفل بعد ٥ محاولات/١٥ دقيقة · مقارنة ثابتة الزمن · ترقية الرمز النصي القديم | `true/false` | `test-gas-simulated.js` (قفل، ترقية، إعادة تعيين) · `test-ui-smoke.js`: 'the PIN can be rotated from the UI' |

### ما لا يثبته أي من هذه الأدلة

| الادعاء | الحقيقة |
| --- | --- |
| «الكود موجود ⇒ الوظيفة تعمل» | المحاكاة تستبدل Sheets/Calendar/Cache. السلوك الحقيقي يحتاج حساب Google (G1) |
| «الاختبار أخضر ⇒ النظام منشور» | Apps Script لم يُنشر قط (المرحلة ١٥ 🟡) |
| «النشر نجح ⇒ التشغيل سليم» | المرحلة ١٦ تبقى `NOT VERIFIED` حتى تظهر `live.appsScript` PASS من تشغيل حقيقي |
| «المراجعة الآلية ⇒ مراجعة أمنية» | لا مراجعة أمنية خارجية ولا مراجعة قانونية (قانون ١٥١/٢٠٢٠) |

## سلسلة الإصلاح الآلي — وكيف تُقرأ أدلتها

النظام الجديد لا يضيف منطق حجز، بل يضيف **طريقة إثبات** حول المنطق القائم. صفحاته:

| المرحلة | الملف | ما يقرره | ما يرفضه |
| --- | --- | --- | --- |
| مسح | `scripts/ci-error-scanner.js` | تصنيف كل خطوة فاشلة | أن يُقرأ إلغاء كفشل، أو تخطٍّ كنجاح |
| تشخيص | `scripts/ai-root-cause.js` | السبب مع أدلة | أي ملف/دالة/سطر لا وجود له في المستودع |
| اقتراح | `scripts/ai-repair.js` | Patch صغير | ثقة منخفضة، تصنيف لا يُصلح بالكود |
| حماية | `scripts/ai-patch-guard.js` | قبول/رفض الـPatch | المسارات المحمية، الأسرار، التنفيذ، الحذف |
| فصل صلاحيات | `.github/workflows/ai-repair.yml` | من يملك المفتاح، من يكتب | جمع المفتاح مع صلاحية الكتابة |

التوثيق الكامل بجدول القرارات وأدلة كل سطر: `docs/ai-repair.md`.

```bash
node scripts/test-ai-repair.js           # 14 فحصًا: السلسلة + حدود الصلاحيات
node scripts/ci-error-scanner.js --self-test
```

## كيف تقرأ المنطق بنفسك في دقيقتين

```bash
sed -n '/^function createRequest/,/^}/p' Code.gs     # INPUT → VALIDATE → EXECUTE
sed -n '/^function approveRequest/,/^}/p' Code.gs    # DECIDE → VERIFY → OUTPUT
sed -n '/^function validateRequest_/,/^}/p' Code.gs  # الشروط
sed -n '/^function isSlotAvailable_/,/^}/p' Code.gs  # التقويم مقابل الدوام
node scripts/test-gas-simulated.js                   # هل نفّذه بشكل صحيح؟
```

> **قاعدة الفرق الثلاثة:** الخوارزمية هنا مكتوبة في `docs/prd/flows.md` (١٤ رحلة) و
> `booking-states.md` (آلة الحالات). منطق الكود هو التنفيذ أعلاه. والاختبارات هي التي تمنح
> الحق في قول «يعمل» — لا قراءة الكود.
