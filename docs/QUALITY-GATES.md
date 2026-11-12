# Quality Gates — Celia Kids

> **ملخص عربي:** بوابات التحقق الملزمة قبل تسليم أي عمل. كل بوابة تعني: الأمر الحقيقي + النتيجة
> + البيئة (محلي/CI/حساب Google حقيقي). كلمة PASS وحدها ليست دليلًا. المصدر المرجعي لسير
> العمل هو خطوات `.github/workflows/ci.yml` نفسها، لا قائمة هذا الملف وحدها.

Every gate below names the **command**, the **evidence** it produces and the **environment** it
runs in. A gate that cannot fail is not a gate — `scripts/test-silent-gates.js` enforces that
property for the workflows, and `scripts/check-agent-protocol.js` enforces it for the protocol
documents themselves.

The source of truth for CI is `.github/workflows/ci.yml`. This page is the index a human reads;
if the two disagree, fix this page in the same PR that changes the workflow.

---

## 1. The seven gates (human questions → mechanical checks)

| Gate | Mandatory question | Mechanical check in this repo | Evidence |
|---|---|---|---|
| **Goal validity** (صحة الهدف) | Did I understand the task exactly? | The task contract in `docs/OPERATING-PROTOCOL.md §2` is written before coding | Contract in the PR description or task notes |
| **Starting state** (سلامة البداية) | Did I inspect before modifying? | `git status` clean or fully understood; `docs/map/` fresh (`node scripts/check-workflows.js` warns on stale `meta.commit`); current docs read | Branch + HEAD + map status recorded |
| **Change scope** (نطاق التغيير) | Is the change necessary and minimal? | Diff limited to contract scope; unrelated files untouched; PRs ≤ ~400 lines, one concern | `git diff --stat` in the report |
| **Compatibility** (التوافق) | Contracts and interfaces preserved? | `node scripts/check-architecture-boundaries.js` · `node scripts/check-settings-parity.js` · `node scripts/check-config.js` | Exit 0 from each |
| **Tests** (الاختبارات) | Was the change actually tested? | `npm test` (models + `test-gas-simulated.js` + `test-ui-smoke.js`) · `node scripts/test-gas-simulated.js` for backend · `npx playwright test` for browser E2E | Exit 0 + which suite covered the change |
| **Evidence** (الدليل) | Can the result be inspected? | `npm run gates` · `npm run readiness` · `npm run evidence:check` · CI run link | Command + exit code + run URL |
| **Delivery** (التسليم) | Is everything unverified declared? | Final report per `docs/OPERATING-PROTOCOL.md §6`; `docs/ERROR-REGISTER.md` updated for any incident found | Report lists gaps explicitly |

---

## 2. Phase exit criteria (per-phase gates)

| Phase (docs/OPERATING-PROTOCOL.md) | Local gate | CI gate |
|---|---|---|
| UNDERSTAND / INSPECT / PLAN | — (no code yet) | — |
| EXECUTE | `node --check` on touched files · `node scripts/check-script-syntax.js` | Syntax gate (JS) + Syntax gate (every script under `scripts/`) |
| EXECUTE (backend) | `node scripts/test-gas-simulated.js` | Backend simulation tests (incl. without WhatsApp adapter) |
| EXECUTE (UI) | `node scripts/test-ui-smoke.js` (jsdom required) | UI smoke test (jsdom) in CI |
| EXECUTE (bundle) | `python3 scripts/build-gas-package.py` | Build Apps Script bundle + artifact leak guard + self-containment guard |
| VERIFY (whole) | `npm run gates` · `npm test` · `npm run readiness` | full `ci.yml` — **merge only on green** |
| VERIFY (docs) | `node scripts/check-agent-protocol.js` · `node scripts/check-gap-docs.js` · `node scripts/check-audit-doc.js` · `node scripts/check-doc-evidence.js` | same steps in CI |
| VERIFY (secrets) | `node scripts/scan-secrets.js` · `sh scripts/pre-commit.sh` | Secret scan (built-in + gitleaks) |
| REPORT | Report template filled | PR created; human merges — never the agent |

---

## 3. Evidence format

Every claim of success must carry:

1. **The exact command** (copy-pasteable),
2. **Exit code**,
3. **Environment**: `local sandbox` / `CI (ci.yml run <id>)` / `live Google account` — and if live,
   which rehearsal step (`scripts/rehearsal-checklist.json`, e.g. S1.6) recorded the evidence,
4. **What the output proves** — and equally important, what it does **not** prove.

Examples already in this repository:

- Simulated approval path passes in `scripts/test-gas-simulated.js` → proves logic under simulation.
  It does **not** prove a real Sheets/Calendar round-trip — that is gap G1 and needs a live account.
- `node scripts/readiness-report.js --offline --require-jsdom` exits 0 → proves the readiness
  document matches the ledger and a real run; it says nothing about production traffic.
- A schema-drift guard log (`schema_drift`) on a live account (rehearsal S1.6) → proves the guard
  fires in production conditions, not only in the simulator.

---

## 4. Levels of protection (and why all three are required)

| Level | Mechanism in this repo | What it cannot do alone |
|---|---|---|
| 1 — Instructions (Prompt) | `AGENTS.md`, `docs/OPERATING-PROTOCOL.md`, this file | Cannot guarantee an agent never ignores them |
| 2 — Workflow controller | CI `ci.yml` step order; `package.json` scripts (`gates`, `test`, `readiness`); `scripts/check-*.js` gates | Cannot block a determined human or a misconfigured runner |
| 3 — Hard enforcement | Branch protection (owner-side, G2), required checks, `persist-credentials: false`, SHA-pinned actions, secret scanning, merge only on green | Cannot validate judgement — only mechanics |

Never rely on Level 1 alone. Every rule in this file that matters has a Level 2 or Level 3 twin
(or an entry in `docs/ERROR-REGISTER.md` explaining why it does not yet).

---

## 5. When a gate fails

1. Stop the operation; capture the full output.
2. Diagnose root cause (`scripts/ai-root-cause.js --self-test` shows the expected shape of such
   analysis); if unknown — report BLOCKED, do not improvise.
3. Fix inside the authorized scope; re-run the failing gate; then re-run **adjacent** gates
   (`npm run gates`) to catch regressions.
4. Record the incident in `docs/ERROR-REGISTER.md` if it was novel, or reference the existing REG id.
