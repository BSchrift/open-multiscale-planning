#!/usr/bin/env bash
# Publishes the last 13 days of performance results on the perf-data branch to CloudWatch's Multiscale/Perf, for the
# performance dashboard (docs/performance.md). The release pipeline's nightly runs it, signed in as staging's release
# role, which may put metrics in that namespace alone. CloudWatch takes points up to two weeks old and a point sent
# again changes no average, so each night sends the whole window, and a night missed loses nothing.
#   AWS_PROFILE=<staging's profile> scripts/perf-publish.sh [<summary.json>]
# With a summary, such as the nightly's sync timing against staging, it publishes that run, measured just now, instead.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$work/data" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

if [ -n "${1:-}" ]; then
  node "$root/frontend/scripts/perf-publish.ts" --summary "$1" "$work/batches"
elif git -C "$root" fetch --quiet origin perf-data 2>/dev/null; then
  git -C "$root" worktree add --quiet --detach "$work/data" FETCH_HEAD
  node "$root/frontend/scripts/perf-publish.ts" "$work/data" "$work/batches"
else
  echo "No perf-data branch yet, so no performance results to publish."
  exit 0
fi
for batch in "$work"/batches/*.json; do
  [ -e "$batch" ] || break
  aws cloudwatch put-metric-data --namespace Multiscale/Perf --metric-data "file://$batch"
done
