#!/usr/bin/env bash
# Every suite that can run against a deployment, run against one, as make release does after each release:
#   web app      the deployed web app as people get it (frontend/e2e/deployed), desktop and phone sizes, and the feeds
#                the apps update from
#   sync         two browser devices signing in and syncing through its API (frontend/e2e/stack); staging only
#   compat       on staging, prod's web bundle and this checkout's sharing a database and syncing (scripts/test-compat.sh)
#   integration  the black-box suite against its API and sign-in
#   smoke        that its logs and metrics arrive
#   retention    staging only: records expire, leave every device and the server, and old copies stay out, about 50
#                minutes (scripts/test-retention.sh)
#   iPhone       the app's signed-in test on a Simulator, built for the deployment
#   history      on staging, the history-scale test against its own user's five-year account (scripts/test-history.sh),
#                reporting its numbers: it fails only when a device holds fewer live records than were seeded
#   history web app
#                on staging, the web app suite as a desktop browser of that user, once its account is seeded: its long
#                first sync, a reload during one, OPFS, the journey, planning and the console (frontend/e2e/deployed,
#                project history), so a long history's slow reads meet them before prod's shared test user does
# Each runs even when one before it fails, and the summary names the ones that failed.
#   ENV=staging (default), or ENV=prod with CONFIRM_PROD=yes. EXPECT_VERSION is the version the web app must serve, and
#   EXPECT_FEEDS the feeds that must serve it too: desktop and iphone, as a release switched them.
#   SKIP_IOS=1 leaves out the iPhone tests, much the slowest. SKIP_HISTORY=1 leaves out the history-scale test, the next
#   slowest, and SKIP_RETENTION=1 the retention suite's 50 minutes: the release pipeline leaves both to its nightly builds.
#   SKIP_HISTORY_WEB=1 leaves out the history web app suite, about 3 to 6 minutes.
#   The config folder is $MULTISCALE_CONFIG_DIR, else config/.
#   DEPLOYED_BEFORE_PUBLISH=1 says the web app is still the release before this checkout's, so the web app suite skips
#   the checks of this release's own screens and feeds. WEB_ONLY=1 runs the web app suite alone: the release pipeline's
#   staging step runs it so before it switches the web app, as prod's Test step runs the suites (scripts/pipeline.sh).
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:-staging}"
case "$env_name" in
  staging) ;;
  prod)
    if [ "${CONFIRM_PROD:-}" != yes ]; then
      echo "Running against prod needs CONFIRM_PROD=yes" >&2
      exit 1
    fi
    ;;
  *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;;
esac
config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir" ENV="$env_name" CONFIRM_PROD="${CONFIRM_PROD:-}"

outputs="$config_dir/$env_name.outputs.json"
web_url="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).WebUrl ?? "")' "$outputs" 2>/dev/null || true)"
if [ -z "$web_url" ]; then
  echo "$outputs has no WebUrl. Run make deploy ENV=$env_name first." >&2
  exit 1
fi
cd "$root/frontend"
# Checks the config and reads the test user's password, once for every suite here.
if ! MULTISCALE_TARGET="$(node scripts/test-target.mjs)"; then
  echo "Couldn't read the $env_name test user. Sign in to AWS for $env_name, then run this again." >&2
  exit 1
fi
release_url="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ReleaseUrl ?? "")' "$outputs")"
downloads_url="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).DownloadsUrl ?? "")' "$outputs")"
export MULTISCALE_TARGET DEPLOYED_WEB_URL="$web_url" DEPLOYED_RELEASE_URL="$release_url" DEPLOYED_DOWNLOADS_URL="$downloads_url"

# Each suite's whole output is kept, so a failure can be looked into after a long run.
logs="$root/frontend/test-results/deployed-$env_name"
mkdir -p "$logs"
failed=()
run() {
  local name="$1" log="$logs/${1// /-}.log"
  shift
  echo "== $name"
  if "$@" 2>&1 | tee "$log"; then
    echo "== $name passed"
  else
    echo "== $name FAILED, its output is in $log"
    failed+=("$name")
  fi
}
run "web app" npx playwright test -c e2e/deployed/playwright.config.ts
if [ "${WEB_ONLY:-}" = 1 ]; then
  [ ${#failed[@]} -eq 0 ] || { echo "$env_name: failed: web app" >&2; exit 1; }
  echo "$env_name: the web app suite passed."
  exit 0
fi
# Off local, e2e.sh runs only the signed-in specs, against this deployment.
if [ "$env_name" = prod ]; then
  # Its devices are the app served from this Mac, and prod's sign-in returns only to the deployed app. The web app suite
  # signs in to prod, and integration covers its sync API.
  echo "== sync skipped: prod's sign-in doesn't return to a local app"
else
  run "sync" "$root/scripts/e2e.sh"
  # Its old and new devices are this Mac's builds too, signing in as the test user.
  run "compat" "$root/scripts/test-compat.sh"
fi
run "integration" "$root/scripts/integration.sh"
run "smoke" "$root/scripts/smoke.sh"
# Prod's periods are years.
if [ "$env_name" != staging ]; then echo "== retention skipped: prod's periods are years"
elif [ "${SKIP_RETENTION:-}" != 1 ]; then run "retention" "$root/scripts/test-retention.sh"; fi
[ "${SKIP_IOS:-}" = 1 ] || run "iPhone" "$root/scripts/test-ios.sh"
# Its numbers against their budgets, on staging only: prod has no history user, and none of its data is made up. Only
# reported, so a release isn't held up by speed; a device missing records still fails it.
if [ "$env_name" = staging ] && [ "${SKIP_HISTORY:-}" != 1 ]; then run "history" env HISTORY_REPORT_ONLY=1 "$root/scripts/test-history.sh"; fi
# On staging only: prod has no history user. Its own user, as scripts/test-history.sh reads it.
if [ "$env_name" = staging ] && [ "${SKIP_HISTORY_WEB:-}" != 1 ]; then
  if history_target="$(MULTISCALE_TEST_USER=history node scripts/test-target.mjs)"; then
    run "history web app" env MULTISCALE_HISTORY_TARGET="$history_target" npx playwright test -c e2e/deployed/playwright.config.ts --project=history
  else
    echo "== history web app FAILED: couldn't read the staging history user. See \"The history-scale test\" in docs/setup.md."
    failed+=("history web app")
  fi
fi

if [ ${#failed[@]} -gt 0 ]; then
  echo "$env_name: failed: ${failed[*]}" >&2
  exit 1
fi
left_out=()
[ "${SKIP_IOS:-}" != 1 ] || left_out+=("the iPhone tests")
[ "$env_name" != staging ] || [ "${SKIP_HISTORY:-}" != 1 ] || left_out+=("the history-scale test")
[ "$env_name" != staging ] || [ "${SKIP_RETENTION:-}" != 1 ] || left_out+=("the retention suite")
if [ ${#left_out[@]} -gt 0 ]; then echo "$env_name: every deployed suite passed; left out: ${left_out[*]}."; else echo "$env_name: every deployed suite passed."; fi
