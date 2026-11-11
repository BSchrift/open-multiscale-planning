#!/usr/bin/env bash
# Whether this checkout's web bundle works alongside the last released one: builds both, then runs frontend/e2e/compat.
# On one device they share a database both ways, as an update and a rollback after its failed trial do, and as two
# devices of one user they sync with each other.
#   BASE is the old bundle's commit. By default it's the oldest version any of prod's surfaces serves, the web app or a
#   feed, when the config folder ($MULTISCALE_CONFIG_DIR, or config/ in the repo) has prod's outputs, else origin/main.
#   ENV=local (default) syncs through a local stack, which scripts/e2e.sh compat starts before running this again.
#   ENV=staging syncs through staging as integration.testUser in staging.yaml, as scripts/e2e.sh does off local.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:-local}"
case "$env_name" in local | staging) ;; *) echo "ENV must be local or staging, not $env_name" >&2; exit 1 ;; esac
# Relative to where this was run, since the builds run elsewhere.
case "${MULTISCALE_CONFIG_DIR:-/}" in /*) ;; *) export MULTISCALE_CONFIG_DIR="$PWD/$MULTISCALE_CONFIG_DIR" ;; esac

outputs="${MULTISCALE_CONFIG_DIR:-$root/config}/prod.outputs.json"
if [ -z "${BASE:-}" ] && [ -f "$outputs" ]; then
  # The oldest bundle a device of prod's may run, which a rollback after a failed trial goes back to too. Its version
  # ends in the commit it was built from.
  if ! version="$(node "$root/frontend/scripts/compat-base.ts" "$outputs")"; then
    echo "Couldn't read the versions prod serves, from the outputs in $outputs. Set BASE to the commit to test against." >&2
    exit 1
  fi
  BASE="${version##*-}"
fi
export BASE="${BASE:-origin/main}"
if ! git -C "$root" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
  echo "$BASE isn't a commit in this clone. Run git fetch, or set BASE." >&2
  exit 1
fi

# e2e.sh starts the local stack, and runs this again with LOCAL_API_URL set.
[ "$env_name" != local ] || [ -n "${LOCAL_API_URL:-}" ] || exec "$root/scripts/e2e.sh" compat

work="$(mktemp -d)"
clean_up() {
  git -C "$root" worktree remove --force "$work/base" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap clean_up EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Old bundle: $BASE ($(git -C "$root" rev-parse --short "$BASE^{commit}")). New bundle: this checkout."
git -C "$root" worktree add --quiet --detach "$work/base" "$BASE"
ln -s "$root/frontend/node_modules" "$work/base/frontend/node_modules"
# Development builds, like the stack specs' dev server: only they let a spec seed records. Each built for the backend the
# specs sign in to, which ENV and LOCAL_API_URL pick.
build() { (cd "$1/frontend" && NODE_ENV=development npx vite build --outDir "$2" --emptyOutDir --logLevel warn); }
build "$work/base" "$work/old"
build "$root" "$work/new"

cd "$root/frontend"
if [ "$env_name" != local ]; then
  # Run from scripts/test-deployed.sh, it's already read, test user's password and all.
  MULTISCALE_TARGET="${MULTISCALE_TARGET:-$(node scripts/test-target.mjs)}"
  export MULTISCALE_TARGET
fi
COMPAT_OLD="$work/old" COMPAT_NEW="$work/new" npx playwright test -c e2e/compat/playwright.config.ts
