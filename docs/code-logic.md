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
