#!/usr/bin/env bash
# Releases the apps for one environment from this Mac. Builds the Mac app and its web bundle, signs the bundle with the
# environment's release key, and uploads both to the hosts its stack serves: the disk image to downloads.<zone>, and the
# feed the apps update from to release.<zone>.
#   ENV=staging (default) or ENV=prod. The config folder is $MULTISCALE_CONFIG_DIR, else config/.
# The first release makes the key, <env>.release-key.pem, beside the config. Keep it backed up: apps built with it take
# updates signed by it and nothing else.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# make exports ENV=local as the default for its test targets. Nothing releases to local, so it means the default.
env_name="${ENV:-staging}"
[ "$env_name" = local ] && env_name=staging
case "$env_name" in
  staging | prod) ;;
  *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;;
esac

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

# A release is a commit: its build number is the commit's time, and its version names the commit.
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first: a release is built from a commit." >&2
  exit 1
fi

cd "$root/infrastructure"
[ -d node_modules ] || npm ci
target="$(node bin/target.ts "$env_name")"
read -r account region profile <<<"$target"
export AWS_PROFILE="$profile" AWS_REGION="$region"
signed_in="$(aws sts get-caller-identity --query Account --output text)"
if [ "$signed_in" != "$account" ]; then
  echo "Profile $profile is signed in to account $signed_in, but $config_dir/$env_name.yaml is for $account." >&2
  exit 1
fi
bucket="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ReleaseBucket ?? "")' "$config_dir/$env_name.outputs.json")"
if [ -z "$bucket" ]; then
  echo "$env_name has nowhere to release to yet. Set dns.zone in $env_name.yaml and run make deploy ENV=$env_name." >&2
  exit 1
fi

cd "$root/frontend"
key="$config_dir/$env_name.release-key.pem"
# Before building, since the apps carry the key's public half.
node scripts/release-files.ts key "$key"
ENV="$env_name" npm run electron:build
dmg="$(ls -t "release/$env_name"/*.dmg | head -n 1)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
node scripts/release-files.ts pack dist "$key" "$out"

# Files are named by their contents, so each uploads once and caches for good. The disk image goes before the feed, so
# an update that needs the new app can already link to it.
aws s3 sync "$out/files" "s3://$bucket/release/files" --size-only --cache-control 'public, max-age=31536000, immutable' --content-type application/octet-stream
aws s3 cp "$dmg" "s3://$bucket/downloads/Multiscale.dmg" --cache-control 'public, max-age=300' --content-type application/x-apple-diskimage
aws s3 cp "$out/release.json" "s3://$bucket/release/release.json" --cache-control 'public, max-age=60' --content-type application/json

echo "Released $(node -e 'console.log(JSON.parse(require("fs").readFileSync("dist/version.json", "utf8")).version)') to $env_name"
