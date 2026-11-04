# Celia Kids — استقبال مواعيد الأطفال · إصدار 2026

واجهة عربية (RTL) لطلب مواعيد عيادة أطفال واحدة، مبنية على مبدأ واحد: **الطلب لا يعني التأكيد**.
ولي الأمر يختار نوع الزيارة واليوم والوقت، ثم يراجع فريق العيادة الطلب بشريًا ويؤكده قبل إنشاء
الحدث في Google Calendar.

لا تُجمع أي بيانات طبية: الاسم ورقم التواصل ووقت مفضل فقط.

---

## ما الجديد في إصدار 2026

| المحور | 2025 (MVP) | 2026 |
| --- | --- | --- |
| الواجهة | صفحة واحدة بطابع تقليدي | نظام تصميم كامل: طبقات زجاجية، هالات متحركة، بطاقة تقويم حيّة، شريط ثقة، خطوات مرقّمة |
| الخطوط | خط النظام | خطوط عربية **مستضافة محليًا** (Almarai + IBM Plex Sans Arabic) بلا أي طلب لشبكة خارجية |
| التغذية الراجعة | نصوص مباشرة | Toast، نتائج متحركة، عدّاد عربي، أرقام وحالات مفهومة، نسخ الرقم المرجعي بضغطة |
| الوصول | أساسي | Skip link، `aria-live`، `aria-pressed`، تركيز واضح، احترام `prefers-reduced-motion` و`prefers-contrast` |
| الأداء | CSS/JS عاديّان | `defer` + تحميل مسبق للخطوط + كاش قراءة قصير (30 ثانية) لأوقات التقويم لتقليل حصة Google |
| النشر | GitHub Pages يدويًا | سير عمل جاهز في `.github/workflows/pages.yml` |
| حزمة Google | CSS/JS مضمّنة | بناء واحد يضمّن **الخطوط** أيضًا داخل HtmlService، ويهيّئ الـmanifest والـfavicon |
| الجودة | محاكاة Apps Script | محاكاة + فحص DOM آلي للواجهة (`scripts/test-ui-smoke.js`) + بناء حزمة موثّق |

---

## بنية الملفات

```
index.html                  واجهة الموقع (RTL)
app.css                     نظام التصميم الكامل (متغيرات، مكوّنات، استجابة، وصول)
app.js                      منطق الواجهة: عرض تجريبي + جسر google.script.run
assets/fonts/               خطوط woff2 مستضافة محليًا + تراخيصها
brand.svg                   الهوية البصرية
manifest.webmanifest        إضافة إلى الشاشة الرئيسية (PWA-lite)
Code.gs                     خادم Google Apps Script
appsscript.json             صلاحيات ونطاق زمني Africa/Cairo
scripts/build-gas-package.py   بناء gas/Index.html + gas/Fonts.html
scripts/test-gas-simulated.js  محاكاة Sheets/Calendar/Lock دون شبكة
scripts/test-ui-smoke.js       فحص DOM لمسار الحجز ولوحة العيادة
.github/workflows/pages.yml    نشر الواجهة على GitHub Pages
```

المجلد `gas/` **مُولَّد ولا يُحفظ في Git**؛ أعِد بناءه بأمر البناء أدناه.

---

## تشغيل محلي

```bash
python3 -m http.server 3000 --bind 0.0.0.0
```

ثم افتح `http://localhost:3000`. الواجهة تعمل في **وضع العرض التجريبي**: البيانات تُحفظ في
`localStorage` لهذا المتصفح فقط، ورمز الموظف التجريبي `2468` (غير صالح لأي تشغيل حقيقي).
وضع العرض يتيح تجربة المسار كاملًا: طلب موعد → تتبع الرقم المرجعي → قبول/رفض/اقتراح وقت بديل
→ إغلاق يوم.

## الاختبارات

```bash
node scripts/test-gas-simulated.js   # منافسة المواعيد، فشل Sheets/Calendar/Audit، طوابير الانقطاع
node scripts/test-ui-smoke.js        # بناء DOM كامل: حجز، تتبع، دخول اللوحة، سؤال إداري
python3 scripts/build-gas-package.py # بناء حزمة Apps Script
```

`test-ui-smoke.js` يعمل عبر `jsdom`، وإن لم يكن مثبتًا يطبع تعليمات التثبيت ويتوقف بلطف.

## النشر على GitHub Pages

سير العمل `pages.yml` ينشر جذر المستودع عند كل دفع إلى `main`.
من **Settings → Pages** اختر **GitHub Actions** كمصدر. للتفعيل من سطر الأوامر بعد الدمج:

```bash
gh api -X POST repos/sayedelazameydesign-crypto/dr.mukhtar/pages -f source.branch=main -f source.path=/
```

الواجهة المنشورة تعمل في وضع العرض التجريبي فقط. الربط بالعيادة الحقيقية يتم عبر Apps Script.

---

## إعداد نسخة Google (مجانية)

> الحصص المجانية لخدمات Google قابلة للتغيير وليست بلا حدود. لا تتضمن هذه النسخة WhatsApp Cloud API
> ولا خادمًا مدفوعًا.

1. أنشئ Google Sheet، ثم **Extensions → Apps Script** لإنشاء سكربت مرتبط (أو سكربت مستقل مع
   `CELIA_SHEET_ID` في Script Properties).
2. أضف `Code.gs`، ثم شغّل `python3 scripts/build-gas-package.py` وأضف:
   - `gas/Index.html` باسم **Index**
   - `gas/Fonts.html` باسم **Fonts** (الخطوط المضمّنة، يستدعيها `<?!= include('Fonts'); ?>`)
3. فعّل إظهار `appsscript.json` وانسخ `gas/appsscript.json` (النطاق الزمني `Africa/Cairo`).
4. من **Project Settings → Script Properties**:

   | الخاصية | القيمة |
   | --- | --- |
   | `ADMIN_PIN` | سر عشوائي طويل (32 حرفًا أو أكثر) — `2468` غير صالح للإنتاج |
   | `TIMEZONE` | `Africa/Cairo` |
   | `WORK_START` / `WORK_END` | مثل `09:00` / `14:00` |
   | `SLOT_MINUTES` | مثل `30`، و`NEW_VISIT_MINUTES` / `FOLLOWUP_MINUTES` اختياريان |
   | `WORK_DAYS` | `0,1,2,3,4` (الأحد `0`) |
   | `CALENDAR_ID` | اختياري؛ وإلا يُنشأ تقويم `Celia Kids — عيادة الأطفال` |
   | `GEMINI_API_KEY` | اختياري، للأسئلة الإدارية فقط |
   | `GEMINI_MODEL` | افتراضي `gemini-2.5-flash` |
   | `GEMINI_DAILY_LIMIT` | افتراضي 25 سؤالًا يوميًا على مستوى المشروع |

5. شغّل `initializeCeliaKids()` مرة واحدة ووافق على صلاحيات Sheets وCalendar.
6. **Deploy → New deployment → Web app** وفق سياسة العيادة.

### ضمانات الخادم

- قفل `LockService` على كل كتابة، ومنع الحجز المزدوج عند الموافقة.
- الموافقة تُعيد فحص التوفر قبل إنشاء الحدث، وتُعيد استخدام حدث سابق عند فشل جزئي (بلا تكرار).
- إذا تعطل Sheets: طابور محدود (25 طلبًا) في Script Properties مع رفض صريح بعد امتلائه.
- إذا تعطّل Calendar: يبقى الطلب `REQUESTED` ويحتاج مراجعة يدوية.
- سجل تدقيق مستقل بطابور احتياطي، وأي فشل في تسجيله يُبلَّغ للموظف صراحةً.
- حالات مدعومة: `REQUESTED` · `PENDING_APPROVAL` · `CONFIRMED` · `RESCHEDULED` · `CANCELLED` · `COMPLETED`.

---

## الخصوصية والحدود

- لا حقول للأعراض أو التشخيص أو الملفات الطبية، والواجهة تنبّه لذلك صراحةً.
- Gemini مساعد إداري اختياري خارج مسار الحجز تمامًا؛ يرفض الأسئلة الطبية، والحجز يعمل بدونه.
- لا يُخزَّن أي مفتاح في كود المتصفح؛ كل استدعاء Gemini من Apps Script.
- قبل التشغيل الحقيقي: موافقة ولي الأمر، سياسة خصوصية وحذف، مدة احتفاظ محددة، ومراجعة مختص
  لمتطلبات حماية البيانات المصرية. رمز الموظف المشترك ليس مصادقة مؤسسية.
- في الحالات الطارئة: خدمات الطوارئ المحلية، لا هذه الواجهة.

## الترخيص

الخطوط: Almarai وIBM Plex Sans Arabic بترخيص SIL OFL 1.1 (النسخ في `assets/fonts/`).
