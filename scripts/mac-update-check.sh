#!/usr/bin/env bash
# The staging update check (.github/workflows/mac-update-check.yml, docs/releasing.md): on a Mac with no signing
# secrets, the staging app passed before updates itself, as an installed app does, to the app staging's desktop feed
# names; then it quits, so Squirrel installs the new app, and opens again as that app. A pass, in OUT/pass.json, is what
# prod's release waits for before it takes a new Mac app (scripts/pipeline.sh, publish). With no app passed before, as
# for the first app that updates itself, it checks only that the app the feed names installs and starts.
#   RELEASE_URL=<staging's release host> DOWNLOADS_URL=<staging's downloads host> PREVIOUS=<app version passed before>
#   OUT=<folder> scripts/mac-update-check.sh
set -euo pipefail

name="Multiscale Staging"
release_url="${RELEASE_URL:?RELEASE_URL names staging's release host}"
downloads_url="${DOWNLOADS_URL:?DOWNLOADS_URL names staging's downloads host}"
out="${OUT:?OUT names the folder for the pass}"
previous="${PREVIOUS:-}"
mkdir -p "$out"

# The app staging's desktop feed names, from its signed manifest. The app itself checks the signature; this only
# needs to know which app to expect.
read -r version build folder <<<"$(curl -fsS --retry 3 "$release_url/desktop/release.json" |
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const a = JSON.parse(JSON.parse(s).manifest).app; console.log(a ? `${a.version} ${a.build} ${a.folder}` : ""); });')"
if [ -z "${version:-}" ]; then
  echo "Staging's desktop feed names no app yet, so there's nothing to check."
  exit 0
fi
if [ "$previous" = "$version" ]; then
  echo "App $version passed already."
  exit 0
fi

apps="$HOME/Applications"
app="$apps/$name.app"
data="$HOME/Library/Application Support/$name"
mkdir -p "$apps" "$data"
# Past its first run, so it adds no login item to the runner.
touch "$data/login-item-set"

# Installs an app from its disk image, as someone dragging it to Applications does. Downloaded with curl, it has no
# quarantine, so Gatekeeper's first-launch prompt, which a runner can't answer, doesn't appear (checked by hand).
install() {
  local dmg mount
  dmg="$(mktemp -d)/Multiscale.dmg"
  mount="$(mktemp -d)"
  curl -fsS --retry 3 -o "$dmg" "$1"
  hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" >/dev/null
  rm -rf "$app"
  ditto "$mount/$name.app" "$app"
  hdiutil detach "$mount" >/dev/null
}
app_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist"; }
running() { pgrep -f "$app/Contents/MacOS/$name" >/dev/null; }
# Waits up to $1 seconds for a condition, saying what it waited for when it gives up.
wait_for() {
  local seconds="$1" what="$2"
  shift 2
  for _ in $(seq "$seconds"); do "$@" && return 0; sleep 1; done
  echo "Gave up after ${seconds}s waiting for $what." >&2
  return 1
}
staged() { [ -f "$data/staged-app.json" ] && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).build === Number(process.argv[2]) ? 0 : 1)' "$data/staged-app.json" "$build"; }
installed() { [ "$(app_version)" = "$version" ] && ! pgrep -x ShipIt >/dev/null; }
started() { [ "$(sqlite3 "$data/multiscale.sqlite" 'select count(*) from sqlite_master' 2>/dev/null || echo 0)" -gt 0 ]; }

if [ -n "$previous" ]; then
  install "$downloads_url/mac/$previous/Multiscale.dmg"
  echo "Installed app $previous. Opening it, to update itself to $version."
  open "$app"
  # It checks soon after it starts, downloads quietly, and Squirrel stages the new app once its signature checks out.
  wait_for 900 "app $previous to download and stage app $version" staged
  # Quit, as from the menu bar: Squirrel installs the staged app as the app quits, and doesn't open it again.
  osascript -e "tell application \"$app\" to quit"
  wait_for 120 "app $previous to quit" bash -c "! pgrep -f '$app/Contents/MacOS/$name' >/dev/null"
  wait_for 300 "ShipIt to install app $version" installed
  echo "Squirrel installed app $version at quit, and didn't open it again."
  if running; then echo "The app opened again after Quit, which it mustn't." >&2; exit 1; fi
else
  echo "No app has passed before, so this checks only that app $version installs and starts."
  install "$downloads_url/${folder}Multiscale.dmg"
fi

# Opened again: it's the new app, and it starts, under the hardened runtime, as mac-app.sh checks a build.
[ "$(app_version)" = "$version" ] || { echo "The installed app is $(app_version), not $version." >&2; exit 1; }
rm -f "$data/multiscale.sqlite"
open "$app"
wait_for 60 "app $version to start" started
osascript -e "tell application \"$app\" to quit" || true
node -e 'console.log(JSON.stringify({ version: process.argv[1], build: Number(process.argv[2]), from: process.argv[3] || null, at: new Date().toISOString() }))' "$version" "$build" "$previous" >"$out/pass.json"
echo "App $version passed: ${previous:+updated itself from $previous, }installed, opened and started."
