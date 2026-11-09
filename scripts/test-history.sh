#!/usr/bin/env bash
# The history-scale test: seeds a made-up five-year account, about 40,000 records, through the sync API, then times a
# new browser, a new Mac install and a new iPhone of it against the budgets in docs/performance.md: the first sync to a
# usable app, an edit saved on the web, and Today and Week read on each. Slow, so it runs on demand and before
# releases, not on every PR.
#   ENV=local (default) starts a local stack, or uses the one LOCAL_API_URL names, and seeds the stack's own user.
#   ENV=staging seeds and signs in as integration.historyUser in staging.yaml, with its password from SSM
#   (frontend/scripts/test-target.mjs). The config folder is $MULTISCALE_CONFIG_DIR, or config/ in the repo.
#   Exits 1 when a budget is missed or a part fails. HISTORY_REPORT_ONLY=1, for a baseline and for releases, reports
#   those without failing, and fails only when a device holds fewer records than were seeded, or nothing was seeded.
#   SKIP_IOS=1 leaves out the iPhone, much the slowest. HISTORY_WRITE_UNITS paces the seed, 500 a second off local.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# Relative to where this was run, since everything below runs in frontend/.
case "${MULTISCALE_CONFIG_DIR:-/}" in /*) ;; *) export MULTISCALE_CONFIG_DIR="$PWD/$MULTISCALE_CONFIG_DIR" ;; esac
# The browser and the Mac app load the build in dist, and the iPhone's build replaces it, so a run started alongside waits.
[ -n "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$root/frontend/scripts/build-lock.sh" "$0" "$@"
export ENV="${ENV:-local}"
case "$ENV" in local | staging) ;; *) echo "ENV must be local or staging, not $ENV" >&2; exit 1 ;; esac
cd "$root/frontend"

results="$root/frontend/test-results/history"
rm -rf "$results"
mkdir -p "$results"
export HISTORY_RESULTS="$results"
work="$(mktemp -d)"
stack=""
cleanup() {
  [ -n "$stack" ] && { kill "$stack" 2>/dev/null; wait "$stack" 2>/dev/null; } || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$ENV" = local ]; then
  if [ -z "${LOCAL_API_URL:-}" ]; then
    "$root/scripts/local-stack.sh" "$work/api_url" >"$work/stack.log" 2>&1 &
    stack=$!
    until [ -s "$work/api_url" ]; do
      kill -0 "$stack" 2>/dev/null || { cat "$work/stack.log" >&2; exit 1; }
      sleep 0.5
    done
    export LOCAL_API_URL="$(cat "$work/api_url")"
  fi
  # A free port of its own. A deployment's sign-in returns only to 5199, the Playwright config's default.
  export HISTORY_WEB_PORT="${HISTORY_WEB_PORT:-$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
fi
# Its own user, never the test user that scripts/test-deployed.sh may have put in MULTISCALE_TARGET.
if ! MULTISCALE_TARGET="$(MULTISCALE_TEST_USER=history node scripts/test-target.mjs)"; then
  echo "Couldn't read the $ENV history user. See \"The history-scale test\" in docs/setup.md." >&2
  exit 1
fi
export MULTISCALE_TARGET

status=0
# A part that fails measures nothing, which the report shows. Only reporting, the report alone decides.
part_failed() { [ "${HISTORY_REPORT_ONLY:-}" = 1 ] || status=1; }
# One build for ENV, which the browser is served and the Mac app loads, and the Mac app's main process.
npx vite build --logLevel warn
node scripts/electron-compile.mjs
npx playwright test -c e2e/history/playwright.config.ts || part_failed

skip=()
if [ "${SKIP_IOS:-}" = 1 ]; then
  skip=(--skip iphone)
elif [ ! -f "$results/facts.json" ]; then
  echo "== iPhone skipped: the history wasn't seeded"
else
  open_inbox="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).open_inbox' "$results/facts.json")"
  MULTISCALE_ONLY=HistoryUITests MULTISCALE_RUNS=NO MULTISCALE_HISTORY_INBOX="$open_inbox" "$root/scripts/test-ios.sh" 2>&1 | tee "$work/ios.log" || part_failed
  numbers="$(sed -n 's/^.*HISTORY iphone //p' "$work/ios.log" | tail -n 1)"
  [ -z "$numbers" ] || echo "$numbers" >"$results/iphone.json"
fi

echo
echo "History-scale test, $ENV: $(node -p 'const f = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); `${f.records} records, ${f.deleted} of them deleted, ${f.mean_bytes} bytes on average`' "$results/facts.json" 2>/dev/null || echo 'not seeded')"
node scripts/history-report.ts "$results" ${skip[@]+"${skip[@]}"} || status=1
exit "$status"
