# Decisions — Celia Kids

> **ملخص عربي:** فهرس القرارات المعتمدة التي لا يجوز تغييرها صمتًا. القرارات المعمارية التفصيلية
> في `docs/architecture/adr/` (0001–0007)؛ هذه الصفحة هي الفهرس + الثوابت غير القابلة للتفاوض +
> كيفية تغيير أي قرار بالشكل الصحيح (ADR جديد قبل الكود أو معه — لا بعده).

This is the index of binding decisions. The detailed, reasoned decisions live in
`docs/architecture/adr/`; the operational invariants live in `AGENTS.md`. **If a decision here
conflicts with either, this page has drifted — fix it in the same PR, do not pick a reading.**

---

## 1. Approved architectural decisions (ADRs)

| # | Decision | Status |
|---|---|---|
| [0001](architecture/adr/0001-no-request-is-confirmation.md) | A request is never a confirmation — human approval is the final gate | Accepted |
| [0002](architecture/adr/0002-zero-card-zero-budget.md) | Zero card, zero subscription — a hard constraint on every service | Accepted |
| [0003](architecture/adr/0003-no-kernel-now.md) | No agent kernel in the booking path now (G26) — re-review conditions written | Rejected (for the booking path) |
| [0004](architecture/adr/0004-readiness-as-evidence.md) | Readiness as an evidence-backed record, never slogans | Accepted |
| [0005](architecture/adr/0005-fail-closed-booking-path.md) | Fail closed + single writer in the booking path | Accepted |
| [0006](architecture/adr/0006-self-contained-privacy-first-site.md) | Self-contained site — the reader is not tracked | Accepted |
| [0007](architecture/adr/0007-roles-and-sessions.md) | Identity is a staff row + session, not one shared token (Staff.gs) | Accepted |

ADR rules (from the ADR index): a rejected decision stays documented; new decisions are written
**before or with** the code that implements them; superseded decisions are marked "superseded by
ADR-XXXX", never deleted.

---

## 2. Binding invariants (change only via a new ADR + the gates)

1. **No auto-confirmation.** Nothing reaches `CONFIRMED` without a staff action *and* a saved
   Calendar event; the UI never claims success before the backend confirms it.
2. **No medical data.** No symptom/diagnosis/medication fields, prompts, logs or URLs — ever.
   The assistant refuses medical questions and booking works with it off.
3. **Zero-Card.** New external service ⇒ no card ⇒ record in `docs/free-tiers.json` +
   `docs/exit-plan.md`; a card field appearing means stop and report.
4. **One Google boundary.** Drive/Sheets/Calendar only via `scripts/google/gateway.js`; profiles
   are git-ignored; `local` adapter keeps CI and fresh clones working.
5. **Config, not code.** Limits/models/hours/chain order come from Script Properties, validated
   by `validateConfig()` / `scripts/check-config.js`; invalid config fails loudly.
6. **One source of truth per fact.** The gap ledger (`docs/map/gaps.json`), the map
   (`docs/map/project.json`), the secrets manifest (`docs/secrets-manifest.json`) — derived pages
   restate, never decide. `check-gap-docs.js` / `check-workflows.js` enforce.
7. **Evidence over claims.** "Done" requires a command + exit code + environment.
8. **Merge only on green.** No direct pushes to `main`; agents never merge; release flow via Release Please.
9. **Demo mode never claims a real confirmation.**
10. **Execution ≠ verification.** The agent that changes code is not the one that passes it;
    the verifier re-runs gates independently (see `docs/OPERATING-PROTOCOL.md §7`).

---

## 3. How to change a decision

1. Write the ADR first (`docs/architecture/adr/NNNN-slug.md`): context → decision → consequences.
2. Reference it in the PR that implements it.
3. If it changes a gate, a threshold, or a public contract — the gate changes in the same PR,
   with its test updated so the old invariant failing is still caught (see `docs/ERROR-REGISTER.md`).
4. `node scripts/check-agent-protocol.js` stays green throughout; if the change invalidates
   anything on this page, this page changes with it — not after.

## 4. Related records

- Gate semantics and evidence format → `docs/QUALITY-GATES.md`
- Incident history behind these decisions → `docs/ERROR-REGISTER.md`
- Task completion rules → `docs/ACCEPTANCE-CRITERIA.md`
- Product acceptance criteria → `docs/prd/acceptance.md`
- Per-task contracts → `docs/OPERATING-PROTOCOL.md §2`
