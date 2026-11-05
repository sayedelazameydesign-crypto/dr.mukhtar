#!/usr/bin/env sh
# Local pre-commit gate (Git hooks are not committed; install with:
#   cp scripts/pre-commit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
#   # or: ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit
set -eu

echo "→ secret scan"
node scripts/scan-secrets.js --all

echo "→ workflow/secrets contract + project map"
node scripts/check-workflows.js

echo "→ startup env contract"
node scripts/env.js >/dev/null

if command -v actionlint >/dev/null 2>&1; then
  echo "→ actionlint"
  actionlint
else
  echo "· actionlint not installed locally (CI still runs it); skipping"
fi

echo "pre-commit OK"
