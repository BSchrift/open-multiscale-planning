#!/usr/bin/env bash
# The performance runner (docs/performance.md): builds this checkout as it's timed, runs frontend/e2e/perf on the browser
# at desktop and phone sizes and on the Mac app, and prints each KPI against its target in config/perf.ts. Report-only:
# it fails when a spec can't run, never on a timing.
#   BASE=<commit> also builds that commit, takes samples from the two in turn, and says which KPIs this one made slower,
#     the PR check's A/B. A BASE from before the runner can't be loaded with data, so this checkout runs alone.
#     PERF_CONFIRM=1 then takes a second round of fresh samples when the first finds anything slower, and a KPI stays
#     slower only if both agree.
#   PERF_PLATFORMS: web-desktop,web-phone,mac (all three). PERF_SAMPLES, PERF_WARMUP, PERF_LAUNCHES, PERF_CPU and
#     PERF_SCENARIOS: as frontend/e2e/perf/harness.ts says.
#   PERF_OUT: where the raw samples, the summaries and the comparison go (frontend/test-results/perf).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# The Mac app loads dist, which other runs build too, so a run started alongside waits.
[ -n "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$root/frontend/scripts/build-lock.sh" "$0" "$@"

platforms="${PERF_PLATFORMS:-web-desktop,web-phone,mac}"
out="${PERF_OUT:-$root/frontend/test-results/perf}"
work="$(mktemp -d)"
server=""
clean_up() {
  [ -z "$server" ] || kill "$server" 2>/dev/null || true
  git -C "$root" worktree remove --force "$work/base" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap clean_up EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
rm -rf "$out"
mkdir -p "$out/raw"

if [ -n "${BASE:-}" ]; then
  git -C "$root" worktree add --quiet --detach "$work/base" "$BASE"
  # Its own config, with this checkout's dependencies, as make test-compat builds an older bundle.
  ln -s "$root/frontend/node_modules" "$work/base/frontend/node_modules"
  if ! grep -q "MODE === 'perf'" "$work/base/frontend/src/main.tsx"; then
    echo "$BASE is from before the performance runner, so it can't be loaded with data. Timing this checkout alone."
    git -C "$root" worktree remove --force "$work/base"
    BASE=""
  fi
fi
checkouts=("this=$root")
[ -z "${BASE:-}" ] || checkouts=("base=$work/base" "${checkouts[@]}")

# The browser's build keeps the hook that loads data straight into the database (vite build --mode perf); the Mac app's
# is the build it ships, since its data folder is filled before it starts.
serve=()
mac=()
for checkout in "${checkouts[@]}"; do
  name="${checkout%%=*}"
  dir="${checkout#*=}"
  echo "Building $name ($(git -C "$dir" rev-parse --short HEAD))"
  (cd "$dir/frontend" && npx vite build --mode perf --outDir "$work/$name-web" --emptyOutDir --logLevel warn)
  serve+=("$name=$work/$name-web")
  if [[ ",$platforms," == *,mac,* ]]; then
    (cd "$dir/frontend" && npx vite build --logLevel warn && node scripts/electron-compile.mjs)
    mac+=("$name=$dir/frontend")
  fi
done

cd "$root/frontend"
node e2e/perf/serve.mjs "${serve[@]}" >"$work/serve.log" 2>&1 &
server=$!
for _ in $(seq 50); do [ "$(grep -c '^Serving' "$work/serve.log")" -ge "${#serve[@]}" ] && break; sleep 0.2; done
PERF_TARGETS="$(sed -n 's/^Serving \([^ ]*\) at \(.*\)$/\1=\2/p' "$work/serve.log" | paste -sd, -)"
PERF_MAC_TARGETS="$(IFS=,; echo "${mac[*]:-}")"
export PERF_TARGETS PERF_MAC_TARGETS PERF_OUT="$out/raw"

projects=()
for platform in ${platforms//,/ }; do projects+=("--project=$platform"); done
run=(npx playwright test -c e2e/perf/playwright.config.ts "${projects[@]}")
# The Mac app needs a display: a virtual one on Linux without one.
if [[ ",$platforms," == *,mac,* ]] && [ "$(uname)" = Linux ] && [ -z "${DISPLAY:-}" ]; then run=(xvfb-run -a "${run[@]}"); fi
"${run[@]}"

report=(node scripts/perf-report.ts "$out/raw" --summary "$out/summary")
if [ -n "${BASE:-}" ]; then
  # The page's first bytes, whose growth the comparison notes.
  node scripts/bundle-budget.ts "$work/this-web" --base "$work/base-web" | tail -n +2 >"$out/notes.txt" || true
  report+=(--base base --head this --notes "$out/notes.txt" --markdown "$out/comparison.md")
  if [ "${PERF_CONFIRM:-}" = 1 ] && "${report[@]}" | grep -q '^| .* slower |$'; then
    echo "Something was slower, so a second round of fresh samples decides."
    PERF_OUT="$out/raw-again" "${run[@]}"
    report+=(--again "$out/raw-again")
  fi
fi
"${report[@]}"
