#!/usr/bin/env bash
# The app end to end: screens in the browser build at desktop and phone sizes, then the browser build as two devices
# signed in to a local stack started for them, then the core database tests under Electron's runtime, then the real
# Electron app, also as two devices on that stack.
#   ENV=local (default). ENV=staging, or ENV=prod with CONFIRM_PROD=yes, runs only the signed-in specs, against that
#   deployment as integration.testUser in <env>.yaml, with its password from SSM (scripts/test-target.mjs).
#   The config folder is $MULTISCALE_CONFIG_DIR, or config/ in the repo.
#   With ENV=local, arguments pick the parts that run, all of them by default, so CI can give each a job of its own.
#   scripts/e2e.sh [browser] [stack] [electron]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:-local}"
# Relative to where this was run, since everything below runs in frontend/.
case "${MULTISCALE_CONFIG_DIR:-/}" in /*) ;; *) export MULTISCALE_CONFIG_DIR="$PWD/$MULTISCALE_CONFIG_DIR" ;; esac

case "$env_name" in
  local | staging) ;;
  prod)
    if [ "${CONFIRM_PROD:-}" != yes ]; then
      echo "Running against prod needs CONFIRM_PROD=yes" >&2
      exit 1
    fi
    ;;
  *) echo "ENV must be local, staging or prod, not $env_name" >&2; exit 1 ;;
esac
cd "$root/frontend"

if [ "$env_name" != local ]; then
  # Run from scripts/test-deployed.sh, it's already read, test user's password and all.
  MULTISCALE_TARGET="${MULTISCALE_TARGET:-$(node scripts/test-target.mjs)}"
  export MULTISCALE_TARGET
  exec npx playwright test -c e2e/stack/playwright.config.ts
fi

parts=" ${*:-browser stack electron} "
for part in $parts; do
  case "$part" in browser | stack | electron) ;; *) echo "Parts are browser, stack and electron, not $part" >&2; exit 1 ;; esac
done
runs() { case "$parts" in *" $1 "*) ;; *) return 1 ;; esac; }

if runs browser; then
  # A free port of its own, so a run started alongside this one never reuses, and loses, this run's dev server.
  export E2E_PORT="${E2E_PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
  npx playwright test
fi
runs stack || runs electron || exit 0

work="$(mktemp -d)"
stack_pid=""
stop_stack() {
  [ -z "$stack_pid" ] || { kill "$stack_pid" 2>/dev/null || true; wait "$stack_pid" 2>/dev/null || true; }
  stack_pid=""
}
trap 'stop_stack; rm -rf "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$root/scripts/local-stack.sh" "$work/api_url" >"$work/stack.log" 2>&1 &
stack_pid=$!
until [ -s "$work/api_url" ]; do
  kill -0 "$stack_pid" 2>/dev/null || { cat "$work/stack.log" >&2; exit 1; }
  sleep 0.5
done
export LOCAL_API_URL="$(cat "$work/api_url")"
if runs stack; then
  npx playwright test -c e2e/stack/playwright.config.ts
fi
if runs electron; then
  # The core database tests and query plans under Electron's own runtime and better-sqlite3, which npm test can't reach.
  npm run test:electron-runtime
  # Built for the same stack, so two instances of the app can sign in and sync through it.
  npm run e2e:electron
fi
stop_stack
