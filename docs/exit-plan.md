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
| GitHub Actions CI | `.github/workflows/ci.yml` + `e2e.yml` | تشغيل البوابات محليًا (`npm run gates` + `sh scripts/pre-commit.sh` + `node scripts/test-ui-smoke.js`) أو runner ذاتي؛ يكفي لرجر واحدة لكن يُفقد التشغيل على كل دفعة | 2–4 ساعات | required checks وإشارة الدمج التلقائية على الـPR |
| CodeQL | `.github/workflows/codeql.yml` | Semgrep CE محليًا (`semgrep --config p/javascript --config p/security-audit`) أو مراجعة يدوية مُوثقة قبل كل إصدار؛ لا يوجد إلا في الذاكرة المؤسسية للكود | 2–4 ساعات + ضبط الإيجابيات الكاذبة | لوحة Security → Code scanning وتواريخ المسح |
| Renovate | `renovate.json` | Dependabot للإصدارات (رفع `open-pull-requests-limit` فوق الصفر) أو تحديث شهري يدوي (`npm outdated` + PR) | 15–30 دقيقة | تجميع PRs وquarantine الـ7 أيام |
| Dependabot | `.github/dependabot.yml` | Renovate `vulnerabilityAlerts.enabled=true` (مزود واحد للمهمتين) | 30 دقيقة | تنبيهات GitHub الأصلية وربطها بـGHSA |
| OSV-Scanner | `.github/workflows/osv-scan.yml` | `npm audit --audit-level=high` (موجود في `ci.yml`) + مراجعة GHSA يدويًا قبل كل إصدار | 30 دقيقة | تغطية قواعد OSV عبر اللغات وفحص الشجرة كاملة |
| zizmor | `.github/workflows/zizmor.yml` | `actionlint` + عقد `scripts/check-workflows.js` + قائمة مراجعة يدوية للأذونات والحقن (جدول `docs/audit/threat-model-2026-11.md`) | 1 ساعة | تغطية حديثة/عميقة بلا صيانة |
| OpenSSF Scorecard | `.github/workflows/scorecard.yml` | قائمة مراجعة يدوية ببنود Scorecard لكل ربع سنة؛ أو حذف الأسبوعية والاكتفاء بالتقييم عند الإصدار | 30 دقيقة لكل مراجعة | التقييم الآلي التاريخي والشارة |
| Release Please | `.github/workflows/release-please.yml` + `release-please-config.json` | رفع `version` في `package.json` + إدخال يدوي في `CHANGELOG.md` + `git tag vX.Y.Z && gh release create` | 15 دقيقة لكل إصدار | اشتقاق الإصدار من سجل الـcommits |
| Playwright (Chromium) | `e2e/` + job `e2e` في `e2e.yml` | `scripts/test-ui-smoke.js` (jsdom) — موجود ويعمل بلا متصفح | 0 (موجود) | تغطية متصفح حقيقي وRTL/لوحة مفاتيح |
| Lighthouse CI | job `lighthouse` + `.lighthouserc.json` | فحص يدوي قبل كل إصدار (Lighthouse في Chrome على الجهاز) | 0 | بوابة a11y ≥0.9 على كل PR |
| gitleaks | خطوة CI مثبتة بـSHA | `scripts/scan-secrets.js` (بلا تبعيات، يعمل دائمًا) + GitHub secret scanning العام (مجاني للعام) | 0 | قواعد كشف ثانية وتقارير SARIF |
| Branch protection | إعداد المستودع (لا كود) | لا بديل تقني عن الحماية نفسها؛ أضعف بديل: التزام مراجعة موظف ثانٍ قبل كل دمج + CI إلزامي ثقافيًا | n/a | ضمان أن `main` لا يتغير دون فحص أخضر — يُفقد بالكامل بغيابها |
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
