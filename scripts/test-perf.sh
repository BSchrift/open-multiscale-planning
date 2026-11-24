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
#   PERF_SYNC=1 also times sync between two signed-in browsers through a local stack behind Toxiproxy, on a good, a slow
#     3G and a flaky network, with Docker and Go as make test-integration needs them. Nightly. PERF_SYNC=staging times
#     it against staging instead, as its test user, from the release pipeline's nightly, which has the config folder.
#   PERF_PLATFORMS=none leaves out the browser and the Mac app, for a sync run alone.
#   PERF_OUT: where the raw samples, the summaries and the comparison go (frontend/test-results/perf).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# The Mac app loads dist, which other runs build too, so a run started alongside waits.
[ -n "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$root/frontend/scripts/build-lock.sh" "$0" "$@"

platforms="${PERF_PLATFORMS:-web-desktop,web-phone,mac}"
out="${PERF_OUT:-$root/frontend/test-results/perf}"
work="$(mktemp -d)"
server=""
stack=""
proxy=""
clean_up() {
  for pid in "$server" "$proxy" "$stack"; do [ -z "$pid" ] || kill "$pid" 2>/dev/null || true; done
  [ -z "$stack" ] || wait "$stack" 2>/dev/null || true
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

free_port() { python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'; }
if [ "${PERF_SYNC:-}" = staging ]; then
  # Built for staging, served where its sign-in returns to (e2e/stack/target.ts), and signed in as its test user.
  export ENV=staging
  MULTISCALE_TARGET="${MULTISCALE_TARGET:-$(cd "$root/frontend" && node scripts/test-target.mjs)}"
  export MULTISCALE_TARGET
  web_port=5199
fi
if [ "${PERF_SYNC:-}" = 1 ]; then
  # The local stack, and Toxiproxy in front of its API, which the builds talk to so the network can be shaped.
  "$root/scripts/local-stack.sh" "$work/api-url" >"$work/stack.log" 2>&1 &
  stack=$!
  for _ in $(seq 240); do [ -s "$work/api-url" ] && break; kill -0 "$stack" 2>/dev/null || { cat "$work/stack.log" >&2; exit 1; }; sleep 0.5; done
  upstream="$(sed 's#^http://##' "$work/api-url")"
  toxi_port="$(free_port)"
  proxy_port="$(free_port)"
  (cd "$root/backend" && go run github.com/Shopify/toxiproxy/v2/cmd/server@v2.9.0 -host 127.0.0.1 -port "$toxi_port") >"$work/toxiproxy.log" 2>&1 &
  proxy=$!
  toxi="http://127.0.0.1:$toxi_port"
  for _ in $(seq 240); do curl -s -o /dev/null "$toxi/version" && break; sleep 0.5; done
  export LOCAL_API_URL="http://127.0.0.1:$proxy_port"
  # The specs shape it once their devices are signed in (e2e/perf/sync.spec.ts).
  curl -sf -X POST "$toxi/proxies" -d "{\"name\":\"api\",\"listen\":\"127.0.0.1:$proxy_port\",\"upstream\":\"$upstream\"}" >/dev/null
  export PERF_TOXIPROXY="$toxi"
fi

# The browser's build keeps the hook that loads data straight into the database (vite build --mode perf); the Mac app's
# is the build it ships, since its data folder is filled before it starts.
serve=()
mac=()
for checkout in "${checkouts[@]}"; do
  name="${checkout%%=*}"
  dir="${checkout#*=}"
  echo "Building $name ($(git -C "$dir" rev-parse --short HEAD))"
  (cd "$dir/frontend" && npx vite build --mode perf --outDir "$work/$name-web" --emptyOutDir --logLevel warn)
  serve+=("$name=$work/$name-web${web_port:+@$web_port}")
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
[ "$platforms" = none ] || "${run[@]}"

if [ "${PERF_SYNC:-}" = staging ]; then
  PERF_NETWORK=staging npx playwright test -c e2e/perf/playwright.config.ts --project=sync
fi
if [ "${PERF_SYNC:-}" = 1 ]; then
  for shape in good slow-3g flaky; do
    echo "Sync on a $shape network"
    PERF_NETWORK="$shape" npx playwright test -c e2e/perf/playwright.config.ts --project=sync
  done
fi

report=(node scripts/perf-report.ts "$out/raw" --summary "$out/summary")
if [ -n "${BASE:-}" ]; then
  # The page's first bytes, whose growth the comparison notes.
  node scripts/bundle-budget.ts "$work/this-web" --base "$work/base-web" | tail -n +2 >"$out/notes.txt" || true
  report+=(--base base --head this --notes "$out/notes.txt" --markdown "$out/comparison.md" --flagged "$out/flagged.txt")
  if [ "${PERF_CONFIRM:-}" = 1 ] && "${report[@]}" | grep -q '^| .* slower |$'; then
    echo "Something was slower, so a second round of fresh samples decides."
    PERF_OUT="$out/raw-again" "${run[@]}"
    report+=(--again "$out/raw-again")
  fi
fi
"${report[@]}"
