#!/usr/bin/env bash
# Builds the Mac app for one environment and checks it as a release needs, leaving the disk image and the app in
# frontend/release/<env>. scripts/release.sh runs it on the Mac, and .github/workflows/mac-release.yml in GitHub Actions.
#   ENV=staging|prod MULTISCALE_CONFIG_DIR=<config folder> scripts/mac-app.sh
# The app is signed with the keychain's Developer ID, and notarized with the App Store Connect key in the config folder,
# AuthKey_<key id>.p8 and asc-issuer-id, when it has them (docs/setup.md, step 15).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_name="${ENV:?ENV must be staging or prod}"
config_dir="${MULTISCALE_CONFIG_DIR:?MULTISCALE_CONFIG_DIR must name the config folder}"

cd "$root/frontend"
# The App Store Connect key that notarizes the Mac app, from the config folder, for the build alone. It names the key's
# file, so the key itself is never printed.
notarize="$(node scripts/mac-signing.ts env "$config_dir")"
[ -n "$notarize" ] || echo "Not notarizing the Mac app: $config_dir has no App Store Connect key. See docs/setup.md, step 15."
(eval "$notarize" && ENV="$env_name" npm run electron:build)
dmg="$(ls -t "release/$env_name"/*.dmg | head -n 1)"
app="$(ls -td "release/$env_name"/mac*/*.app | head -n 1)"
if [ -n "$notarize" ]; then
  # The build fails if notarizing does. This checks that macOS will open both without asking, offline too.
  spctl -a -vv -t exec "$app"
  spctl -a -vv -t open --context context:primary-signature "$dmg"
  xcrun stapler validate "$app"
  xcrun stapler validate "$dmg"
fi
# The app starts as signed, under the hardened runtime: its page sets up the database through the main process and the
# one native library the app ships. In a data folder of its own, marked as past the first run so it adds no login item.
data="$(mktemp -d)"
touch "$data/login-item-set"
"$app/Contents/MacOS/$(basename "$app" .app)" --user-data-dir="$data" --use-mock-keychain >/dev/null 2>&1 &
started=0
for _ in $(seq 60); do
  [ "$(sqlite3 "$data/multiscale.sqlite" 'select count(*) from sqlite_master' 2>/dev/null || echo 0)" -gt 0 ] && started=1 && break
  sleep 0.5
done
kill $! 2>/dev/null && wait $! 2>/dev/null || true
rm -rf "$data"
[ "$started" = 1 ] || { echo "The Mac app in $app didn't start, so it wasn't released." >&2; exit 1; }
