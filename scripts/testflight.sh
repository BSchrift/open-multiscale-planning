#!/usr/bin/env bash
# Uploads the iPhone app to TestFlight from this Mac: a prod build of this commit, archived with automatic signing,
# exported for App Store Connect and uploaded. make release ENV=prod runs it after each prod release, and GitHub Actions
# runs it on a Mac with Xcode 26 (.github/workflows/testflight.yml).
#   EXPORT_ONLY=1 archives and exports it to a folder without uploading, which proves the signing works before the app
#   exists in App Store Connect.
# Apple is reached with the App Store Connect key in the config folder, AuthKey_<key id>.p8 and asc-issuer-id, and the
# team is the one in frontend/ios/App/Config.local.xcconfig (docs/setup.md, TestFlight).
# The build number is the commit's time, as a release's is, so each commit's build is newer than the last. Built from a
# clean commit, its web bundle names the same native code as that commit's release (scripts/shell-hash.ts), so the
# build takes updates from prod's feed like any other prod build.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
# The build rewrites dist and the iOS project's copy of it, so a run started alongside waits.
[ -n "${MULTISCALE_BUILD_LOCK:-}" ] || exec "$root/frontend/scripts/build-lock.sh" "$0" "$@"

config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
export MULTISCALE_CONFIG_DIR="$config_dir"

if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
  echo "Commit or stash your changes first: a TestFlight build is built from a commit." >&2
  exit 1
fi
build="$(git -C "$root" log -1 --format=%ct)"

cd "$root/frontend"
[ -d node_modules ] || npm ci
# The key's path and ids. Nothing here prints the key, and -quiet keeps xcodebuild from echoing its arguments.
eval "$(node scripts/testflight.ts key "$config_dir")"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
destination=upload
if [ "${EXPORT_ONLY:-}" = 1 ]; then
  destination=export
else
  # Before the slow part: the app must exist in App Store Connect, and the build number must be new to it.
  node scripts/testflight.ts check "$config_dir" "$build"
fi

ENV=prod npm run ios:sync
out="$(mktemp -d)"
[ "$destination" = export ] || trap 'rm -rf "$out"' EXIT
echo "Archiving build $build"
xcodebuild -quiet -project ios/App/App.xcodeproj -scheme App -configuration Release -destination generic/platform=iOS \
  -archivePath "$out/Multiscale.xcarchive" "${auth[@]}" CURRENT_PROJECT_VERSION="$build" archive
# App Store Connect refuses an app with a symlink in it (ITMS-90332), but only after the upload, so this stops first.
links="$(find "$out/Multiscale.xcarchive/Products/Applications" -type l)"
if [ -n "$links" ]; then
  printf 'The archived app has symbolic links, which App Store Connect refuses:\n%s\n' "$links" >&2
  exit 1
fi

# Xcode would otherwise renumber the build as it uploads.
cat >"$out/export.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$destination</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict>
</plist>
EOF
xcodebuild -quiet -exportArchive -archivePath "$out/Multiscale.xcarchive" -exportOptionsPlist "$out/export.plist" \
  -exportPath "$out/export" "${auth[@]}"

if [ "$destination" = export ]; then
  echo "Exported build $build for App Store Connect, not uploaded: $out/export"
else
  echo "Uploaded build $build. Waiting for App Store Connect to process it, usually within half an hour."
  node scripts/testflight.ts testers "$config_dir" "$build"
fi
