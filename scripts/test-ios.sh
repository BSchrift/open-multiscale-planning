#!/usr/bin/env bash
# Builds the web app into the iOS project and runs XCUITest on a throwaway Simulator: once as a free team would
# install it, with the extensions off, and once with them on. MULTISCALE_RUNS=NO or YES runs just that one.
#   ENV=local (default) also starts a local stack for the signed-in test, which skips where Docker doesn't run.
#   ENV=staging, or ENV=prod with CONFIRM_PROD=yes, builds the app for that deployment and runs only the signed-in
#   test, as integration.testUser in <env>.yaml, with its password from SSM (frontend/scripts/test-target.mjs).
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
derived="${IOS_DERIVED_DATA:-$PWD/ios/DerivedData}"

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
  if docker info >/dev/null 2>&1; then
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
target=""
if [ "$ENV" != local ] || [ -n "$api" ]; then
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

  TEST_RUNNER_MULTISCALE_EXTENSIONS="$extensions" TEST_RUNNER_MULTISCALE_SHARE_URL="http://127.0.0.1:$port/" \
    TEST_RUNNER_MULTISCALE_TARGET="$target" xcodebuild test-without-building "${build_settings[@]}" ${only[@]+"${only[@]}"}

  xcrun simctl delete "$device"
  device=""
done
