# Production Readiness — سجل الفجوات وتقرير التشغيل

> **مصدر الحقيقة:** [`docs/map/gaps.json`](../docs/map/gaps.json) للسجل، وتشغيل فعلي لـ
> `scripts/go-live-check.js` للأرقام. الجداول أدناه **مُولَّدة** — `node scripts/readiness-report.js --check`
> في CI يفشل إن تباعدت عن المصدر.
>
> **لا تخلط الترقيم:** السجل يستخدم `G1…G14` **للفجوات فقط**. مراحل خط الأنابيب (بناء، اختبارات،
> فحص، أمن، بيانات، إعداد، رصد، استعادة، مسار المستخدم، نشر) تُسمّى `P-BUILD … P-DEPLOY` كي لا
> يتكرر `G5` بمعنيين — وهو تناقض كان قائمًا في هذه الوثيقة حتى ٢٠٢٦-١١-٠٥.

## خط الأنابيب (P-*) — حالة كل مرحلة

| المرحلة | الحالة | الدليل |
| --- | --- | --- |
| P-BUILD | ✅ | `python3 scripts/build-gas-package.py` → حزمة `gas/` تُبنى |
| P-TESTS | 🟡 | ١٨ بوابة محلية، كلها محاكاة — لا تكامل مع Google حقيقي (يفتح G1/G14) |
| P-STATIC | ✅ | `check-settings-parity` · `scan-secrets` · `check-config` · `check-workflows` |
| P-SECURITY | 🟡 | القائمة البيضاء للنشر + `test-publish-contract.js`؛ لا مراجعة أمنية خارجية |
| P-DATA | ❌ | لا نسخة احتياطية/استعادة مُختبرة لـ Sheets/Calendar (بند بروفة، لا فجوة سجل) |
| P-CONFIG | 🟡 | الإعداد موثّق ومفحوص؛ **بيانات العيادة الأربعة** لم تُدخل بعد |
| P-OBSERVABILITY | 🟡 | `Audit` + `logEvent_`؛ لا فحص صحة ولا تنبيه للمشغّل |
| P-RECOVERY | 🟡 | `git revert` + إعادة نشر؛ لا خطة استعادة بيانات |
| P-USERFLOW | 🟡 | مُثبت في jsdom وفي المحاكاة؛ غير مُثبت في حساب حقيقي (G1) |
| P-DEPLOY | 🟡 | الموقع منشور ومُتحقَّق؛ Apps Script لم يُنشر قط |

## ما تغيّر ولماذا — سجل مختصر

| التاريخ | التغيير | الدليل |
| --- | --- | --- |
| ٢٠٢٦-١١-٠٥ (١) | النشر صار قائمة سماح؛ حُذفت الملفات الداخلية من المستودع | `test-publish-contract.js` ٤٩ فحصًا + إدخال خلل مرتين |
| ٢٠٢٦-١١-٠٥ (١) | اختبارات المتصفح تفشل بدل أن تتخطى بصمت | `SKIPPED-WITH-FAILURE … exit=1` |
| ٢٠٢٦-١١-٠٥ (٢) | ٥ بوابات صامتة صارت تفشل بصوت عالٍ + حرس دائم | `test-silent-gates.js` ١٠ فحوص |
| ٢٠٢٦-١١-٠٥ (٢) | بوابة بيانات العيادة: schema + نشر إنتاجي صارم | `test-clinic-schema.js` ٤٥ فحصًا |
| ٢٠٢٦-١١-٠٥ (٣) | هذه الوثيقة تُولَّد من السجل + تشغيل فعلي؛ وتناقض G5 أُزيل | `readiness-report.js` يفشل عند التباعد |

<!-- GENERATED:START -->
<!-- هذا القسم مُولَّد: node scripts/readiness-report.js --write · لا تُحرّره يدويًا -->

## الحكم (من تشغيل فعلي)

| القياس | القيمة |
| --- | --- |
| تاريخ القياس | 2026-11-06 |
| بيئة القياس | jsdom موجود (البوابة عملت) |
| الشبكة | متخطّاة (--offline) |
| جاهز | **8** |
| يحتاج إجراء | **2** |
| غير مُتحقَّق | **4** |
| معلومات | 2 |
| الحكم | `not-ready` |

**ليس جاهزًا للتشغيل** ما دام `verdict !== "ready"`. هذا السطر يُولَّد، ولا يُكتب.

## السجل (مصدر الحقيقة: `docs/map/gaps.json`)

| الإجمالي | مغلق | مفتوح |
| --- | --- | --- |
| **25** | **21** | **4** (G1) (G2) (G14) (G23) |

| Gap | Type | Severity | Status | Evidence / closure |
| --- | --- | --- | --- | --- |
| G1 | untested_critical_path | high | **OPEN** | TODO.md:35-45 'مفتوح قبل التشغيل الحقيقي'; scripts/test-gas-simulated.js:143 stubs UrlFetchApp; no real account run recorded |
| G2 | unconfigured_contract | high | **OPEN** | gh api: variables 0, secrets 0, branches/main.protected=false (2026-11-05) |
| G3 | config_drift | high | **resolved** | node scripts/check-config.js /tmp/bad.json → "LLM_TIMEOUT_MS: must be a number within 2000..60000" (exit 1) |
| G4 | defined_but_unused | med | **resolved** | config/.env.example header states the CELIA_* names are docs-only mirrors; GROQ_API_KEY annotated as reserved |
| G5 | duplicated_rule | med | **resolved** | node scripts/check-settings-parity.js -> "15 fields match between Settings.gs and app.js, prices round-trip"; node scripts/test-published-clinic.js -> "a file cannot override the clinic hours" / "cannot add or price a visit type" (25 checks) |
| G6 | dead_duplicate | med | **resolved** | root build-gas-package.py removed; only scripts/build-gas-package.py remains |
| G7 | foreign_artifacts | med | **resolved** | root artifacts removed (2 terminal transcripts, 1 pasted PNG, app.config.ts, manus-routes.json); pages.yml is now an allow-list |
| G8 | unbounded_log_artifact | med | **resolved** | transcripts deleted; CI now publishes an allow-list |
| G9 | defined_but_unused | med | **resolved** | docs/secrets.md §1b documents GROQ_API_KEY as a reserved name with no consumer |
| G10 | untested_critical_path | low | **resolved** | scripts/test-ui-smoke.js and test-published-clinic.js exit 1 when jsdom is missing unless CELIA_ALLOW_SKIP_UI=1; ci.yml runs require.resolve("jsdom") |
| G11 | hardcoded_value | low | **resolved** | demo PIN stays; documented as demo-only in docs/go-live.md §6 |
| G12 | docs_drift | low | **resolved** | AGENTS.md now points at the ci.yml step list instead of a script count; README.md file tree lists scripts/ and the readiness matrix |
| G13 | ci_coverage | low | **resolved** | ci.yml pins actionlint 1.7.7 via download-actionlint.bash and fails if it cannot run; browser tests exit 1 when jsdom is missing unless CELIA_ALLOW_SKIP_UI=1 |
| G14 | unverified_integration | med | **OPEN** | config/google.profile.json absent; config/google.profile.example.json layout ids all null; no live run recorded |
| G15 | unsafe_default_behaviour | high | **resolved** | scripts/test-gas-simulated.js primes the cache before the first approval, then asserts the approved/moved-to/closed times vanish and the freed times return; with invalidateSlotCacheFor_ stubbed out the suite fails on 'the approved time disappears from the cached slot list, not only from Calendar' |
| G16 | missing_abuse_control | high | **resolved** | Script cache counter with a 5-failure / 15-minute lock, shared across executions; test-gas-simulated.js asserts four typos do not lock, the fifth does, the correct PIN is refused while locked, the window clears, and a good login resets the counter. Removing the lock check fails the suite. |
| G17 | unattributable_audit | med | **resolved** | staffActor_() records the signed-in account as staff:<email> (lower-cased), degrades to 'staff' when the account cannot be resolved, and the public clinic profile is asserted to carry no email; test-gas-simulated.js checks both branches. |
| G18 | unbounded_wait | high | **resolved** | scripts/test-ui-smoke.js drives a real Apps Script-shaped runner whose callback never fires: the slot read falls back to the documented preference list, the submit button returns to enabled with its label restored, and the toast says the response did not arrive. Removing the wrapper (mutation) fails 4 assertions. |
| G19 | missing_data_rights | high | **resolved** | node scripts/test-privacy-health.js -> 21 checks (reference+phone ownership, erasure blanks name/phone but keeps audit trail, live-event and outage-queue refusals, retention window + throttle) |
| G20 | unobservable_failure | high | **resolved** | node scripts/test-privacy-health.js -> health payload without name/phone/reference, red on Sheets outage, red on temporary PIN, red on full queue, public endpoint closed without HEALTH_TOKEN |
| G21 | architecture_doc_invisible_on_site | low | **resolved** | node scripts/check-workflows.js (map parses, no undeclared/dead ids); grep of _site assembly in pages.yml shows the docs kept internal by allow-list |
| G22 | silent_breakage | high | **resolved** | node scripts/check-script-syntax.js → 'Syntax gate passed: 45 script(s) under scripts/ parse.' and CI step 'Syntax gate (every script under scripts/)' |
| G23 | unverified_behaviour | med | **OPEN** | .github/workflows/ai-repair.yml and ci-error-triage.yml were on the PR branch only; GitHub refuses `gh workflow run` for a workflow absent from the default branch (HTTP 404). They merged in 01c90ba, so the technical blocker is gone and the remaining requirement is a completed run, not a merge |
| G24 | docs_drift | med | **resolved** | node scripts/check-audit-doc.js → 'Audit gate passed: 16 threat rows, 31 file:line citations, all resolvable.' and the gate runs in CI as 'Threat-model citations resolve and are backed by tests' |
| G25 | security | high | **resolved** | scripts/test-privacy-health.js: 'a prefix of the secret is not accepted', 'a prefix of the health token does not open the uptime endpoint', 'a prefix of the staff PIN digest does not unlock the dashboard' — all three fail against the old comparison and pass after Code.gs:992 compares length first. |

## نتيجة تشغيل التقرير

| Item | Result | Detail | Owner |
| --- | --- | --- | --- |
| clinic.name — اسم العيادة الحقيقي | ✅ **PASS** | alaqsa clinic (clinic.json) | المستخدم |
| clinic.phone — هاتف العيادة | ✅ **PASS** | 2011… (مخفي جزئيًا) · clinic.json | المستخدم |
| clinic.doctor — اسم الطبيب | ❌ **FAIL (needs user action)** | غير مضبوط — تظهر شارة «لم يُتحقق بعد» | المستخدم |
| clinic.license — رقم الترخيص | ❌ **FAIL (needs user action)** | غير مضبوط | المستخدم |
| clinic.services — أنواع الزيارات | ℹ️ info | القالب الافتراضي (كشف جديد · متابعة) | المستخدم |
| clinic.source — مصدر بيانات العيادة | ℹ️ info | قُرئ من القالب (بلا تصدير حقيقي) — أي أن الحالة أعلاه هي حالة «لم يُضبط بعد» وليست حالة عيادتك | المستخدم |
| gate.workflows — عقود سير العمل والأسرار | ✅ **PASS** | · manifest secret GOOGLE_REFRESH_TOKEN_DEV is not referenced by any workflow (declared-only is allowed, keep it delibera | CC (المستودع) |
| gate.secrets — مسح الأسرار | ✅ **PASS** | Secret scan passed — 123 text files (tracked files), 11 rules, 0 findings. | CC (المستودع) |
| gate.parity — تطابق الإعدادات (حيّ/تجريبي) | ✅ **PASS** | Settings parity OK — 16 fields match between Settings.gs and app.js, prices round-trip, and the public profile ships ser | CC (المستودع) |
| gate.backend — محاكاة الخادم | ✅ **PASS** | Offline simulated Apps Script tests passed: competing approvals, visit duration, partial-write retry, edit/cancel, Calen | CC (المستودع) |
| gate.ui — الواجهة في متصفح | ✅ **PASS** | UI smoke test passed: rendering, booking, reference tracking, staff approval, and the admin assistant all work in demo m | CC (المستودع) |
| gate.privacy — الخصوصية والاحتفاظ وفحص الصحة | ✅ **PASS** | Privacy/health suite passed: 24 checks (reference is not a credential, deletion erases contact data and keeps the audit  | CC (المستودع) |
| site.up — الموقع المنشور | ⏸️ **NOT VERIFIED** | تم تخطي الشبكة (--offline) | المستخدم (شبكة) |
| live.appsScript — الخادم يعمل في حساب Google | ⏸️ **NOT VERIFIED** | لم يُختبر في حساب حقيقي — المحاكاة لا تُغني عنه | المستخدم |
| live.branchProtection — حماية main (مطلوب PR + CI) | ⏸️ **NOT VERIFIED** | لا يمكن قراءتها بلا صلاحية إدارة المستودع | المستخدم |
| live.secrets — أسرار/متغيّرات GitHub | ⏸️ **NOT VERIFIED** | لا تُقرأ ولا تُطبع من هنا (الأسماء فقط في المانيفست) | المستخدم |

<!-- GENERATED:END -->
---

## كيف يُعاد توليد هذا الملف

```bash
npm ci                                             # يثبّت jsdom من package-lock.json
NODE_PATH=/tmp/jsd/node_modules node scripts/readiness-report.js --write
NODE_PATH=/tmp/jsd/node_modules node scripts/readiness-report.js          # فحص فقط (يفشل إن تباعد)
```

## بروفة Google

كل خطوة في [`docs/google-rehearsal.md`](./google-rehearsal.md) لها حقل `evidence` في
`scripts/rehearsal-checklist.json` (18 خطوة، التقدّم الحالي **0/18**). الفجوتان **G1** و**G14** لا
تُغلقان إلا بأدلة من حسابك، ولا يرقّيهما كلام.
