# Exit plan — كل مزوّد يمكن استبداله في أقل من يوم

الهدف: لا يوجد مزوّد واحد يحتجز المشروع. كل خدمة خارجية معزولة خلف ملف أو دالة واحدة،
والانتقال يعني تعديل ذلك الملف فقط دون لمس منطق الحجز.

| المزوّد | نقطة العزل في الكود | الانتقال إلى البديل | الزمن التقديري | ما يُفقد |
| --- | --- | --- | --- | --- |
| GitHub Pages | `_site/` + `.github/workflows/pages.yml` | ربط نفس المستودع بـ Cloudflare Pages أو Netlify؛ لا تغيير في الكود | 15 دقيقة | لا شيء (ملفات ثابتة) |
| Google Apps Script | `Code.gs` + جسر `api()` في `app.js` | إعادة تنفيذ الدوال العامة (`createRequest`, `getDashboard`, `approveRequest` …) على Node خلف نفس أسماء الوسائط، واستبدال `callServer` بنداء `fetch` | 4–8 ساعات | حدود المجانية (20k طلب/يوم) وفوترة Google — لكن لا صيانة مشروع Apps Script |
| Google Sheets | `requestsSheet_`, `auditSheet_`, `closuresSheet_`, `readAllRequests_`, `findRequest_` | نفس الواجهات على Turso/SQLite عبر طبقة SQL؛ الأعمدة موجودة في `CK.REQUEST_HEADERS` | 1 يوم | لا شيء إذا حُفظ الترحيل |
| Google Calendar | `getCalendar_`, `findCalendarEvent_`, `isSlotAvailable_`, `makeDate_` | CalDAV أو مزوّد تقويم آخر بنفس الواجهات (getEvents/createEvent/deleteEvent/setTime) | 1 يوم | التزامن المفاجئ مع تقويم الطبيب |
| Gemini | `Llm.gs` فقط (`LLM.PROVIDERS`) | إضافة مزوّد جديد (`groq` مثلاً) وتغيير `LLM_CHAIN`؛ لا تغيير في `Code.gs` | 1–2 ساعة | حدود المزوّد المجانية |
| WhatsApp (يدوي) | `whatsappLink()` في `app.js` | تبديل صيغة الرابط أو فتح تطبيق آخر | 15 دقيقة | لا شيء |
| WhatsApp Cloud API | `WhatsApp.gs` وحده (`whatsappNotify_`) | إرجاع `WHATSAPP_MODE=off` (يعود الرابط اليدوي فورًا) أو استبداله بمزوّد BSP بنفس الواجهة | 30 دقيقة | الإشعارات الآلية فقط؛ الحجز لا يتأثر |

## خطوات الانتقال الآمنة

1. شغّل `node scripts/test-gas-simulated.js` و`node scripts/test-llm-adapter.js` على نسخة الفرع قبل التبديل.
2. بدّل مزوّد **واحدًا فقط** لكل نشر، مع إبقاء القديم متاحًا للرجوع.
3. تحقق من: حجز جديد → مرجع → موافقة → حدث تقويم → إلغاء. لا تُعلن النجاح قبل هذه الدورة.
4. حدّث `docs/free-tiers.json` بتاريخ الفحص الجديد.
5. الرجوع = إعادة نشر الوسم السابق (`git tag` لكل إصدار).

## بيانات الخروج

- **Sheets:** تصدير `Requests` و`Audit` و`Closures` بصيغة CSV من القائمة `File → Download`. لا توجد نسخ
  احتياطية تلقائية في الخطة المجانية — صدّر أسبوعيًا إلى ملف مشفّر في مستودع خاص أو Drive.
- **Calendar:** `Settings → Export calendars` (.ics) كافٍ لإعادة الاستيراد.
- **Script Properties:** لا تُصدَّر تلقائيًا؛ دوّن **أسماء** المفاتيح فقط (وليس القيم) في
  `docs/ops.md` عند إنشائه، حتى يمكن إعادة بناء الإعداد على المنصة الجديدة.
