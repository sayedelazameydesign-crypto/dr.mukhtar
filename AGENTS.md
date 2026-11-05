# AGENTS.md — Celia Kids

Single source of truth for any AI agent (or human) working in this repository.
Compatible client rule files (`CLAUDE.md`, etc.) should stay thin and point here.

## 1. What this is

Arabic (RTL) booking-intake site for a single paediatric clinic. A guardian files a
request; **staff approval is the only path to a confirmed appointment**. Guardian
contact data only — **no medical data, ever**.

Three runtimes, one source of truth:

| Layer | Files | Runtime |
| --- | --- | --- |
| Static site | `index.html`, `app.css`, `app.js`, `assets/` | any static host (GitHub Pages) |
| Backend | `Code.gs` (domain), `Llm.gs` (LLM adapter) | Google Apps Script |
| Tooling | `scripts/*.py`, `scripts/*.js` | Node 20 / Python 3.11 |

`gas/` is **generated** (git-ignored). Never edit it; rebuild instead.

## 2. Non-negotiable rules

1. **No auto-confirmation.** A guardian request is never `CONFIRMED` without a staff
   action *and* a successfully saved Calendar event. Never render a success claim
   before the backend confirms it.
2. **No medical data.** No symptom/diagnosis/medication fields, prompts, logs or URLs.
   The assistant refuses medical questions and is optional; booking must work with it off.
3. **No secrets in the repo.** Keys live in Script Properties or GitHub Secrets.
   If a secret leaks: rotate first, then clean history.
4. **Secrets: names only.** GitHub secrets/variables and their metadata live in
   `docs/secrets-manifest.json`; the human guide is `docs/secrets.md`. An agent may add a *name*
   (plus `.env.example` entry and workflow reference) in the same PR — never a value, never a
   `--body` secret, never asking the user for a value. Workflow rules: secrets via `env:` only,
   never inlined in `run:`; skip secret-dependent jobs on fork PRs; environment secrets for deploy;
   never upload `.env`/properties files as artifacts (the contract checker enforces this).
5. **Provider boundaries.** `Code.gs` must never build provider URLs or name models.
   All LLM work goes through `llmAnswer_()` in `Llm.gs`. Calendar/Sheets access stays
   inside `getCalendar_*`, `*Sheet_*` helpers so a provider swap is one file.
6. **One Google boundary, one swappable account.** Drive/Sheets/Calendar are reached only through
   `scripts/google/gateway.js`; the active account is a *profile* (`config/google.profile.<name>.json`,
   git-ignored) selected by `GOOGLE_PROFILE`. No email, no raw Drive id and no account name in code.
   Google must never be a hard dependency: the `local` adapter runs CI and every fresh clone.
   Console steps and the A→B swap runbook: `docs/google-setup.md`.
7. **Config, not code.** Limits, models, work hours and chain order come from Script
   Properties, validated by `validateConfig()` / `scripts/check-config.js`. Invalid
   config fails loudly — never silently substitute a "sensible" default.
8. **Zero-Card.** Any new external service: email/GitHub/Google sign-up only, no card,
   no card-trial. Record it in `docs/free-tiers.json` with `card_required` and fallback,
   and add a line to `docs/exit-plan.md`. If a card field appears: stop and report.
9. **No silent failure.** Errors are typed, logged as structured JSON (no PII), and
   surfaced to staff. `catch (_) {}` is only acceptable for cosmetic UI storage.
10. **Evidence over claims.** "Done" requires a command + output (tests, build, `curl`).

## 3. Commands

```bash
python3 scripts/preview.py                  # local preview on 0.0.0.0:8080 (hides gas/, scripts/, dotfiles)
node scripts/test-gas-simulated.js          # backend: locking, conflicts, outages, queues
node scripts/test-llm-adapter.js            # adapter: retry/backoff, circuit, budget, cache, PII, sanitising
node scripts/test-ui-smoke.js               # DOM journey (needs: npm i --no-save jsdom@25)
node scripts/test-demo-availability.js      # demo slots respect visit duration + work hours (jsdom)
node scripts/check-config.js [props.json]   # config contract
node scripts/scan-secrets.js                # dependency-free secret scan (always on in CI)
node scripts/check-workflows.js [--self-test]  # secrets/variables + workflow + docs/map contract
node scripts/env.js                         # startup env contract (names only, never values)
node scripts/live-llm-smoke.js              # optional provider probe (env only; skips without a key)
node scripts/test-google-bridge.js          # Google gateway + adapters, offline (no account, no token)
node scripts/google/selftest.js --local     # five-step probe on the local adapter
node scripts/google/bootstrap.js --dry-run  # what the Drive layout bootstrap would create (needs a live token)
sh scripts/pre-commit.sh                    # local gate: secrets + contract (+ actionlint if installed)
python3 scripts/build-gas-package.py        # build gas/ bundle (Index.html, Fonts.html, Code.gs, Llm.gs)
```

CI (`.github/workflows/ci.yml`) runs: workflow/secrets contract (+actionlint) → JS/Python syntax →
backend tests → adapter tests → UI smoke → bundle build → self-containment guard → config contract →
free-tier ledger → secret scan (built-in + gitleaks) → audit, and an optional live LLM smoke job that
is skipped for fork PRs. **Merge only on green.**

## 4. Architecture map

Machine-readable map lives in `docs/map/` (`project.json`, `ARCHITECTURE.md`, `gaps.json`).
Google services are reached only through `scripts/google/gateway.js`; account/profile rules: `docs/google-setup.md`.

**If `docs/map/` is missing or its `meta.commit` is behind HEAD → follow `project-map.md` before coding.**
`node scripts/check-workflows.js` fails when the map is missing, unparseable, cites an undeclared node,
or drops a declared secret/variable name; a stale `meta.commit` is a warning (fails under `--strict`).
New module, route, env name, table or provider → update the map in the same PR.


- `app.js`: `api()` is the only backend bridge (demo `localStorage` vs `google.script.run`).
  `callServer()` is the single place where the GAS transport lives.
- `Code.gs`: `doGet`, `getAvailableSlots`, `createRequest`, `lookupBooking`, `getDashboard`,
  `approveRequest`, `proposeAlternative`, `moveConfirmedAppointment`, `cancelRequest`,
  `completeRequest`, `closeDay`, `askGeneralQuestion`, `validateConfig`, `llmStatus`.
  All writes take `LockService`; availability is re-checked at approval.
- `Llm.gs`: `llmAnswer_` (entry), `LLM.PROVIDERS` (adapters), budget/circuit/cache helpers.
- Availability cache: 30 s read cache only — never used for approval decisions.

## 5. Style

- `'use strict'`, ES2017-safe JS (Apps Script V8), no new dependencies for the site.
- Python: stdlib only, `pathlib`, type hints, cross-platform paths.
- Arabic UI copy: clear, warm, non-medical. Numbers can be Arabic-Indic (`toLocaleString('ar-EG')`).
- Names over comments; comments explain *why* (especially policy and safety choices).
- Keep PRs ≤ ~400 changed lines, one concern. Conventional Commits (`feat:`, `fix:`, `chore:`).

## 6. Change checklist

- [ ] `python3 scripts/build-gas-package.py` succeeds; `gas/` not committed
- [ ] All five scripts above exit 0
- [ ] No new external URL, model name or limit hardcoded in `Code.gs`/`app.js`
- [ ] `docs/free-tiers.json` + `docs/exit-plan.md` updated if a provider/limit changed
- [ ] New secret/variable? → manifest + `.env.example` + workflow + `docs/secrets.md` in the same PR
- [ ] `node scripts/check-workflows.js` and `node scripts/scan-secrets.js` pass
- [ ] README/TODO reflect the change; no TODO left without an issue
- [ ] Demo mode never claims a real confirmation
