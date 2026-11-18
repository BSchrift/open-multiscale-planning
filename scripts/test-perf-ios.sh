#!/usr/bin/env bash
# The iPhone's performance KPIs (docs/performance.md): PerfUITests on a throwaway iPhone 16 Simulator through
# scripts/test-ios.sh, with the extensions off, then the same on an iPhone SE (3rd generation) for its small screen and
# older WebKit (a Simulator runs at the Mac's speed, so not a slow phone). The web view's memory is read from the Mac,
# where the Simulator's processes run. Prints each KPI against its target, report-only, like make test-perf.
#   PERF_ROUNDS: captures and rounds of the screens (30). PERF_LAUNCHES: launches before the session (5).
#   PERF_IOS_DEVICES: the Simulators, comma-separated ("iPhone 16,iPhone SE (3rd generation)").
#   PERF_OUT: where the results go (frontend/test-results/perf-ios).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${PERF_OUT:-$root/frontend/test-results/perf-ios}"
work="$(mktemp -d)"
sampler=""
trap '[ -z "$sampler" ] || kill "$sampler" 2>/dev/null || true; rm -rf "$work"' EXIT
rm -rf "$out"
mkdir -p "$out/raw"
export TEST_RUNNER_MULTISCALE_PERF=YES TEST_RUNNER_MULTISCALE_PERF_ROUNDS="${PERF_ROUNDS:-30}" TEST_RUNNER_MULTISCALE_PERF_LAUNCHES="${PERF_LAUNCHES:-5}"

IFS=, read -r -a devices <<<"${PERF_IOS_DEVICES:-iPhone 16,iPhone SE (3rd generation)}"
for device in "${devices[@]}"; do
  case "$device" in "iPhone 16") scenario=one-year ;; *) scenario=one-year+older ;; esac
  echo "== $device =="
  # The largest the Simulator's web content processes get, in MB, sampled each second from the Mac's side.
  (
    peak=0
    while sleep 1; do
      now="$(ps -axo rss=,command= | awk '/com.apple.WebKit.WebContent/ && /CoreSimulator/ { kb = $1 > kb ? $1 : kb } END { print int(kb / 1024) }')"
      [ "$now" -le "$peak" ] || { peak=$now; echo "$peak" >"$work/webview"; }
    done
  ) &
  sampler=$!
  IOS_DEVICE="$device" MULTISCALE_ONLY=PerfUITests MULTISCALE_RUNS=NO "$root/scripts/test-ios.sh" 2>&1 | tee "$work/ios.log"
  kill "$sampler" 2>/dev/null || true
  sampler=""
  node "$root/frontend/scripts/perf-ios.ts" "$work/ios.log" "$out/raw" "$scenario" "$(cat "$work/webview" 2>/dev/null || true)"
  rm -f "$work/webview"
done
# In CI's job summary too, as a block, since it's a fixed-width table.
node "$root/frontend/scripts/perf-report.ts" "$out/raw" --summary "$out/summary" | tee "$work/report.txt"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || printf '```\n%s\n```\n' "$(cat "$work/report.txt")" >>"$GITHUB_STEP_SUMMARY"
