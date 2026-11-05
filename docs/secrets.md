# Secrets & Variables — `sayedelazameydesign-crypto/dr.mukhtar`

Cost: **$0, no card**. Checked: 2026-11 | Re-verify every 90 days.
Machine-readable source of truth: [`docs/secrets-manifest.json`](./secrets-manifest.json).
This page is the human summary; both are validated in CI by `scripts/check-workflows.js`.

## 1. Current state

| Store | Count | Notes |
| --- | --- | --- |
| Repository secrets | **0** | none set yet |
| Repository variables | **0** | none set yet |
| Environment secrets (`production`) | **0** | environment does not exist yet |
| Dependabot secrets | 0 | not needed (Dependabot PRs only run dependency checks) |

Nothing in this repository needs a secret to build, test, or deploy the site:
CI runs entirely on mocked providers, and the published site is demo-mode only.

## 2. What is declared (names only — never values)

| Name | Kind | Level | Used by | Card |
| --- | --- | --- | --- | --- |
| `GEMINI_API_KEY` | secret | repo | optional live smoke test; runtime value lives in Script Properties | no |
| `GROQ_API_KEY` | secret | repo | reserved name for the fallback provider slot (not implemented) | no |
| `CELIA_ADMIN_PIN` | secret | environment `production` | deployment checklist only | no |
| `APP_ENV` | variable | repo | workflows (`ci` / `preview` / `production`) | — |
| `NODE_VERSION` | variable | repo | workflows (`20`) | — |
| `LLM_PRIMARY` | variable | repo | live smoke test model choice (`gemini`) | — |
| `LLM_SMOKE_ENABLED` | variable | repo | `false` normally; `true` makes a missing key a hard failure | — |

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
- The live smoke job is skipped for fork PRs (`if: github.event.pull_request.head.repo.fork != true`),
  because forks cannot read repository secrets by design.
- Environment secrets are invisible to any job without `environment: production`.

## 5. Runtime (Apps Script) is the real home

The clinic backend reads configuration from **Script Properties**, not from GitHub. Same names,
same rules — see [`config/clinic.example.json`](../config/clinic.example.json) and
`node scripts/check-config.js`. `CELIA_ADMIN_PIN` in GitHub is only for the deployment checklist;
the value that actually guards the dashboard is the Script Property `ADMIN_PIN`.

## 6. Rotation

Every 90 days, on staff change, or on any suspicion:

1. Revoke at the provider → 2. create a new key → 3. update the GitHub secret **and** the Script
Property → 4. if it was ever committed, purge history → 5. set `rotated` in
`docs/secrets-manifest.json`.

Re-run the workflow afterwards (old runs keep old values).

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

## 8. What an AI agent may and may not do

Allowed: read this page and the manifest, add a **name** to the manifest + `.env.example`, write
workflows that reference `secrets.NAME`/`vars.NAME`, run the validators, and tell you the URLs.
Forbidden: asking for a value, writing a value to any file, echoing an environment dump, or
pasting a value into a PR/issue/log.
