# Secrets & Variables — `sayedelazameydesign-crypto/dr.mukhtar`

Cost: **$0, no card**. Checked: 2026-11 | Re-verify every 90 days.
Machine-readable source of truth: [`docs/secrets-manifest.json`](./secrets-manifest.json).
This page is the human summary; both are validated in CI by `scripts/check-workflows.js`.

## 1. Current state

| Store | Count | Notes |
| --- | --- | --- |
| Repository secrets | **0** | **intentionally empty** — nothing here needs one |
| Repository variables | **0** | **intentionally empty** — defaults in the workflows cover CI |
| Environment secrets (`production`) | **0** | environment does not exist; only a manual deployment checklist would use it |
| Dependabot secrets | 0 | not needed (Dependabot PRs only run dependency checks) |

Nothing in this repository needs a secret to build, test, or deploy the site:
CI runs entirely on mocked providers, and the published site is demo-mode only.

**Zero is the correct state, not an unfinished setup.** A contributor who sees "0 secrets"
should not conclude that something is missing — the *names* are declared (§2), validated in CI,
and the deployment branch fails if a workflow references an undeclared name. The only value that
must exist for production lives in Apps Script Script Properties (§5), never in GitHub.

The clinic's own settings (clinic/doctor identity, hours, visit types, staff PIN) deliberately have
**no** secret here: they are non-sensitive data edited from the dashboard and stored in the clinic
sheet. See [`settings.md`](./settings.md).

## 1b. `GROQ_API_KEY` is a reserved name with no consumer

`GROQ_API_KEY` is declared in the manifest but **nothing consumes it**: `Llm.gs` never reads it
and no workflow passes it. Its presence in `.env.example` and in this table can read as
"required", so treat it as a **reserved slot, not a setup step**: do not set it, and do not
treat its absence as missing configuration. Adding the provider to `Llm.gs` comes first; the
secret follows.

## 2. What is declared (names only — never values)

| Name | Kind | Level | Used by | Card |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | secret | repo | optional live smoke test; runtime value lives in Script Properties | no |
| `GROQ_API_KEY` | secret | repo | reserved name for the fallback provider slot (not implemented) | no |
| `WAAPI_API_TOKEN` | secret | repo | manual Actions read-only WAAPI check; not used by the runtime | no card for the advertised trial; paid terms unverified |
| `CELIA_ADMIN_PIN` | secret | environment `production` | deployment checklist only | no |
| `APP_ENV` | variable | repo | workflows (`ci` / `preview` / `production`) | — |
| `NODE_VERSION` | variable | repo | workflows (`20`) | — |
| `LLM_PRIMARY` | variable | repo | live smoke test model choice (`gemini`) | — |
| `LLM_SMOKE_ENABLED` | variable | repo | `false` normally; `true` makes a missing key a hard failure | — |
| `PYTHON_VERSION` | variable | repo | Pages workflow (Apps Script bundle build), `3.11` | — |

Rule of thumb: **doubt → secret**. Variables are printed verbatim in the UI and logs.

## 3. First-time setup (values stay with you)

UI (paste values by hand, never in chat):
- Secrets: <https://github.com/sayedelazameydesign-crypto/dr.mukhtar/settings/secrets/actions>
- Variables: <https://github.com/sayedelazameydesign-crypto/dr.mukhtar/settings/variables/actions>

CLI (`gh`). `gh secret set NAME` without `--body` prompts on a hidden line, so the value never
lands in shell history. **Never** use `--body` for a secret.

```bash
# variables (non-sensitive, safe to pass with --body)
gh variable set APP_ENV          --body "ci"     --repo sayedelazameydesign-crypto/dr.mukhtar
gh variable set NODE_VERSION     --body "20"     --repo sayedelazameydesign-crypto/dr.mukhtar
gh variable set LLM_PRIMARY      --body "gemini" --repo sayedelazameydesign-crypto/dr.mukhtar
gh variable set LLM_SMOKE_ENABLED --body "false" --repo sayedelazameydesign-crypto/dr.mukhtar

# secrets (prompted, hidden input)
gh secret set GEMINI_API_KEY --repo sayedelazameydesign-crypto/dr.mukhtar

# environment-scoped secret (create the environment first)
gh api -X PUT repos/sayedelazameydesign-crypto/dr.mukhtar/environments/production
gh secret set CELIA_ADMIN_PIN --env production --repo sayedelazameydesign-crypto/dr.mukhtar
```

Verify names only (values are unreadable by design):

```bash
gh secret list   --repo sayedelazameydesign-crypto/dr.mukhtar
gh variable list --repo sayedelazameydesign-crypto/dr.mukhtar
```

## 4. How workflows consume them

```yaml
env:                        # non-sensitive only
  APP_ENV: ${{ vars.APP_ENV || 'ci' }}
steps:
  - name: Probe the configured provider
    env:                    # scoped to the step that needs it
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
    run: node scripts/live-llm-smoke.js
```

- Secrets always arrive through `env:`; they are never inlined inside `run:` text. The contract
  checker fails the build if you do.
- The live smoke job is skipped for **all** PRs, including same-repository PRs. It runs only
  on a push to `main` or a manual dispatch on `main`, and only when `LLM_SMOKE_ENABLED` is
  exactly `true`. This reduces accidental exposure to PR code; it does not protect a repository
  secret from someone who can change the workflow itself. Restrict repository write access and
  independently verify branch and environment protection; this workflow cannot prove them.
- Environment secrets are invisible to any job without `environment: production`.

## 4b. Three stores, one set of names

| Store | Holds values? | How it is kept in sync |
| --- | --- | --- |
| GitHub Actions | yes (write-only) | `docs/secrets-manifest.json` is the name list; CI rejects unknown names |
| Local `.env` | yes (never committed) | `cp .env.example .env`; `.env` is git-ignored |
| Colab Secrets (third store) | yes, only if a notebook needs it | same names via `google.colab.userdata`; nothing runs in Colab today |

Colab (only if you later add a notebook):

```python
from google.colab import userdata
import os
os.environ['GEMINI_API_KEY'] = userdata.get('GEMINI_API_KEY')   # name must match the manifest
```

Dependabot has its own store: PRs from Dependabot see **only** Dependabot secrets. Currently it
needs none — do not duplicate production keys there. If a dependency PR ever must run a live probe,
add a throwaway key there instead.

Local sanity check before pushing (never prints values):

```bash
node scripts/env.js          # presence + format only
sh scripts/pre-commit.sh     # secrets scan + workflow contract
```

## 5. Runtime (Apps Script) is the real home

The clinic backend reads configuration from **Script Properties**, not from GitHub. Same names,
same rules — see [`config/clinic.example.json`](../config/clinic.example.json) and
`node scripts/check-config.js`. `CELIA_ADMIN_PIN` in GitHub is only for the deployment checklist;
the value that actually guards the dashboard is the Script Property `ADMIN_PIN_HASH` — a SHA-256
hash written by `initializeCeliaKids()`. The plain PIN is never stored anywhere: the first run
returns a generated PIN **once**, and it is then replaced from the dashboard.

## 6. Rotation

Every 90 days, on staff change, or on any suspicion:

1. Revoke at the provider → 2. create a new key → 3. update the GitHub secret **and** the Script
Property → 4. if it was ever committed, purge history → 5. set `rotated` in
`docs/secrets-manifest.json`.

Re-run the workflow afterwards (old runs keep old values).

**The clock is now a command, not a sentence:**

```bash
node scripts/rotation-reminders.js            # report: ok / due soon / overdue / never set
node scripts/rotation-reminders.js --json     # machine-readable (for an external reminder)
```

It reads `rotation_days` and `rotated` from `docs/secrets-manifest.json` **only** — never a
value, never GitHub, never Apps Script — and it exits `1` only when a rotation is past its due
date plus a grace window (`--max-days`, default 45). `rotated: null` means "declared, never
rotated yet": reported as `never-set`, not as a failure. `ci.yml` runs it on every push.

### Two copies of one key: which one is authoritative

`GEMINI_API_KEY` exists twice by design, and the copies are **not** synced:

| Copy | Purpose | If it goes stale |
| --- | --- | --- |
| GitHub Secret | the gated live smoke test (`LLM_SMOKE_ENABLED=true`) | the smoke test fails; the site is unaffected |
| Apps Script Script Property | the runtime the assistant actually calls | the assistant answers with an error; **booking still works** |

When you rotate, do both in the same sitting and record the date once. Building an automatic
GitHub → Apps Script sync needs OAuth, a trusted bridge and extra scopes: deliberately out of
scope for the first MVP, and NOT required for booking, which never calls Gemini.

## 7. Guard rails in this repo

- `node scripts/check-workflows.js` — manifest shape, unknown `secrets.X`/`vars.X`, inline secrets,
  `printenv`/`set -x`/`echo $SECRET`, `pull_request_target` head checkout, self-hosted runners,
  unpinned actions, missing `timeout-minutes`, missing `permissions:`, `.env.example` parity.
  `--self-test` proves each rule by building deliberately unsafe fixtures (9 cases).
- `node scripts/scan-secrets.js` — dependency-free scan of tracked files (11 rules).
- `actionlint` on the runner + `gitleaks` as a second layer.
- `.github/CODEOWNERS` requires owner review for workflow changes; enable branch protection on
  `main` (Settings → Branches) so `.github/workflows/**` cannot be edited unreviewed.
- `.env` is git-ignored; `.env.example` carries names with empty values only.

## 7b. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Value empty in a job | fork PR or Dependabot PR (expected) · secret lives in `production` but the job has no `environment:` · typo in the name (case-insensitive, spelling is not) |
| `vars.X` empty | variable not created, or created at environment level while the job has no `environment:` |
| Value truncated/garbled | trailing newline or quotes pasted — re-add cleanly; multiline values (PEM/JSON) should be base64-encoded and decoded in the step |
| Changed secret not picked up | re-run the workflow; old runs keep old values |
| Live smoke skipped | `GEMINI_API_KEY` unset — expected; set `LLM_SMOKE_ENABLED=true` if you want that to be an error |
| Contract job fails with "not declared in docs/secrets-manifest.json" | add the name to the manifest + `.env.example` + `scripts/env.js` in the same PR |

## 7b-2. Check the current state (names only)

```bash
node scripts/setup-github.js        # uses an existing authenticated token; no values in output
```

Or run **Setup status** (Actions → Setup status → Run workflow; also scheduled weekly).
The comparison reports missing **required** names separately from optional names; it reports
inaccessible lists and environment-secret names requiring manual review as **NOT VERIFIED**
(exit 2), not as missing or as a successful check. It does not establish runtime configuration,
branch protection or secret validity. GitHub may return variable values in its API response, but
this checker only outputs names and status, never values or response bodies.

> The automatic workflow's `GITHUB_TOKEN` has limited permissions and the comparison has returned
> HTTP 403 for this repository. Review names under Settings → Secrets and variables → Actions and
> environment settings in GitHub's UI. Do not add a broadly privileged token just to make this
> report green, and never send any secret or token in chat. GitHub documents repository Secrets
> read access for its list endpoint: https://docs.github.com/en/rest/actions/secrets.

## 7c. Not yet applied (token limitation) — do these once in the UI

This session's GitHub token cannot modify environments or branch protection (HTTP 403), so the
following are documented rather than applied:

1. **Branch protection on `main`** — Settings → Branches → Add rule:
   require a PR before merging, require review from CODEOWNERS, require the `CI` status check,
   disallow force pushes. CLI equivalent:

   ```bash
   gh api -X PUT repos/sayedelazameydesign-crypto/dr.mukhtar/branches/main/protection \
     -H "Accept: application/vnd.github+json" \
     -F "required_status_checks[strict]=true" \
     -F "required_status_checks[contexts][]=quality" \
     -F "enforce_admins=true" \
     -F "required_pull_request_reviews[required_approving_review_count]=1" \
     -F "restrictions=null"
   ```

2. **`production` environment** (needed before `gh secret set CELIA_ADMIN_PIN --env production`):

   ```bash
   gh api -X PUT repos/sayedelazameydesign-crypto/dr.mukhtar/environments/production
   ```

   Optionally add required reviewers so a deploy needs a human approval.

## 8. What an AI agent may and may not do

Allowed: read this page and the manifest, add a **name** to the manifest + `.env.example`, write
workflows that reference `secrets.NAME`/`vars.NAME`, run the validators, and tell you the URLs.
Forbidden: asking for a value, writing a value to any file, echoing an environment dump, or
pasting a value into a PR/issue/log.
