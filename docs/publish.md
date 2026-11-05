# النشر — `docs/publish.md`

> الهدف: الموقع يفتح من رابط عام، **بصفر بطاقة**، وبمسار مكتوب لا محفوظ في الرأس.
> الحالة: **الموقع منشور فعلًا** — <https://sayedelazameydesign-crypto.github.io/dr.mukhtar/>
> Pages مفعّل على `main`، وكل `push` إلى `main` يعيد النشر تلقائيًا.

## 0 | الحالة الحالية (تحقّق قبل الاعتماد عليه)

| ما نتحقق منه | كيف | النتيجة المتوقعة |
| --- | --- | --- |
| Pages مفعّل | `gh api repos/…/dr.mukhtar/pages` | `"html_url": "…/dr.mukhtar/"` وليس 404 |
| آخر نشر | `gh api repos/…/deployments` | `environment: github-pages` وبصمة آخر كوميت على `main` |
| النشر الأخير نجح | `gh run list --workflow "Deploy site"` | `main success` |
| الملف الحيّ هو آخر كود | افتح `الموقع/app.js` وابحث عن سطر من آخر تعديل | يظهر |

إن نجح `Deploy site` لكن الصفحة تبدو قديمة، فالسبب دائمًا **كاش المتصفح** أو **CDN**، لا النشر.
أضف `?cb=<بصمة الكوميت>` إلى الرابط للتحقق.

القاعدة: **الدمج ≠ النشر ≠ ظهور التعديل.** دمج طلب في `main` يشغّل النشر، والنشر ينشر *ملفات*،
أمّا ما يُكتب في `localStorage` أو الأوراق (إعدادات العيادة) فيظهر لحظة الحفظ دون أي نشر.

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
