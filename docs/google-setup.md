# جسر Google — `docs/google-setup.md`

> سياسة `google-bridge.md`: Zero-Card · حساب واحد قابل للتبديل · بلا لمس البطاقة · مراجعة كل 30 يومًا.
> هذا الملف يشرح **ما تفعله أنت في المتصفح** و**ما يشغّله الوكيل/CI**، ولا يطلب قيمة سرّية ولا يطبعها.

## 0 | الحالة الحالية

| العنصر | القيمة |
| --- | --- |
| البروفايل الفعّال | `dev` (`GOOGLE_PROFILE=dev`) |
| الحساب | حساب المطوّر الحالي (`sayedelazameydesign`) — **للتطوير والاختبار فقط** |
| الوضع الافتراضي | `GOOGLE_AUTH_MODE=local` → لا يحتاج أي اعتماد، وهذا ما يعمل عليه CI |
| ما لم يُنشأ بعد | مجلدات Drive، الورقة، `config/google.profile.json`، الأسرار الخمسة على GitHub |
| حالة GitHub | 0 أسرار، 0 متغيّرات (`node scripts/setup-github.js`) |
| انحراف موثّق عن `go-live.md` B0.1 | **2026‑11‑06** — تقرَّر تشغيل الخادم الحقيقي (Apps Script + Sheets + Calendar) على **حساب المطوّر الحالي** بدل حساب مخصّص للعيادة. السبب: الحساب نفسه يملك المستودع وتطبيق Meta، والفصل يعني إعادة S1 كاملة (أوراق + تقويم + `CELIA_SHEET_ID`) بعد إنجازها. الأثر المقبول: بيانات اتصال أولياء الأمور تبقى في Drive هذا الحساب، فتسليم العيادة أو تغيير المشغّل يستلزم إعادة S1 على الحساب الجديد (§4 يصف التبديل A→B). **يُراجَع إلزاميًا قبل فتح الخدمة للجمهور** — لا يُعدّ هذا الانحراف موافقة دائمة. |

**قاعدة ثابتة:** الحساب **لا يُكتب في الكود** ولا في ملف محفوظ. الكود ينادي أسماء منطقية (`memory/long`، `evidence`، `index_sheet`)، والاسم الحقيقي للمجلد/الورقة يعيش في `config/google.profile.json` المستبعَد من Git.

## 1 | وظيفة ← خدمة (خريطة هذا المشروع)

| الوظيفة | الخدمة | الغطاء (scope) | البطاقة | في المشروع |
| --- | --- | --- | --- | --- |
| `memory.long` (ذاكرة طويلة) | Drive | `drive.file` | لا | ملفات أنشأها التطبيق فقط |
| `memory.evidence` (أدلة) | Drive | `drive.file` | لا | كتابة-مرة، التعديل = ملف جديد + `supersedes` |
| `memory.backup` (نسخ) | Drive `backups/` + نسخة مشفّرة خارجه | `drive.file` | لا | §5 |
| `memory.index` (فهرس) | Sheets | `spreadsheets` | لا | ورقة `index` داخل مجلد الجذر |
| `state` (حالة ساخنة) | **Sheets** (موجود أصلًا في `Code.gs`) | — | لا | لا نقسم الحالة على مخزنين |
| `time` (وقت) | Calendar | `calendar.events` | لا | `CALENDAR_ID` في Script Properties |
| `llm` | Gemini AI Studio | مفتاح API | لا | `Llm.gs` وحده |
| `mail` | **بلا** | — | — | لا نطلب أي غطاء Gmail |
| `tasks` / `people` | **بلا** | — | — | لا حاجة الآن؛ يُضاف عند الحاجة فقط |

**لماذا `admin`/`drive` الكامل مرفوض:** الغطاء الحسّاس يعني تحذير «تطبيق غير موثّق» ونطاقًا أوسع من الحاجة. `drive.file` غير حسّاس، ولا يحتاج تحققًا، ويعطي التطبيق **ملفاته فقط**.

## 2 | إعداد لمرة واحدة (صفر بطاقة)

نفّذ الخطوات بالترتيب. ما بين `⟦أنت⟧` تفعله في المتصفح؛ ما بين `⟦الطرفية⟧` أمر جاهز.

1. ⟦أنت⟧ **الحساب المخصّص**: استخدم حسابًا مخصّصًا للنظام لا حسابك الشخصي، وفعّل **التحقق بخطوتين**.
2. ⟦أنت⟧ **Google Cloud Console** → مشروع جديد (`celia-kids-dev` مثلًا). **لا تضغط أبدًا** «Activate / Start free trial» أو أي شاشة تطلب بطاقة. إن ظهرت: توقّف.
3. ⟦أنت⟧ **APIs & Services → Library** → فعّل فقط:
   `Google Drive API` · `Google Sheets API` · `Google Calendar API`.
4. ⟦أنت⟧ **Google Auth Platform → Get started**:
   - App name: `Celia Kids Bridge` · Support email: بريد الحساب.
   - **Audience: External** · أضف بريد الحساب نفسه في **Test users**.
   - **Data Access**: أضف الأغطية الثلاثة: `.../auth/drive.file` · `.../auth/spreadsheets` · `.../auth/calendar.events`.
5. ⟦أنت⟧ **Clients → Create client → Application type: Desktop app** → نزّل JSON. يظهر `client_id` و`client_secret` **مرة واحدة**.
   > لا تلصق أيًّا منهما في محادثة أو Issue أو ملف داخل المستودع.
6. ⟦أنت⟧ **Publishing status → Publish app → In production**. لماذا الآن وليس لاحقًا: في وضع **Testing** تنتهي صلاحية refresh token بعد **7 أيام**.
   - مع `drive.file` (غير حسّاس) لا يُطلب تحقق. إن ظهرت شاشة «Google hasn’t verified this app» → `Advanced → Go to Celia Kids Bridge` وهذا متوقّع للاستخدام الشخصي.
   - بعد النشر **أعد الموافقة مرة واحدة** لتحصل على توكن طويل الأجل.
7. ⟦الطرفية⟧ حمّل الأسرار إلى الصدفة الحالية (الاسم فقط، القيمة تكتبها أنت):
   ```bash
   export GOOGLE_CLIENT_ID='...'         # من ملف JSON
   export GOOGLE_CLIENT_SECRET='...'     # من ملف JSON
   cp config/google.profile.example.json config/google.profile.dev.json
   node scripts/google/auth.js --profile dev
   ```
   يطبع رابط الموافقة، ينتظر على استماع محلي، ثم يحفظ التوكن في `.secrets/google-token.dev.json` (مستبعَد، صلاحية 600) **ولا يطبعه**.
8. ⟦الطرفية⟧ خزّن التوكن في GitHub ثم احذف الملف:
   ```bash
   export GOOGLE_REFRESH_TOKEN_DEV="$(python3 -c 'import json;print(json.load(open(".secrets/google-token.dev.json"))["refresh_token"])')"
   gh secret set GOOGLE_CLIENT_ID --repo sayedelazameydesign-crypto/dr.mukhtar
   gh secret set GOOGLE_CLIENT_SECRET --repo sayedelazameydesign-crypto/dr.mukhtar
   gh secret set GOOGLE_REFRESH_TOKEN_DEV --repo sayedelazameydesign-crypto/dr.mukhtar
   rm -rf .secrets/
   ```
   `gh secret set` يقرأ القيمة من stdin بمطالبة مخفية أو من الملف؛ **لا تستخدم `--body`**.
9. ⟦الطرفية⟧ أنشئ التخطيط (مجلدات + ورقة الفهرس) — آمن للتكرار:
   ```bash
   node scripts/google/bootstrap.js --profile dev --dry-run   # يعرض ما سيفعله فقط
   node scripts/google/bootstrap.js --profile dev             # ينشئ ويكتب المعرّفات في config/google.profile.dev.json
   ```
10. ⟦الطرفية⟧ فحص صحّي:
    ```bash
    node scripts/google/selftest.js --profile dev
    ```
    المتوقّع: `Adapter google` · `Account label` · نسبة الحصة · `write/read/list/exists/delete: ok` · `SELFTEST OK`.
11. ⟦أنت⟧ **المتغيّرات** على GitHub (غير سرّية):
    ```bash
    gh variable set GOOGLE_PROFILE --body dev --repo ...
    gh variable set GOOGLE_AUTH_MODE --body oauth_user --repo ...
    ```
    أو نفّذ الكل بأمر واحد: `sh scripts/bootstrap-github.sh` (§7a-2 في `docs/secrets.md`).

> **ليست مطلوبة الآن:** Firebase/Firestore، Cloud Storage، Functions، Pub/Sub، Secret Manager. كلها إما Blaze/بطاقة أو غير لازمة.

## 3 | ما لا يفعله الوكيل أبدًا

- لا ينشئ حساب Google، ولا يضغط «موافق» على شاشة الموافقة.
- لا يسأل عن `client_secret` أو `refresh_token`، ولا يخزّنهما في ملف داخل المستودع.
- لا يطبع أيًّا من: `client_secret` · `refresh_token` · `access_token`.
- لا يشغّل `gh secret set --body`.
- لا يفعّل Billing ولا أي شاشة تطلب بطاقة. إن ظهرت: يتوقّف ويبلّغ.

## 4 | تبديل الحساب (A → B) — بلا تغيير كود

1. جهّز B بنفس §2 خطوات 1 و6، **وأعد استخدام نفس Cloud project وOAuth client** (`drive.file` مرتبط بالتطبيق: عميل جديد لا يرى ملفات القديم).
2. سجّل الدخول بـ B → `node scripts/google/auth.js --profile clinic` → احفظ التوكن باسم `GOOGLE_REFRESH_TOKEN_CLINIC`.
3. `node scripts/google/bootstrap.js --profile clinic`.
4. (اختياري) `node scripts/google/migrate.js --from dev --to clinic` — يعرض الخطة أولًا، والكتابة بـ `--apply` فقط، ويتحقق من `sha256` لكل ملف.
5. `gh variable set GOOGLE_PROFILE --body clinic` ثم `node scripts/google/selftest.js --profile clinic`.
6. بعد نجاح الفحص فقط: اسحب صلاحية A من `myaccount.google.com/permissions`، واحتفظ بتصدير A **30 يومًا**.
7. حدّث `docs/free-tiers.json` (تاريخ الفحص) وسجل الأسرار.

**الرجوع:** `GOOGLE_PROFILE=dev` — A لم يُمَس حتى الخطوة 6.
**إن احتاج التبديل تعديل كود** ⇒ عيب في الـgateway، لا في الحساب: أصلح `scripts/google/gateway.js`، لا تنشئ مسارًا ثانيًا.

## 5 | النسخ الاحتياطي خارج Google

- مجلد `backups/` في Drive = نسخة أولى فقط، وليست نسخة خارج Google (الحصة مشتركة مع Gmail/Photos).
- النسخة الثانية: أرشيف مشفّر → مستودع GitHub خاص أو قرص محلي. لا أسرار في الأرشيف، ولا يدفع الوكيل شيئًا.
- تنبيه الحصة: `selftest` يحذّر عند **80%** (`quota().percent`).

## 6 | الصيانة

| الدورية | الأمر | الغرض |
| --- | --- | --- |
| شهريًا | `node scripts/google/selftest.js --profile dev` | فحص + إبقاء التوكن نشطًا (الخمول ~6 أشهر يقتله) |
| كل 90 يومًا | تدوير `GOOGLE_REFRESH_TOKEN_DEV` | سياسة `docs/secrets.md` §9 |
| كل 180 يومًا | تدوير `GOOGLE_CLIENT_SECRET` | يبطل كل التوكنات ⇒ دوّر التوكنات معه |
| كل 30 يومًا | مراجعة `docs/free-tiers.json` | Zero-Card + الحدود |

## 7 | الفشل ← الإجراء

| الرسالة | المعنى | الإجراء |
| --- | --- | --- |
| `invalid_grant` | التوكن انتهى أو أُلغي، أو التطبيق ما زال Testing (7 أيام)، أو تغيّرت كلمة المرور، أو خمل ~6 أشهر | تأكد من «In production» → `node scripts/google/auth.js` → حدّث السر |
| `403 storageQuotaExceeded` | حساب خدمة على Drive شخصي، أو Drive ممتلئ | استخدم `oauth_user` (هذا هو الوضع) أو فرّغ مساحة |
| `403 rateLimitExceeded` / `429` | تجاوز حد | الـgateway يعيد المحاولة بأُسّية + jitter تلقائيًا؛ إن تكرر: قلّل الدفعات |
| `404` على ملف معروف | بروفايل خطأ أو عميل OAuth مختلف (`drive.file` لكل تطبيق) | تحقق من `GOOGLE_PROFILE` وأنك تستخدم نفس العميل |
| `accessNotConfigured` | API غير مفعّل في المشروع | فعّله في §2 خطوة 3 |
| شاشة «unverified app» | متوقّع للاستخدام الشخصي | `Advanced → continue` |
| `402/403` من Firebase Storage | يحتاج Blaze (بطاقة) | لا تستخدمه؛ Drive هو المخزن |
| بريد/جهات/Keep غير مدعومة | تتطلب Workspace أو لا API لها | استخدم `inbox/` في Drive أو Tasks/Calendar |

## 8 | التحقق المحلي (بلا حساب)

```bash
node scripts/test-google-bridge.js      # 29 اختبارًا: المُحوّلان، البروفايل، التحديث، التخطيط، الهجرة
node scripts/google/selftest.js --local # نفس الفحص الخماسي على نظام الملفات
```

CI يشغّل الأمرين في كل دفعة، و`node scripts/check-workflows.js` يمنع:
- أي بريد إلكتروني أو معرّف في `config/google.profile.example.json`؛
- أي نداء Google من خارج `gateway.js` (و`auth.js`/`bootstrap.js` لمرة واحدة)؛
- أي نداء Google من الموقع الثابت (`index.html`, `app.js`, `app.css`)؛
- إسناد قيمة اعتماد داخل سكربت، أو طباعتها.
