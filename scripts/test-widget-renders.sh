#!/usr/bin/env bash
# The iPhone widgets' render tests on a throwaway iPhone Simulator, where text grows with Dynamic Type as on a phone:
# every widget in every state, look and text size, drawn with ImageRenderer and checked to fit and not be empty. Each is
# saved as a PNG named widget-*.png in WIDGET_RENDERS_DIR (default: the package's .build/renders) for review. CI's
# widgets job runs it and keeps the PNGs. Never on the shared Mac while another agent uses its Simulator.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
package="$root/frontend/ios/App/MultiscaleWidgets"
out="${WIDGET_RENDERS_DIR:-$package/.build/renders}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
rm -rf "$out"
mkdir -p "$out"

device="$(xcrun simctl create "widget-renders-$$" "${IOS_DEVICE:-iPhone 16}")"
trap 'xcrun simctl delete "$device" 2>/dev/null || true' EXIT

cd "$package"
# The whole log is long, so it shows only what didn't fit or draw, each naming the widget, its state, look and text
# size, and the tally: -quiet would leave out the reasons.
log="$package/.build/renders.log"
status=0
TEST_RUNNER_WIDGET_RENDERS_DIR="$out" xcodebuild test -scheme MultiscaleWidgets-Package -destination "id=$device" \
  -derivedDataPath "$package/.build/xcode" -only-testing:WidgetUITests >"$log" 2>&1 || status=$?
grep -E "error:|Executed|TEST (SUCCEEDED|FAILED)" "$log" || tail -40 "$log"
count="$(find "$out" -name 'widget-*.png' | wc -l | tr -d ' ')"
echo "Saved $count widget renders in $out"
[ "$status" = 0 ] || exit "$status"
# Each test saves every picture it checks, so none saved means the renders never ran.
[ "$count" -gt 0 ]
