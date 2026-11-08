#!/usr/bin/env bash
# Deploys one environment from its YAML in the config folder, then writes its stack outputs and a record of what was
# deployed (<env>.outputs.json and <env>.deployed) next to it.
#   ENV=staging (default), ENV=prod or ENV=control. The config folder is $MULTISCALE_CONFIG_DIR, else config/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

env_name="${ENV:-staging}"
case "$env_name" in
  control | staging | prod) ;;
  *) echo "ENV must be control, staging or prod, not $env_name" >&2; exit 1 ;;
esac

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
# Absolute, since this script and the tools it runs work from other folders.
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

cd "$root/infrastructure"
[ -d node_modules ] || npm ci

# Checks the whole config first, naming any missing file.
target="$(node bin/target.ts "$env_name")"
read -r account region profile <<<"$target"
export AWS_PROFILE="$profile" AWS_REGION="$region"

signed_in="$(aws sts get-caller-identity --query Account --output text)"
if [ "$signed_in" != "$account" ]; then
  echo "Profile $profile is signed in to account $signed_in, but $config_dir/$env_name.yaml is for $account." >&2
  exit 1
fi

# Taken before deploying, so the record matches what went out.
commit="$(git -C "$root" rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=false
[ -n "$(git -C "$root" status --porcelain 2>/dev/null)" ] && dirty=true

if [ "$env_name" != control ]; then
  # The Lambdas load this file strictly at startup and stop on any problem, so check it with their loader first.
  (cd "$root/config" && go run ./cmd/check "$env_name")
  echo "Building Lambdas"
  for name in api calendar; do
    # -trimpath and an empty build id keep the binary identical when the code is, so an unchanged Lambda doesn't redeploy.
    (cd "$root/backend" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -trimpath -ldflags='-s -w -buildid=' \
      -o "$root/backend/dist/$name/bootstrap" "./cmd/$name")
    # Loaded at startup. It can't be embedded, since it lives outside the repo.
    cp "$config_dir/$env_name.yaml" "$root/backend/dist/$name/config.yaml"
  done
fi

outputs="$(mktemp)"
trap 'rm -f "$outputs"' EXIT

echo "Deploying Multiscale-$env_name"
npx cdk deploy "Multiscale-$env_name" -c "deploy=$env_name" --outputs-file "$outputs"

node bin/write-outputs.ts "$env_name" "$outputs"
printf 'commit: %s\ndirty: %s\ntime: %s\n' "$commit" "$dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$config_dir/$env_name.deployed"
echo "Wrote $config_dir/$env_name.outputs.json and $env_name.deployed"
