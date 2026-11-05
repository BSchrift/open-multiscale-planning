#!/usr/bin/env bash
# One black-box suite against one target. Local starts its own stand-ins on free ports and removes them afterwards,
# and also runs the backend's stand-in tests and the app's sync client against them.
#   ENV=local (default), ENV=staging, or ENV=prod with CONFIRM_PROD=yes. SMOKE=1 runs only the wiring subset.
# Local uses built-in defaults. A deployment is read from the config folder, $MULTISCALE_CONFIG_DIR or config/: its
# <env>.yaml, the <env>.outputs.json make deploy wrote, and the test-user passwords in that account's SSM, read with the
# profile and region the YAML names.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:-local}"

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

if [ "$env_name" != local ]; then
  # Absolute, since the suite runs from backend/.
  config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
  case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
  export MULTISCALE_CONFIG_DIR="$config_dir"
  if [ ! -f "$config_dir/$env_name.yaml" ]; then
    echo "Missing $config_dir/$env_name.yaml. Copy $root/config/$env_name.example.yaml there and fill it in, see docs/setup.md." >&2
    exit 1
  fi
  if [ ! -f "$config_dir/$env_name.outputs.json" ]; then
    echo "Missing $config_dir/$env_name.outputs.json. Run make deploy ENV=$env_name first." >&2
    exit 1
  fi
fi

work="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-multiscale-integration-$$}"
stack_pid=""

clean_up() {
  if [ -n "$stack_pid" ]; then
    kill "$stack_pid" 2>/dev/null || true
    wait "$stack_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap clean_up EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_local_stack() {
  "$root/scripts/local-stack.sh" "$work/api_url" >"$work/stack.env" 2>"$work/stack.err" &
  stack_pid=$!
  until [ -s "$work/api_url" ]; do
    kill -0 "$stack_pid" 2>/dev/null || { cat "$work/stack.err" >&2; exit 1; }
    sleep 0.5
  done
  stack() { sed -n "s/^$1=//p" "$work/stack.env"; }
  dynamodb="$(stack DYNAMODB_ENDPOINT)"
  moto="$(stack SSM_ENDPOINT)"
  INTEGRATION_API_URL="$(stack LOCAL_API_URL)"
  INTEGRATION_LOGS="$(stack LOCAL_LOGS)"
  export INTEGRATION_API_URL INTEGRATION_LOGS INTEGRATION_SSM_ENDPOINT="$moto"
}

[ "$env_name" = local ] && start_local_stack

filter=()
[ -z "${SMOKE:-}" ] || filter=(-run '^TestSmoke')

status=0
(cd "$root/backend" && INTEGRATION_ENV="$env_name" CONFIRM_PROD="${CONFIRM_PROD:-}" \
  go test -count=1 -v -timeout 20m ${filter[@]+"${filter[@]}"} ./integration) >"$work/out" 2>&1 || status=$?

grep -vE '^(=== (RUN|PAUSE|CONT|NAME)|\s+--- PASS|--- PASS)' "$work/out" || true

count() { grep -cE "^\s*--- $1:" "$work/out" || true; }
echo
echo "$env_name: passed $(count PASS), failed $(count FAIL), skipped $(count SKIP)"
if [ "$(count SKIP)" != 0 ]; then
  echo "Skipped:"
  awk '/^=== RUN/ { name = $3 } /_test\.go:[0-9]+: needs:/ { sub(/^.*_test\.go:[0-9]+: /, ""); print "  " name ": " $0 }' "$work/out"
fi

# Locally every capability is on, so a skip means a test quietly stopped testing.
if [ "$env_name" = local ] && [ "$status" = 0 ] && [ "$(count SKIP)" != 0 ]; then
  echo "A local run must skip nothing" >&2
  status=1
fi

if [ "$env_name" = local ] && [ -z "${SMOKE:-}" ]; then
  # The store and worker tests skip under plain `go test` because they need these stand-ins.
  echo
  echo "Backend packages against the local stand-ins"
  (cd "$root/backend" && DYNAMODB_ENDPOINT="$dynamodb" SSM_ENDPOINT="$moto" go test -count=1 ./internal/... ./cmd/...) || status=1
  # The app's own sync client and sign-in against cmd/local, so both languages agree on the wire.
  echo
  echo "TypeScript client against cmd/local"
  (cd "$root/frontend" && npx vitest run --project node src/core/sync.stack.test.ts) || status=1
fi
exit "$status"
