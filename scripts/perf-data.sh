#!/usr/bin/env bash
# Adds one run's performance results to the perf-data branch (docs/performance.md) and pushes it, starting the branch
# if it isn't there. Only the main and nightly performance workflows run this: they alone may write the repo's contents.
#   COMMIT=<sha> RUNNER=<runner> scripts/perf-data.sh <kind> <summary.json>...
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
kind="$1"
shift
summaries=()
for file in "$@"; do summaries+=("$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"); done
work="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$work/data" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
bot=(-c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com')

# Another run may push first, so each try starts again from the branch as it is.
for try in 1 2 3 4 5; do
  git -C "$root" worktree remove --force "$work/data" >/dev/null 2>&1 || true
  if git -C "$root" fetch --quiet origin perf-data 2>/dev/null; then
    git -C "$root" worktree add --quiet --detach "$work/data" FETCH_HEAD
  else
    git -C "$root" worktree add --quiet --detach "$work/data" HEAD
    git -C "$work/data" checkout --quiet --orphan perf-data
    git -C "$work/data" rm -r --quiet --force .
    printf '%s\n' '# perf-data' '' 'Performance results, written only by the main and nightly performance workflows. See docs/performance.md on main.' >"$work/data/README.md"
  fi
  node "$root/frontend/scripts/perf-data.ts" add "$work/data" "${summaries[@]}" --kind "$kind" --commit "${COMMIT:?}" --runner "${RUNNER:-unknown}"
  git -C "$work/data" add -A
  git -C "$work/data" "${bot[@]}" commit --quiet -m "Add the $kind run at ${COMMIT:0:7}"
  if git -C "$work/data" push --quiet origin HEAD:refs/heads/perf-data; then exit 0; fi
  echo "The push lost a race (try $try of 5). Trying again." >&2
  sleep $((try * 5))
done
exit 1
