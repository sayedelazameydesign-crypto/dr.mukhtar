# Agent Operating Protocol — Celia Kids

> **ملخص عربي:** هذا هو البروتوكول الإلزامي لأي وكيل (بشري أو ذكاء اصطناعي) يعمل في هذا المستودع.
> لا تنتقل من مرحلة إلى التالية قبل استيفاء شروط الخروج منها، وإذا واجهت نقصًا في المعلومات أو
> فشلًا في التحقق فتوقف وضّح العائق بدل اختراع نتيجة. التفاصيل التنفيذية وأوامر التحقق الفعلية
> في هذا الملف و `docs/QUALITY-GATES.md`، و`AGENTS.md` يبقى المصدر الأعلى للقواعد.
> أي تغيير يُنفذ دون أدلة فيُعتبر غير منجز.

Binding for any agent (human or AI) working in this repository. `AGENTS.md` is the constitutional
layer (what must never happen); this document is the operational layer (how work flows); and
`docs/QUALITY-GATES.md` is the verification layer (what proves each step). Where they disagree,
`AGENTS.md` wins and this file must be fixed in the same PR.

---

## 1. The six phases

| # | Phase | What happens here | Exit criteria (evidence required) |
|---|-------|-------------------|----------------------------------|
| 1 | **UNDERSTAND** | Identify the objective, deliverable, constraints, exclusions. Resolve ambiguity *before* any risky action. | A one-line objective + explicit out-of-scope list. No edits yet. |
| 2 | **INSPECT** | Read the actual state: files, contracts, tests, `docs/map/`, git log, CI. Never assume an untested connection. | Notes naming the files/commands inspected and what they showed. |
| 3 | **PLAN** | Ordered small steps, risks per step, acceptance check per step. | A written plan naming files to touch and the check that proves each step. |
| 4 | **EXECUTE** | Smallest change satisfying the objective. Preserve architecture and public contracts. No silent scope expansion. | A diff limited to the planned scope; unrelated edits are a defect, not initiative. |
| 5 | **VERIFY** | Run the real tests/gates. Check regressions and side effects. Record commands, outputs, environment (local/CI/live). | `node scripts/check-agent-protocol.js` + the phase-appropriate gates in `docs/QUALITY-GATES.md` all exit 0, with output captured. |
| 6 | **REPORT** | What changed, what was tested, what passed, what failed, what remains unverified. | The final report uses the template in §6 and never claims more than was executed. |

**Transition rule:** a phase may not begin until the previous phase's exit criteria are met.
If a gate fails: stop the operation, state the exact failure, name the missing evidence, propose
the smallest safe recovery action. Never continue past a failed check by declaring it "minor".

**نقص المعلومات = توقف.** Missing information or verification failure is a blocker to report,
never a reason to invent a result, guess a default, or widen the change "until it works".

---

## 2. Per-task contract (عقد تنفيذ)

Before any task beyond a trivial one-line fix, the task must have a contract. Short form is fine;
the fields are not optional:

| Field | Must state |
|---|---|
| **Objective** | The final goal, one sentence |
| **Scope** | Files/components allowed to change |
| **Constraints** | What must be preserved (contracts, gates, data) |
| **Forbidden Actions** | What the agent may not do (deploy, merge, touch live Google account, …) |
| **Acceptance Criteria** | The conditions that make the result acceptable — each mapped to `docs/ACCEPTANCE-CRITERIA.md` or a named test |
| **Verification** | The exact commands/evidence required at handover |
| **Completion** | When the task is considered done (see §5) |

Example of a contract done right (instead of "حسّن نظام الذاكرة وأصلح الأخطاء"):

> Inspect the memory subsystem read-only first. List the proven defects; do not modify Core or
> public contracts. Propose a limited repair plan and name the test for each defect. Do not start
> implementation before the plan is approved. After implementation, prove data survives a restart
> and that existing functionality is unaffected. A green CI run alone is not proof of live behavior
> when live behavior is what the task required.

---

## 3. Truth and evidence

No `PASS` is accepted without: the command run, its exit code, and the environment it ran in
(local sandbox / CI / a real Google account). Distinguish mocked results from real provider
responses. Use these statuses — never a bare "done":

- `VERIFIED` — executed and observed, with output
- `IMPLEMENTED_NOT_VERIFIED` — code landed, verification pending or impossible here
- `NOT_EXECUTED` — planned but not run
- `BLOCKED` — stopped by a named prerequisite
- `FAILED` — executed and failed, with the error
- `NOT_APPLICABLE` — does not apply, with reason

Full gate semantics: `docs/QUALITY-GATES.md`. Past incidents this protocol exists to prevent:
`docs/ERROR-REGISTER.md`. Approved invariants: `docs/DECISIONS.md`.

---

## 4. Failure recovery

1. Capture the actual error (full output, not a paraphrase).
2. Determine the root cause; if unknown, say unknown and stop — do not "fix" by guessing.
3. Identify affected components and blast radius.
4. Propose the smallest correction, inside authorized scope.
5. Apply it, re-run the relevant tests, check for regressions.
6. If the same fix fails twice, stop and report: repeating a failed command is a defect, not persistence.

---

## 5. Completion definition

A task is complete only when **all** of these hold:

- Requested deliverables exist (files, commits, PRs).
- Acceptance criteria from the task contract are satisfied.
- Required tests were **executed** (not merely "expected to pass").
- Results are recorded, and persistent state is confirmed when persistence is required.
- Anything not verified is listed explicitly as such.

If any mandatory condition is missing, the task is `INCOMPLETE` — say so.

---

## 6. Final report template

```
Objective:        what was asked
Initial state:    branch, HEAD, what existed before
Planned changes:  the plan that was approved/used
Actual changes:   what really changed (files, commits)
Tests executed:   command → exit code → environment (local/CI/live)
Evidence:         outputs, links, run ids
Risks/limitations: what could be wrong, what was not checked
Remaining work:   what is still open, by whom
Final status:     COMPLETE (VERIFIED) | INCOMPLETE (why)
```

---

## 7. Multi-agent note

If several agents work on this repository, one supervises (scope, gates, stop authority) and the
others execute in separate contexts. **Execution and verification are never the same context**:
the agent that changes the booking path is not the agent that declares it verified; the verifier
re-runs the gates independently. See `docs/ARCHITECTURE.md` and `scripts/ai-*.js` (the automated
repair pipeline) for how this separation is mechanised — with one human at the merge button,
always.
