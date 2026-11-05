#!/usr/bin/env sh
# One-time Pages enablement for an owner session (see docs/publish.md §3).
#
#   sh scripts/enable-pages.sh [--dry-run]
#
# Why this exists: GITHUB_TOKEN cannot CREATE a Pages site (403 — needs
# administration:write). configure-pages can, but only with a token that has
# Pages + Administration write. So this script, run by YOU and never by an
# agent, sets the two opt-in names the workflow already supports, triggers the
# deploy, then deletes both again — they must not outlive the first run.
#
# It never prints or echoes a token, and never passes one as an argument.
set -u

REPO="${PAGES_REPO:-sayedelazameydesign-crypto/dr.mukhtar}"
WORKFLOW="Deploy site"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) echo "usage: sh scripts/enable-pages.sh [--dry-run]"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

echo "→ Pages enablement for $REPO"
if [ "$DRY_RUN" -eq 0 ]; then
  if ! gh auth status >/dev/null 2>&1; then
    echo "gh is not authenticated. Run: gh auth login" >&2
    exit 2
  fi
  # Fail early if the site already exists: nothing to do, and the secrets should stay absent.
  if gh api "repos/$REPO/pages" >/dev/null 2>&1; then
    echo "Pages is already enabled for $REPO — nothing to do."
    echo "If the last deploy failed, re-run: gh workflow run \"$WORKFLOW\" --repo $REPO"
    exit 0
  fi
fi

echo "→ 1/4 opt in (workflow runs the creation step only when this is 'true')"
run gh variable set PAGES_AUTO_ENABLE --body true --repo "$REPO"

echo "→ 2/4 store the owner PAT (hidden prompt — paste a fine-grained token with"
echo "     Pages: read+write and Administration: read+write on this repo only)"
run gh secret set PAGES_TOKEN --repo "$REPO"

echo "→ 3/4 trigger the deploy"
run gh workflow run "$WORKFLOW" --repo "$REPO"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "→ 4/4 [dry-run] would watch the run, then delete PAGES_TOKEN + PAGES_AUTO_ENABLE"
  echo "Dry run complete — nothing was changed."
  exit 0
fi

echo "→ 4/4 watch the run"
sleep 5
RUN_ID=$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 1 --json databaseId -q '.[0].databaseId')
echo "   run $RUN_ID"
gh run watch "$RUN_ID" --repo "$REPO" --exit-status || {
  echo "Deploy failed. Inspect: gh run view $RUN_ID --repo $REPO --log-failed" >&2
  echo "The two names are kept so you can re-run; delete them once it is green." >&2
  exit 1
}

echo "→ cleanup: the enablement token is no longer needed"
gh secret delete PAGES_TOKEN --repo "$REPO" || true
gh variable delete PAGES_AUTO_ENABLE --repo "$REPO" || true

echo "Pages is live: https://$(echo "$REPO" | cut -d/ -f1 | tr 'A-Z' 'a-z').github.io/$(echo "$REPO" | cut -d/ -f2)/"
echo "Verify: curl -sI https://$(echo "$REPO" | cut -d/ -f1 | tr 'A-Z' 'a-z').github.io/$(echo "$REPO" | cut -d/ -f2)/ | head -1"
