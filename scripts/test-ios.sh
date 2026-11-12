#!/usr/bin/env bash
# Builds the web app into the iOS project and runs XCUITest on a throwaway Simulator: once as a free team would
# install it, with the extensions off, and once with them on. MULTISCALE_RUNS=NO or YES runs just that one.
#   ENV=local (default) also starts a local stack for the signed-in test, which skips where Docker doesn't run, or uses
#   the one LOCAL_API_URL names.
#   ENV=staging, or ENV=prod with CONFIRM_PROD=yes, builds the app for that deployment and runs only the signed-in
#   test, as integration.testUser in <env>.yaml, with its password from SSM (frontend/scripts/test-target.mjs).
#   MULTISCALE_ONLY=<test class> runs only that class, on any ENV, as scripts/test-history.sh does with HistoryUITests.
#   The config folder is $MULTISCALE_CONFIG_DIR, or config/ in the repo.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# Relative to where this was run, since everything below runs in frontend/.
case "${MULTISCALE_CONFIG_DIR:-/}" in /*) ;; *) export MULTISCALE_CONFIG_DIR="$PWD/$MULTISCALE_CONFIG_DIR" ;; esac
# The whole run uses the shared web build, iOS web assets and DerivedData, so a run started alongside waits for it.
[ -n "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$root/frontend/scripts/build-lock.sh" "$0" "$@"
export ENV="${ENV:-local}"
case "$ENV" in
  local | staging) ;;
  prod)
    if [ "${CONFIRM_PROD:-}" != yes ]; then
      echo "Running against prod needs CONFIRM_PROD=yes" >&2
      exit 1
    fi
    ;;
  *) echo "ENV must be local, staging or prod, not $ENV" >&2; exit 1 ;;
esac
cd "$root/frontend"
runtime_device="${IOS_DEVICE:-iPhone 16}"
runs="${MULTISCALE_RUNS:-NO YES}"
derived="$PWD/ios/DerivedData"

work="$(mktemp -d)"
device=""
server=""
stack=""
cleanup() {
  [ -n "$server" ] && kill "$server" 2>/dev/null || true
  [ -n "$stack" ] && { kill "$stack" 2>/dev/null; wait "$stack" 2>/dev/null; } || true
  [ -n "$device" ] && xcrun simctl delete "$device" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# What the signed-in test signs in to, for the test runner: the local stack, or the deployment's test user.
only=()
api=""
if [ "$ENV" = local ]; then
  if [ -n "${LOCAL_API_URL:-}" ]; then
    # A stack the caller started, and seeded.
    api="$LOCAL_API_URL"
  elif docker info >/dev/null 2>&1; then
    "$root/scripts/local-stack.sh" "$work/api_url" >"$work/stack.log" 2>&1 &
    stack=$!
    until [ -s "$work/api_url" ]; do
      kill -0 "$stack" 2>/dev/null || { cat "$work/stack.log" >&2; exit 1; }
      sleep 0.5
    done
    api="$(cat "$work/api_url")"
    # The build signs in to this stack, which the Simulator reaches on the Mac's own 127.0.0.1.
    export LOCAL_API_URL="$api"
  else
    echo "Docker isn't running, so the signed-in test will be skipped (needs: localStack)."
  fi
else
  only=(-only-testing:MultiscaleUITests/SignedInUITests)
fi
[ -z "${MULTISCALE_ONLY:-}" ] || only=("-only-testing:MultiscaleUITests/$MULTISCALE_ONLY")
target=""
if [ "$ENV" != local ]; then
  # Run from scripts/test-deployed.sh, it's already read, test user's password and all.
  target="${MULTISCALE_TARGET:-$(node scripts/test-target.mjs)}"
elif [ -n "$api" ]; then
  target="$(node scripts/test-target.mjs)"
fi

npm run ios:sync
# The test page goes into the copied web assets, which the next sync replaces.
mkdir -p ios/App/App/public/native-checks
cp ios/harness/index.html ios/App/App/public/native-checks/index.html
npx esbuild src/platform/capacitor-checks.ts --bundle --format=esm --target=es2022 --outfile=ios/App/App/public/native-checks/checks.js --log-level=warning "--define:__CHECKS_ENV__=\"$ENV\""

# Something to share that needs no network.
echo '<!doctype html><title>Share me</title><p>Share me</p>' > "$work/index.html"
port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work" >/dev/null 2>&1 &
server=$!

# From a result bundle, the tests that failed a run, retried or quarantined: in the log, and in CI's job summary, so a
# test that passes only on a retry stays in sight.
report() {
  # The tests pass or fail by xcodebuild's result, so a bundle that can't be read only says so.
  xcrun xcresulttool get test-results tests --path "$1" --compact >"$work/tests.json" 2>/dev/null &&
    python3 - "$work/tests.json" "$2" <<'EOF' | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}" || echo "The test report couldn't read $1"
import json, sys

def walk(node, kind):
    if node.get("nodeType") == kind:
        yield node
    for child in node.get("children", []):
        yield from walk(child, kind)

lines = []
for root in json.load(open(sys.argv[1]))["testNodes"]:
    for case in walk(root, "Test Case"):
        runs = [run for run in case.get("children", []) if run["nodeType"] == "Repetition"] or [case]
        failed = [run for run in runs if run.get("result") in ("Failed", "Expected Failure")]
        if not failed:
            continue
        # Each message's first line: the rest is the tree of what was on screen.
        why = "; ".join(sorted({message["name"].splitlines()[0][:200] for run in failed for message in walk(run, "Failure Message")}))
        if case.get("result") == "Expected Failure":
            outcome = "quarantined, and failed as expected"
        elif any(run.get("result") == "Passed" for run in runs):
            outcome = f"failed {len(failed)} of {len(runs)} runs, then passed on a retry"
        else:
            outcome = "failed" if len(runs) == 1 else f"failed all {len(runs)} runs"
        lines.append(f"- {case.get('nodeIdentifier', case['name'])} {outcome}: {why}")
print(f"\n### iPhone tests, extensions {sys.argv[2]}\n")
print("\n".join(lines) or "Every test passed on its first run.")
EOF
}

for extensions in $runs; do
  echo "== Extensions $extensions =="
  device="$(xcrun simctl create "multiscale-test-$$" "$runtime_device")"
  # The keyboard tests need the software keyboard, which Simulator hides once it connects the Mac's keyboard.
  defaults write com.apple.iphonesimulator DevicePreferences -dict-add "$device" '<dict><key>ConnectHardwareKeyboard</key><false/></dict>'
  # A new Simulator goes on setting itself up for minutes after it starts, and the first app launches meanwhile can
  # take longer than a test waits for the app. So it boots while the app builds, and the tests wait until it's done.
  xcrun simctl boot "$device"
  build_settings=(-project ios/App/App.xcodeproj -scheme App -configuration Debug -derivedDataPath "$derived"
    -destination "id=$device" "MULTISCALE_EXTENSIONS=$extensions")

  xcodebuild build-for-testing "${build_settings[@]}" -quiet
  app="$derived/Build/Products/Debug-iphonesimulator/App.app"
  # A Simulator build carries its entitlements in the executable rather than in a signature.
  if grep -aq com.apple.security.application-groups "$app/App"; then group=YES; else group=NO; fi
  if [ "$extensions" = NO ]; then
    # What a free personal team would be asked to sign: the Control Center button, which needs no entitlements, and no
    # share sheet or App Group.
    if [ -e "$app/PlugIns/MultiscaleShare.appex" ]; then echo "App has the share extension while extensions are off"; exit 1; fi
    if [ "$group" = YES ]; then echo "App has an App Group while extensions are off"; exit 1; fi
  else
    for appex in MultiscaleShare MultiscaleCapture; do
      if [ ! -d "$app/PlugIns/$appex.appex" ]; then echo "$appex is missing with extensions on"; exit 1; fi
    done
    if [ "$group" = NO ]; then echo "App has no App Group with extensions on"; exit 1; fi
  fi
  xcrun simctl bootstatus "$device" >/dev/null
  # A new Simulator's first web view takes 5 to 30 s to start WebKit and draw its page, against about a second for
  # later ones, and the first test would wait that out. So the app opens its test page once here, before the tests.
  bundle="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
  xcrun simctl install "$device" "$app"
  SIMCTL_CHILD_MULTISCALE_START_PAGE=native-checks/index.html xcrun simctl launch --console-pty "$device" "$bundle" >"$work/warmup.log" 2>&1 &
  warmup=$!
  started=$SECONDS
  until grep -q 'native-checks ready' "$work/warmup.log" || [ $((SECONDS - started)) -ge 120 ]; do sleep 0.5; done
  echo "The app's test page was ready $((SECONDS - started)) s after its first launch"
  xcrun simctl terminate "$device" "$bundle" 2>/dev/null || true
  kill "$warmup" 2>/dev/null || true
  wait "$warmup" 2>/dev/null || true

  # Only CI sets IOS_RESULTS: against a deployment the bundle would keep what XCTest typed, the password included.
  bundle="${IOS_RESULTS:+$IOS_RESULTS/extensions-$extensions.xcresult}"
  # CI's Simulator now and then holds every process it starts for up to 40 s, which can fail a test that passes on its
  # next go. So a failed test runs up to twice more, and the bundle's report lists each one that needed it. A single
  # class, as the history test runs, goes once: its one test takes up to half an hour.
  retries=()
  [ -n "${MULTISCALE_ONLY:-}" ] || retries=(-retry-tests-on-failure -test-iterations 3)

  # The test runner now and then never starts on CI's Simulator ("Early unexpected exit, operation never finished
  # bootstrapping"), and xcodebuild doesn't restart it. No test has run then, so the whole run goes again, once.
  for attempt in 1 2; do
    results=()
    [ -z "$bundle" ] || { rm -rf "$bundle"; results=(-resultBundlePath "$bundle"); }
    status=0
    # XCTest logs the start of whatever it types, and against a deployment that includes the test user's password.
    TEST_RUNNER_MULTISCALE_EXTENSIONS="$extensions" TEST_RUNNER_MULTISCALE_SHARE_URL="http://127.0.0.1:$port/" \
      TEST_RUNNER_MULTISCALE_TARGET="$target" TEST_RUNNER_MULTISCALE_HISTORY_INBOX="${MULTISCALE_HISTORY_INBOX:-}" xcodebuild test-without-building "${build_settings[@]}" ${only[@]+"${only[@]}"} ${retries[@]+"${retries[@]}"} ${results[@]+"${results[@]}"} 2>&1 |
      sed -E "s/Type '[^']*'/Type '…'/" | tee "$work/test.log" || status=$?
    if [ "$status" = 0 ] || [ "$attempt" = 2 ] || ! grep -q 'never finished bootstrapping' "$work/test.log"; then break; fi
    echo "The test runner never started, so the run goes again"
  done
  [ -z "$bundle" ] || report "$bundle" "$extensions"
  [ "$status" = 0 ] || exit "$status"

  xcrun simctl delete "$device"
  device=""
done
