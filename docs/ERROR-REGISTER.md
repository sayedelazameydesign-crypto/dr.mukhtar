# Error Register — Celia Kids

> **ملخص عربي:** سجل الأخطاء المتكررة وأسبابها والحماية التي أُضيفت ضدها. كل قيد هنا حادثة
> حقيقية وقعت أو عيبًا مكتشفًا في هذا المستودع — لا أمثلة نظرية. القيد يعتبر مغلقًا فقط حين
> تكون الحماية موجودة **واختبار انحدار أو بوّابة تثبتها**. القيود المفتوحة تبقى في السجل مع
> حالتها الصريحة، والمصدر الرسمي للفجوات المفتوحة هو `docs/map/gaps.json`.

How to read this register:

- Each entry: **what happened → root cause → protection → regression evidence → status**.
- "Closed" means the protection exists *and* something mechanical proves it.
  A note in a doc is not a protection.
- Open incidents are listed under §3 with their gap id; the ledger (`docs/map/gaps.json`) remains
  the source of truth for their state. `node scripts/check-gap-docs.js` keeps derived docs honest.
- When you close something in this register, cite the command and exit code, per
  `docs/QUALITY-GATES.md`. Statuses: `VERIFIED` · `IMPLEMENTED_NOT_VERIFIED` · `BLOCKED`.

---

## 1. Closed incidents (protection + regression test exist)

| ID | Incident (what actually happened) | Root cause | Protection added | Regression evidence | Status |
|---|---|---|---|---|---|
| REG-001 | Adding a column to `REQUEST_HEADERS` against an older live sheet shifted every field silently: the guardian's phone could land in the name column rendered by `publicBooking_()` — a schema edit became a privacy leak with **no error anywhere** (found via live probe in `REVIEW-report.md` §0) | `rowToRequest_`/`requestToRow_` index by position; nothing verified the live header row; the simulator modelled `getLastRow()` as `rows.length` so it was structurally blind to it | `assertSheetSchema_()` in `Code.gs` fails closed on any header drift, logs `schema_drift`, never echoes the offending header; called on every full-sheet read | `scripts/test-gas-simulated.js` — "Schema drift guarded" suite (drifted header fails loudly; stray formatting yields no phantom record; neutralising the guard is caught); rehearsal `S1.6`/`S1.7` recorded owner-side live verification on the real account (2026-11-06) | VERIFIED |
| REG-002 | jsdom missing on a runner made UI coverage vanish **silently** while everything stayed green (gap G10/G13) | Test suites skipped when the DOM library was absent; the CI install step was a soft prerequisite | Browser suites now exit 1 when jsdom is missing (unless explicit `CELIA_ALLOW_SKIP_UI=1`); CI step hard-fails via `require.resolve('jsdom')` with a locked `npm ci` | `node scripts/test-ui-smoke.js` exits non-zero without jsdom; CI step "UI smoke test (jsdom)" | VERIFIED |
| REG-003 | `actionlint` absent on the runner made the workflow-lint gate a no-op that kept CI green (gap G13) | The step fell back to a notice instead of failing | Pinned actionlint 1.7.7 is downloaded and verified in CI; unreachable download = job fails; a `::warning` fallback is now a finding of `scripts/test-silent-gates.js` | `node scripts/test-silent-gates.js` — "actionlint is not skipped when absent"; CI log shows fetched binary version | VERIFIED |
| REG-004 | Approval flow could consume a slot from a stale 30-second availability cache; guardian picked a time staff approval had just taken (gap G15) | Read-cache shared between display and decision paths | 30 s read cache is display-only; approval re-checks availability inside the write lock; booking path fails closed | `scripts/test-gas-simulated.js` — primes the cache before approval, asserts consumed slots disappear and freed slots reappear | VERIFIED |
| REG-005 | Staff PIN endpoint had no throttle: a borrowed browser could guess indefinitely (gap G16) | No rate limit on `verifyStaffPin_` | Script cache counter: 5 failures → 15-minute lock, shared across executions | `scripts/test-gas-simulated.js` — four typos do not lock, the fifth does | VERIFIED |
| REG-006 | With one shared PIN the audit trail could not answer "who confirmed or cancelled this appointment?" (gap G17) | Identity not attached to staff actions | `staffActor_()` records `staff:<email>` (lower-cased), degrades to `staff` only when the account cannot be resolved | `scripts/test-gas-simulated.js` — staff actions carry the actor in Audit | VERIFIED |
| REG-007 | A hung or queued backend call left the submit button disabled and the spinner running forever; a reload during a write invited a duplicate request (gap G18) | No timeout/fallback on the UI wait path | Slot read falls back to the documented preference after the timeout; explicit message instead of a frozen spinner | `scripts/test-ui-smoke.js` — drives a real Apps Script-shaped runner whose callback never fires | VERIFIED |
| REG-008 | A prefix of `HEALTH_TOKEN` (or of the 64-char PIN digest) authenticated — partial-match verification (gap G25) | Comparison accepted prefixes | Full-string comparison for the health token and the PIN digest | `scripts/test-privacy-health.js` — "a prefix of the secret is not accepted", "a prefix of the health token does not open the uptime endpoint" | VERIFIED |
| REG-009 | `scripts/env.js` shipped unparsable because nothing ever imported it; drift discovered late (gap G22) | Gate checked a whitelist of entrypoints, not the tree | Every script under `scripts/` is parsed in CI | `node scripts/check-script-syntax.js` → "Syntax gate passed: N script(s) parse"; CI step "Syntax gate (every script under `scripts/`)" | VERIFIED |
| REG-010 | Documentation drift: the ledger said 5 gaps open, `docs/map/ARCHITECTURE.md` said 3, the ledger's own note listed a third set; a contributor followed an incomplete checklist (gaps G12, G24) | Human-maintained mirrors of machine-checked state | Derived pages must restate exactly the ledger; audit-doc citations must resolve and be backed by named tests | `node scripts/check-gap-docs.js` · `node scripts/check-audit-doc.js` (16 threat rows, 31 file:line citations) · both run in CI | VERIFIED |
| REG-011 | ~165 KB of non-project artifacts (terminal transcripts, a pasted PNG, stray configs) shipped; two transcripts were later served publicly, capturing foreign toolchain environment names (gaps G7, G8) | Publish path had no allow-list; repo accumulated foreign files | Artifacts deleted; `pages.yml` publishes an allow-list only; secret scan runs on the built bundle | CI "Artifact leak guard" + "Bundle self-containment guard"; `scripts/scan-secrets.js gas` | VERIFIED |
| REG-012 | Per-provider LLM timeout could be set outside 2000–60000 ms with no warning; `validateConfig()` only saw declared keys (gap G3) | Validation gap between docs and enforcer | `check-config.js` rejects the value with a named error; `validateConfig()` fails loudly on invalid config | `node scripts/check-config.js /tmp/bad.json` → `LLM_TIMEOUT_MS: must be a number within 2000..60000` (exit 1) | VERIFIED |
| REG-013 | Visit durations / work hours duplicated between `Settings.gs` and the demo mirror in `app.js` — a change in one silently diverged from the other (gap G5) | Duplicated rule with no parity check | Catalog parity is checked mechanically; prices round-trip | `node scripts/check-settings-parity.js` → "fields match between Settings.gs and app.js, prices round-trip" | VERIFIED |
| REG-014 | A second, divergent copy of `build-gas-package.py` lived at the repo root and failed differently for anyone following it (gap G6) | Dead duplicate with a different `ROOT` | Root copy removed; single source is `scripts/build-gas-package.py` | File absent; `python3 scripts/build-gas-package.py` builds `gas/` in CI | VERIFIED |
| REG-015 | A gate that never actually ran shipped for weeks (silent actionlint skip; test suites passing on missing jsdom) | Failure-hiding patterns tolerated in workflows | Negative-test harness for gates themselves; failure-hiding workflow patterns are findings | `node scripts/test-silent-gates.js` (static + live negative tests) in CI | VERIFIED |
| REG-016 | Protocol documents themselves drifting from the repo (missing files, broken links, AGENTS.md pointing at nothing) — the exact failure class REG-010/REG-015 | No gate read the protocol docs | `scripts/check-agent-protocol.js` (this PR): required files, required sections, AGENTS.md linkage, register entry shape; `--self-test` builds a broken fixture and demands failure | `node scripts/check-agent-protocol.js --self-test` and `node scripts/check-agent-protocol.js` | IMPLEMENTED_NOT_VERIFIED until this PR's CI is green |

---

## 2. Regression-test rule

Every entry above with a regression column cites a **test or gate that fails when the defect
returns**. A register entry whose protection is prose-only is a promise, not a protection —
add the test first, then close the entry. New incidents found in review must follow the same
rule or be recorded as open in §3.

## 3. Open incidents (not yet protected end-to-end)

The ledger `docs/map/gaps.json` is authoritative. As of 2026-11-12:

| Gap | Type | Why it is not closed here |
|---|---|---|
| G1 | untested critical path (live Google run never recorded end-to-end) | Needs the owner's live account; rehearsal `scripts/rehearsal-checklist.json` tracks it — do not claim it from CI |
| G2 | branch protection / required checks not confirmed | Owner-side `gh` action; agent token gets 403 by design |
| G14 | live bridge Drive/Sheets/Calendar unproven | Same live-account dependency; `node scripts/google/selftest.js --local` proves only the local adapter |
| G19 | full gap-ledger honesty not re-verified after every change | Watched by `node scripts/check-gap-docs.js`; stays open until the ledger's own cadence closes it |
| G23 | AI-repair workflow never run end-to-end on a real failing run | Needs a real failed CI run to trace; may be closed or re-scoped with evidence |
| G26 | no kernel/agent-in-booking-path stays rejected for now | See `docs/architecture/adr/0003-no-kernel-now.md`; conditions for re-review are written there |
| G27 | open — see ledger | `docs/map/gaps.json` |

Do not edit §3 to look greener. Closing an entry here without its evidence is the exact failure
this register exists to prevent.

---

## 4. Register maintenance

- New incident → new `REG-NNN` in §1 (if protected) or §3 (if not), with the command + exit code
  that proves the protection.
- Recurring defect discovered twice → it must become a regression test, not a longer note.
- Review cadence: the weekly agent-quality review (Google Calendar: "🛡️ مراجعة جودة الوكلاء
  أسبوعيًا") walks this file, `REVIEW-report.md` and the ledger together.
