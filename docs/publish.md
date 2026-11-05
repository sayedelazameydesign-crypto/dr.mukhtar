# النشر — `docs/publish.md`

> الهدف: الموقع يفتح من رابط عام، **بصفر بطاقة**، وبمسار مكتوب لا محفوظ في الرأس.
> الحالة: الكود مدموج على `main` (14 كوميت، 63 ملفًا). المتبقّي خطوة واحدة منك على GitHub.

## 0 | ما الذي يمنع النشر الآن

آخر تشغيل لـ `Deploy site` على `main` فشل في **خطوة واحدة فقط**:

```
failure  Run actions/configure-pages@v5        ← هنا
skipped  Run actions/upload-pages-artifact@v3  ← لذلك تخطّى الباقي
skipped  JOB deploy
```

السبب: مستودع `dr.mukhtar` **ليس فيه موقع Pages بعد** (`GET /pages` → 404)، و`GITHUB_TOKEN`
لا يستطيع **إنشاء** موقع Pages (403). ولذلك نحتاج توكينك الخاص للتوكين الأول فقط.

> **درس موثّق (حدث فعلًا):** أول محاولة أصلحت هذا بإضافة `administration: write` داخل `permissions:`
> — وهذا مفتاح **غير موجود** في GitHub. رفض GitHub الملف كله:
> `failed to parse workflow: (Line: 22, Col: 3): Unexpected value 'administration'`.
> والنتيجة الخبيثة: كل تشغيل كان يفشل **بصفر وظائف**، فيبدو أحمر بلا سبب ظاهر.
> الصواب: `permissions` تبقى `contents/pages/id-token` فقط، والصلاحية الإدارية تأتي من **الـPAT** في خطوة التفعيل.
كل الخطوات الأخرى نجحت: العقد، جمع الملفات، محاكاة الخادم، المحوّل، حارس localhost/CDN، بناء الحزمة.

## 1 | الاختيار بين مسارين

| | المسار A — Run workflow | المسار B — من الإعدادات |
| --- | --- | --- |
| ما تفعله | تضبط متغيّرًا + سرًّا مرة واحدة ثم `Run workflow` | Settings → Pages → Source: **GitHub Actions** |
| مدة | ~3 دقائق | ~1 دقيقة |
| يحتاج PAT | نعم (fine-grained، مستودع واحد، Pages + Administration) | لا |
| بعدها | كل `push` إلى `main` ينشر تلقائيًا | كل `push` إلى `main` ينشر تلقائيًا |

كلاهما لا يطلب بطاقة. **B أبسط**؛ A موجود لأن الوكيل لا يستطيع فتح الإعدادات.

## 2 | المسار B — من الإعدادات (موصى به)

1. افتح `https://github.com/sayedelazameydesign-crypto/dr.mukhtar/settings/pages`.
2. **Build and deployment → Source** = **GitHub Actions** (لا تختار "Deploy from a branch").
3. اذهب إلى `https://github.com/sayedelazameydesign-crypto/dr.mukhtar/actions/workflows/pages.yml`
   → **Run workflow** → `main` → Run.
4. انتظر `build` ثم `deploy`. الرابط يظهر في تبويب **Deploy** وفي `Settings → Pages`.

## 3 | المسار A — بلا إعدادات (سكربت واحد)

على جهازك، بتوكين `gh` الخاص بك (لا يمرّ عبر الوكيل):

```bash
sh scripts/enable-pages.sh
```

يفعل بالترتيب: يتحقق من `gh auth` → ينشئ PAT دقيقًا **إن أردت** أو يستخدم توكينًا موجودًا →
`gh variable set PAGES_AUTO_ENABLE --body true` → `gh secret set PAGES_TOKEN` (مطالبة مخفية) →
`gh workflow run "Deploy site"` → يراقب التشغيل → **ثم ينظّف**: يحذف السرّ والمتغيّر بعد نجاح النشر
لأنهما للمرة الأولى فقط. تجربة جافة: `sh scripts/enable-pages.sh --dry-run`.

> صفحة إنشاء الـPAT: `Settings → Developer settings → Personal access tokens → Fine-grained tokens`
> → Repository access: **Only select repositories** = `dr.mukhtar`
> → Permissions: **Pages: Read and write** + **Administration: Read and write**. لا شيء آخر.

## 4 | التحقق بعد النشر

```bash
curl -sI https://sayedelazameydesign-crypto.github.io/dr.mukhtar/ | head -1   # 200
```
ثم افتح الرابط وتأكد من:
- الواجهة عربية RTL وتحمّل الخطوط من نفس النطاق (لا طلب خارجي)؛
- `Demo mode`: حجز تجريبي يظهر برقم مرجعي، والحالة **بانتظار العيادة** لا مؤكدة؛
- `view-source` لا يحتوي `gas/` ولا `scripts/` ولا أي مفتاح.

## 5 | ما لا يُنشر أبدًا

`.gitignore` + خطوة `Assemble static site` تنشر **ستة عناصر فقط**: `index.html`، `app.css`، `app.js`،
`brand.svg`، `manifest.webmanifest`، `assets/`. أي شيء آخر (باكند، سكربتات، بروفايلات، خرائط، أسرار) يبقى خارج النشر.

## 6 | بديل بصفر إعدادات

لو أردت رابطًا فوريًا دون تفعيل Pages: Cloudflare Pages أو Netlify (سجل بريد/Google، بلا بطاقة)
يربط نفس المستودع، والمجلد المنشور هو جذر المستودع. مسجّلان في `docs/free-tiers.json` مع البديل والحدود.
