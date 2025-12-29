#!/usr/bin/env bash
set -euo pipefail

# Deploy Astro site to GitHub User Pages repo (ufdto.github.io)
# Assumes both repos are siblings:
#   ../pechgruen-website   (this repo)
#   ../ufdto.github.io     (deploy repo)

CODE_REPO_NAME="pechgruen-website"
DEPLOY_REPO_NAME="ufdto.github.io"

CODE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARENT_DIR="$(cd "$CODE_DIR/.." && pwd)"
DEPLOY_DIR="$PARENT_DIR/$DEPLOY_REPO_NAME"

echo "==> Code repo:   $CODE_DIR"
echo "==> Deploy repo: $DEPLOY_DIR"

if [[ ! -d "$DEPLOY_DIR/.git" ]]; then
  echo "ERROR: Deploy repo not found at: $DEPLOY_DIR"
  echo "Create/clone it first: cd .. && git clone https://github.com/ufdto/$DEPLOY_REPO_NAME.git"
  exit 1
fi

# Safety checks
if [[ ! -f "$CODE_DIR/package.json" ]]; then
  echo "ERROR: package.json not found in code repo dir."
  exit 1
fi

echo "==> 1) Clean + build (Astro)"
cd "$CODE_DIR"
rm -rf dist
npm run build

if [[ ! -d "$CODE_DIR/dist" ]]; then
  echo "ERROR: dist/ not created. Build failed?"
  exit 1
fi

echo "==> 2) Prepare deploy repo (clean tracked files)"
cd "$DEPLOY_DIR"

# Ensure we're on main (adjust if your deploy repo uses another branch)
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "NOTE: Deploy repo is on branch '$CURRENT_BRANCH' (expected 'main')."
  echo "      If this is intended, continue. Otherwise: git switch main"
fi

# Remove all tracked files from deploy repo working tree
git rm -r --quiet . >/dev/null 2>&1 || true

echo "==> 3) Copy dist/* into deploy repo"
cp -R "$CODE_DIR/dist/"* "$DEPLOY_DIR/"

echo "==> 4) Commit + push deploy repo"
git add -A

if git diff --cached --quiet; then
  echo "Nothing to deploy (no changes)."
  exit 0
fi

# Timestamped commit message (local time)
STAMP="$(date '+%Y-%m-%d %H:%M')"
git commit -m "Deploy $STAMP"
git push

echo "==> DONE: Deployed to https://ufdto.github.io/"
