#!/usr/bin/env bash
# Runs a command holding this checkout's one lock on the shared build output (dist, dist-electron, ios/App/App/public,
# ios/DerivedData), so a second run waits instead of rebuilding them under the first. Steps inside a locked run pass.
# The lock is on a file this script keeps open and the command never inherits, so it goes when this script exits,
# however it exits, and nothing the command leaves running can keep it.
set -euo pipefail
[ -z "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$@"
exec 9>>"$(cd "$(dirname "$0")/.." && pwd)/.build.lock"
if ! python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 2>/dev/null; then
  echo "Waiting for another run to finish with the shared build output..." >&2
  python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX)'
fi
# Runs only once the command has exited, so the lock lasts as long as the command does.
trap 'exit 143' TERM HUP
MULTISCALE_BUILD_LOCK=1 "$@" 9>&-
