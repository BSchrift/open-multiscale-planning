#!/usr/bin/env bash
# Starts the local stack on free ports: DynamoDB Local and Moto under a Compose project of its own, then cmd/local with
# the Cognito and Google stand-ins. Once the API answers it prints one NAME=value line per endpoint, LOCAL_API_URL last,
# and writes the API URL alone to the file given as the first argument or LOCAL_STACK_URL_FILE. It stays up until it
# gets SIGTERM or Ctrl-C, or cmd/local exits, then removes everything it started, that file included. Several can run
# at once.
#   scripts/local-stack.sh [url-file]
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
url_file="${1:-${LOCAL_STACK_URL_FILE:-}}"
work="$(mktemp -d)"
# The PID keeps the project unique even when callers share a prefix.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-multiscale-stack}-$$"
compose() { docker compose -f "$root/compose.yaml" "$@"; }
local_pid=""

clean_up() {
  if [ -n "$local_pid" ]; then
    kill "$local_pid" 2>/dev/null || true
    wait "$local_pid" 2>/dev/null || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  [ -z "$url_file" ] || rm -f "$url_file"
  rm -rf "$work"
}
trap clean_up EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

wait_for() { # name, url
  for _ in $(seq 1 120); do
    if curl -s -o /dev/null --max-time 2 "$2"; then return 0; fi
    sleep 0.5
  done
  echo "$1 never answered at $2" >&2
  return 1
}

# Port 0 lets Docker choose, so parallel stacks can't collide.
DYNAMODB_PORT=0 MOTO_PORT=0 compose up -d >"$work/compose.log" 2>&1 || { cat "$work/compose.log" >&2; exit 1; }
dynamodb="http://127.0.0.1:$(compose port dynamodb 8000 | sed 's/.*://')"
moto="http://127.0.0.1:$(compose port moto 5000 | sed 's/.*://')"
wait_for DynamoDB "$dynamodb"
wait_for Moto "$moto"

(cd "$root/backend" && go build -o "$work/local" ./cmd/local)
# The same for cmd/local: it binds a free port and logs which one. Its clock and Google are the local fakes, and the
# dummy credentials can't reach a real account.
LOCAL_ADDR=127.0.0.1:0 DYNAMODB_ENDPOINT="$dynamodb" SSM_ENDPOINT="$moto" "$work/local" >"$work/local.log" 2>&1 &
local_pid=$!
api=""
for _ in $(seq 1 120); do
  api="$(sed -n 's/^.*listening on //p' "$work/local.log" | head -n 1)"
  [ -z "$api" ] || break
  kill -0 "$local_pid" 2>/dev/null || { cat "$work/local.log" >&2; exit 1; }
  sleep 0.5
done
[ -n "$api" ] || { echo "cmd/local never said where it listens" >&2; exit 1; }
wait_for cmd/local "$api/cognito/.well-known/openid-configuration"

echo "DYNAMODB_ENDPOINT=$dynamodb"
echo "SSM_ENDPOINT=$moto"
echo "LOCAL_LOGS=$work/local.log"
echo "LOCAL_API_URL=$api"
# Renamed into place, so a reader never sees half a URL.
[ -z "$url_file" ] || { echo "$api" >"$url_file.$$" && mv "$url_file.$$" "$url_file"; }

wait "$local_pid"
