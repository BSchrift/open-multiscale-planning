#!/usr/bin/env bash
# The fast wiring check of a deployment: the suite's smoke subset, then that logs and metrics actually arrive.
#   ENV=staging (default) or ENV=prod with CONFIRM_PROD=yes. The config folder is $MULTISCALE_CONFIG_DIR, else config/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

env_name="${ENV:-staging}"
case "$env_name" in
  staging) ;;
  prod)
    if [ "${CONFIRM_PROD:-}" != yes ]; then
      echo "Running against prod needs CONFIRM_PROD=yes" >&2
      exit 1
    fi
    ;;
  *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;;
esac

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
# Absolute, since the tools this runs work from other folders.
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

[ -d "$root/infrastructure/node_modules" ] || (cd "$root/infrastructure" && npm ci)
# Checks the config, naming any missing file.
target="$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
read -r _ region profile <<<"$target"
export AWS_PROFILE="$profile" AWS_REGION="$region"

outputs="$config_dir/$env_name.outputs.json"
if [ ! -f "$outputs" ]; then
  echo "Missing $outputs. Run make deploy ENV=$env_name first." >&2
  exit 1
fi
output() { node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))[process.argv[2]]" "$outputs" "$1"; }

api_logs="$(output ApiLogGroup)"
calendar_logs="$(output CalendarLogGroup)"
namespace="$(output MetricNamespace)"
start="$(date +%s)"

ENV="$env_name" SMOKE=1 CONFIRM_PROD="${CONFIRM_PROD:-}" "$root/scripts/integration.sh"

# Runs its arguments until they print something other than 0, for up to 5 minutes: both logs and metrics lag.
arrives() {
  for _ in $(seq 1 30); do
    if out="$("$@")" && [ "$out" != 0 ]; then return 0; fi
    sleep 10
  done
  return 1
}
log_lines() { aws logs filter-log-events --region "$region" --log-group-name "$1" --start-time "$2" --page-size 1 --max-items 1 --query 'length(events)' --output json; }
metric_points() {
  aws cloudwatch get-metric-statistics --region "$region" --namespace "$namespace" --metric-name SyncRecordsMerged \
    --start-time "$start" --end-time "$(($(date +%s) + 60))" --period 60 --statistics Sum --query 'length(Datapoints)' --output text
}

echo "Checking $api_logs received a line"
arrives log_lines "$api_logs" "$((start * 1000))" || { echo "No log line reached $api_logs" >&2; exit 1; }

echo "Checking metric SyncRecordsMerged in $namespace"
arrives metric_points || { echo "SyncRecordsMerged never showed up in $namespace" >&2; exit 1; }

if [ "$(log_lines "$calendar_logs" "$(((start - 2100) * 1000))")" = 0 ]; then
  echo "WARN: the calendar worker has not logged in 35 minutes. Normal within 30 minutes of a first deploy, otherwise check its schedule."
fi

echo "Smoke passed for $env_name"
