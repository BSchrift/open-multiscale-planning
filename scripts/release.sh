#!/usr/bin/env bash
# Releases the apps for one environment from this Mac. Builds the Mac app and its web bundle, signs the bundle with the
# environment's release key, and uploads both to the hosts its stack serves: the disk image to downloads.<zone>, the
# feed the apps update from to release.<zone>, and the web app to the zone itself.
#   ENV=staging (default) or ENV=prod. The config folder is $MULTISCALE_CONFIG_DIR, else config/.
# Then it runs every suite that can run against that deployment (scripts/test-deployed.sh), and fails if one does.
# A prod release ends by uploading the iPhone app from the same commit to TestFlight (scripts/testflight.sh).
#   SKIP_TESTFLIGHT=1 leaves that out, and warns instead when testers' build is over 60 days old.
# The first release makes the key, <env>.release-key.pem, beside the config. Keep it backed up: apps built with it take
# updates signed by it and nothing else.
# The Mac app is signed with the keychain's Developer ID, and notarized with the App Store Connect key in the config
# folder, AuthKey_<key id>.p8 and asc-issuer-id, when it has them (docs/setup.md, step 15).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

env_name="${ENV:-staging}"
case "$env_name" in
  staging | prod) ;;
  *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;;
esac
# The release builds dist and then uploads it, so a run started alongside waits rather than rebuilding it in between.
[ -n "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$root/frontend/scripts/build-lock.sh" "$0" "$@"

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

# A release is a commit: its build number is the commit's time, and its version names the commit.
if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first: a release is built from a commit." >&2
  exit 1
fi
# Before anything is built: a prod release ends at TestFlight, so one that couldn't get there stops before it starts.
if [ "$env_name" = prod ] && [ "${SKIP_TESTFLIGHT:-}" != 1 ]; then
  node "$root/frontend/scripts/testflight.ts" check "$config_dir" "$(git -C "$root" log -1 --format=%ct)" ||
    { echo "Or release without the TestFlight upload: SKIP_TESTFLIGHT=1." >&2; exit 1; }
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
# The Mac app, signed, notarized when the config folder has the key, and checked: scripts/mac-app.sh.
ENV="$env_name" "$root/scripts/mac-app.sh"
dmg="$(ls -t "release/$env_name"/*.dmg | head -n 1)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
node scripts/release-files.ts pack dist "$key" "$out"

# The version first, where no host serves it, then each surface switched to it as the pipeline does
# (scripts/pipeline.sh). The disk image goes before the feeds, so an update that needs the new app can already link to it.
# The pipeline's next release prunes what no one needs any more (scripts/pipeline.sh prune).
version="$("$root/scripts/pipeline.sh" upload "$env_name" "$PWD/dist" "$out")"
aws s3 cp "$dmg" "s3://$bucket/downloads/Multiscale.dmg" --cache-control 'public, max-age=300' --content-type application/x-apple-diskimage
for surface in web desktop iphone shared; do "$root/scripts/pipeline.sh" switch "$env_name" "$surface" "$version"; done

echo "Released $version to $env_name"

# Then every suite that can run against what was just released. Releasing to prod has already said yes to prod.
# SKIP_TESTS=1 leaves them out, for a fix that can't wait for them; run make test-deployed after.
if [ "${SKIP_TESTS:-}" = 1 ]; then
  echo "Left out the deployed tests. Run make test-deployed ENV=$env_name when you can."
elif ! ENV="$env_name" CONFIRM_PROD=yes EXPECT_VERSION="$version" EXPECT_FEEDS="desktop iphone shared" "$root/scripts/test-deployed.sh"; then
  echo "$version is live on $env_name, but its tests failed. To go back, revert the bad commit and release that." >&2
  exit 1
fi

# Testers get prod's iPhone app from TestFlight, built from this commit so that it takes this release's updates. Last,
# so they only get a release that passed its tests.
[ "$env_name" = prod ] || exit 0
if [ "${SKIP_TESTFLIGHT:-}" = 1 ]; then
  echo "Left out the TestFlight upload. Run make testflight when you can."
  node scripts/testflight.ts age "$config_dir"
elif ! "$root/scripts/testflight.sh"; then
  echo "$version is live on prod, but its TestFlight upload failed. Run make testflight to try again." >&2
  exit 1
fi
