#!/usr/bin/env bash
# The retention suite against staging (frontend/src/core/retention.stack.test.ts). The app's own client writes one record
# of each kind as the test user, then waits out staging's periods from config/retention.yaml, minutes there, while
# staging's cleanup runs each minute. At each period it checks that a new device doesn't get what expired, that devices
# which had it removed it, that a device holding an old copy is reset, and that an old copy pushed late is dropped; at
# the end, that the server holds none of it. About 25 minutes.
#   Staging only: ENV, if set, must be staging. The config folder is $MULTISCALE_CONFIG_DIR, else config/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:-staging}"
if [ "$env_name" != staging ]; then
  echo "The retention suite runs against staging only, not $env_name: prod's periods are years." >&2
  exit 1
fi
config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir" ENV=staging

cd "$root/frontend"
# make test-deployed has read the test user already.
if [ -z "${MULTISCALE_TARGET:-}" ]; then
  if ! MULTISCALE_TARGET="$(node scripts/test-target.mjs)"; then
    echo "Couldn't read the staging test user. Sign in to AWS for staging, then run this again." >&2
    exit 1
  fi
fi
export MULTISCALE_TARGET RETENTION_DEPLOYED=1
npx vitest run --maxWorkers=1 --project node src/core/retention.stack.test.ts
