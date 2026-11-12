# Acceptance Criteria — Celia Kids

> **ملخص عربي:** هذه الصفحة هي فهرس شروط القبول ومؤنِّسة تعريف «المكتمل» لأي مهمة. شروط القبول
> التفصيلية الخاصة بالمنتج تعيش في `docs/prd/acceptance.md` (معايير A/N/P) — هذه الصفحة لا تكرّرها
> كي لا تنحرف عنها، بل تضيف تعريف الإنجاز الإلزامي لأي مهمة وكيل.

Canonical product acceptance criteria live in **`docs/prd/acceptance.md`** (the A/N/P tables —
each criterion is either an existing test in this repository or a named test to be written).
Do not duplicate them here; a second copy is a drift target (see `docs/ERROR-REGISTER.md` REG-010).

This page adds the part that is per-task and universal: **what "the task is done" means**.

---

## 1. Definition of done (any task, any agent)

A task is COMPLETE only when every line below is true:

1. All requested deliverables exist (files committed, PR opened/updated).
2. Every acceptance criterion in the task contract is satisfied — each mapped to a named test or
   to an explicit, recorded human judgement call.
3. Required tests were **executed**; results recorded with command + exit code + environment
   (`local sandbox` / `CI run <id>` / `live account` — see `docs/QUALITY-GATES.md §3`).
4. Persistent state confirmed when the task requires persistence (e.g. a Sheets write survives;
   an Audit row exists).
5. Regressions checked: the suites adjacent to the changed area were re-run and are green.
6. Everything unverified is listed as such in the final report.

If any line is missing, report the task as **INCOMPLETE** with the missing line named.

## 2. Statuses allowed in handover

Use exactly these (same vocabulary as `AGENTS.md` evidence rule and
`docs/OPERATING-PROTOCOL.md §3`):

- `VERIFIED`
- `IMPLEMENTED_NOT_VERIFIED`
- `NOT_EXECUTED`
- `BLOCKED`
- `FAILED`
- `NOT_APPLICABLE`

## 3. What counts as acceptance evidence

| Claim | Acceptable evidence | Not acceptable |
|---|---|---|
| "Tests pass" | Command + exit code + which suites + environment | "Should pass", "ran earlier" |
| "Bug fixed" | Regression test that failed before and passes now, named | Reading the diff and nodding |
| "Works live" | Rehearsal step id (`scripts/rehearsal-checklist.json`) + recorded output | CI green on simulated adapters |
| "Contract intact" | `check-architecture-boundaries.js`, `check-settings-parity.js`, `check-config.js` exit 0 | "No public API changed, I think" |
| "Docs honest" | `check-gap-docs.js`, `check-audit-doc.js`, `check-agent-protocol.js` exit 0 | Self-review |

## 4. Task-contract template

When a task needs its own criteria, copy this and fill it in — do not improvise a looser format:

```markdown
## Task contract
- Objective: …
- Scope: <files/components>
- Constraints: <contracts/gates/data to preserve>
- Forbidden actions: <e.g. deploy, merge, live Google account, secret changes>
- Acceptance criteria: <mapped to docs/prd/acceptance.md ids or named tests>
- Verification: <exact commands + environment>
- Completion: <when this task is done>
```
