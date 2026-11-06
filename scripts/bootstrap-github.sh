#!/usr/bin/env sh
# One-shot owner bootstrap for the four steps an agent token cannot perform:
# environment, variables, secrets (prompted), and optional branch protection.
#
#   sh scripts/bootstrap-github.sh              # do everything, prompting for secrets
#   sh scripts/bootstrap-github.sh --dry-run    # show exactly what would run
#   sh scripts/bootstrap-github.sh --no-protect # skip branch protection
#
# Rules baked in: values are only ever entered through a hidden prompt —
# this script never accepts a secret as an argument and never echoes one.

set -u

REPO="${REPO:-sayedelazameydesign-crypto/dr.mukhtar}"
ENVIRONMENT="${ENVIRONMENT:-production}"
DRY_RUN=0
PROTECT=1

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-protect) PROTECT=0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    say "  [dry-run] $*"
  else
    say "  → $*"
    "$@" || say "  ! failed: $*"
  fi
}

command -v gh >/dev/null 2>&1 || { say "gh CLI is required (winget install GitHub.cli / brew install gh)"; exit 1; }
gh auth status >/dev/null 2>&1 || { say "Not signed in. Run: gh auth login"; exit 1; }

say "Repository: $REPO"
say "Mode: $([ "$DRY_RUN" -eq 1 ] && echo 'dry-run (no changes)' || echo 'apply')"
say ""

say "1/4 environment \"$ENVIRONMENT\""
run gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" --silent
say ""

say "2/4 variables (non-sensitive, from docs/secrets-manifest.json defaults)"
set_var() { run gh variable set "$1" --body "$2" --repo "$REPO"; }
set_var APP_ENV           "ci"
set_var NODE_VERSION      "20"
set_var PYTHON_VERSION    "3.11"
set_var LLM_PRIMARY       "gemini"
set_var LLM_SMOKE_ENABLED "false"
say ""

say "3/4 secrets (hidden prompt — nothing is passed as an argument)"
say "  Optional. Press Ctrl-C to stop here; booking works without them."
if [ "$DRY_RUN" -eq 1 ]; then
  say "  [dry-run] gh secret set GEMINI_API_KEY --repo $REPO"
  say "  [dry-run] gh secret set CELIA_ADMIN_PIN --env $ENVIRONMENT --repo $REPO"
else
  if say "" && gh secret set GEMINI_API_KEY --repo "$REPO"; then say "  ✓ GEMINI_API_KEY set"; else say "  · skipped GEMINI_API_KEY"; fi
  if gh secret set CELIA_ADMIN_PIN --env "$ENVIRONMENT" --repo "$REPO"; then say "  ✓ CELIA_ADMIN_PIN set"; else say "  · skipped CELIA_ADMIN_PIN"; fi
fi
say ""

if [ "$PROTECT" -eq 1 ]; then
  say "4/4 branch protection on main"
  # The required context must be the *check run* name — the CI job's display name,
  # not its YAML id. In .github/workflows/ci.yml the job id is `quality` but the
  # job name ("lint · typecheck · test · build · audit") is what GitHub reports
  # as the context. Pinning a context that never runs would block every merge.
  run gh api -X PUT "repos/$REPO/branches/main/protection" \
    -H "Accept: application/vnd.github+json" \
    -F "required_status_checks[strict]=true" \
    -F "required_status_checks[contexts][]=lint · typecheck · test · build · audit" \
    -F "enforce_admins=true" \
    -F "required_pull_request_reviews=null" \
    -F "restrictions=null" \
    --silent
else
  say "4/4 branch protection skipped (--no-protect)"
fi
say ""

say "Verify (names only, never values):"
if [ "$DRY_RUN" -eq 1 ]; then
  say "  [dry-run] node scripts/setup-github.js"
else
  node scripts/setup-github.js || say "  · some names are still missing; see the list above"
fi
