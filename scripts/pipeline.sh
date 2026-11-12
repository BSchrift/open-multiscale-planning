#!/usr/bin/env bash
# The release pipeline (infrastructure/lib/pipeline-stack.ts, docs/releasing.md): the commands that steer it from a Mac,
# and the steps its CodeBuild projects run.
#
# From a Mac, signed in with control.yaml's profile, through make:
#   config   make pipeline-config    uploads the config folder's files the pipeline reads to SSM in the control account,
#                                    each release key to where only the signing step reads it
#   pause    make pipeline-pause     main commits stop releasing; a run started by hand still goes
#   resume   make pipeline-resume    they release again
#   run      make promote            starts a run by hand: COMMIT=<sha> (default: the branch's latest), CANARY=skip,
#                                    ALARMS=off
#   stop     make pipeline-stop      stops the run waiting in its window before prod, so it never reaches prod
#   release-surface  make release-surface  ENV=staging|prod, signed in with that environment's profile: lists what each
#                                    surface serves and the versions kept, or with SURFACE=web|desktop|iphone|shared and
#                                    VERSION=<version>, switches one surface to a version kept
#   tag      make release-tag        tags the commit prod last released as release-<date>, and pushes the tag
# From scripts/release.sh on a Mac, signed in to the environment: upload and switch, the steps a release publishes with.
# In CodeBuild: install, build, deploy-staging, mac, release-staging, prod-assets, test-prod, release-prod, bake-check
# and nightly.
# The signing step runs frontend/scripts/sign-release.mjs on its own, from the Build output (pipeline-stack.ts).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
command="${1:-}"
pipeline=Multiscale
parameters=/multiscale/pipeline
# What the steps read from the config folder, under config/: each environment's file, and the public half of its release
# key, which its web build carries. The keys themselves go under signing/, which only the signing step may read.
configs=(control.yaml staging.yaml prod.yaml)
environments=(staging prod)

# Signs in as the profile of control.yaml or an environment's file, after checking the config folder, as deploy.sh does.
sign_in() {
  config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
  case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
  export MULTISCALE_CONFIG_DIR="$config_dir"
  [ -d "$root/infrastructure/node_modules" ] || (cd "$root/infrastructure" && npm ci)
  local target
  target="$(cd "$root/infrastructure" && node bin/target.ts "$1")"
  read -r account region profile <<<"$target"
  export AWS_PROFILE="$profile" AWS_REGION="$region"
}
control() { sign_in control; }

# In CodeBuild: the config folder from SSM, outside the checkout. It holds no release key.
fetch_config() {
  export MULTISCALE_CONFIG_DIR="$HOME/multiscale-config"
  mkdir -p "$MULTISCALE_CONFIG_DIR"
  local file env_name
  for file in "${configs[@]}" $(for env_name in "${environments[@]}"; do echo "$env_name.release-key.pub"; done); do
    aws ssm get-parameter --name "$parameters/config/$file" --with-decryption --query Parameter.Value --output text \
      >"$MULTISCALE_CONFIG_DIR/$file"
  done
}

# In CodeBuild: each environment's profile, named as its YAML names it, signs in as that account's release role, so the
# suites run as they do on a Mac. CDK uses the build's own role, and CDK's bootstrap roles from there.
profiles() {
  mkdir -p "$HOME/.aws"
  : >"$HOME/.aws/config"
  local env_name account region profile
  for env_name in "${environments[@]}"; do
    read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
    printf '[profile %s]\nrole_arn = arn:aws:iam::%s:role/multiscale-release\ncredential_source = EcsContainer\nregion = %s\n' \
      "$profile" "$account" "$region" >>"$HOME/.aws/config"
  done
}

# In CodeBuild: <env>.outputs.json from the deployed stack, as deploy.sh writes it on a Mac.
outputs() {
  local env_name="$1" account region profile raw
  read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
  raw="$(mktemp)"
  AWS_PROFILE="$profile" aws cloudformation describe-stacks --stack-name "Multiscale-$env_name" --query 'Stacks[0].Outputs' --output json |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.stringify({ [process.argv[1]]: Object.fromEntries(JSON.parse(s).map((o) => [o.OutputKey, o.OutputValue])) })));' "Multiscale-$env_name" >"$raw"
  (cd "$root/infrastructure" && node bin/write-outputs.ts "$env_name" "$raw")
}

# The Build step's output beside the checkout: the stacks' assemblies, and web/<env>, each environment's web build.
built() { echo "${CODEBUILD_SRC_DIR_Built:?the Built artifact is missing}"; }

frontend_deps() { (cd "$root/frontend" && npm ci --ignore-scripts --no-audit --no-fund); }
browsers() { (cd "$root/frontend" && npx playwright install --with-deps chromium webkit); }

# The shell (native code) a build or a feed's manifest needs, from stdin.
shell_of() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const r = JSON.parse(s); console.log(JSON.stringify((r.manifest ? JSON.parse(r.manifest) : r).shell)); } catch { console.log("none"); } });'
}

# Whether two shells, as shell_of prints them, differ for one app: electron or ios. No feed differs from any build.
differs() {
  node -e 'const [a, b, app] = process.argv.slice(1); const of = (s) => { try { return JSON.parse(s)[app]; } catch { return undefined; } }; process.exit(of(a) !== undefined && of(a) === of(b) ? 1 : 0);' "$1" "$2" "$3"
}

# Where each feed is in the release bucket, on the release host: the desktop and iphone feeds the apps read, and the
# shared one that bundles from before them read (frontend/src/core/updates.ts).
feed_key() { case "$1" in shared) echo release/release.json ;; *) echo "release/$1/release.json" ;; esac; }

# The shell of what a feed serves now, signed in as the environment's release role: desktop, iphone or shared. Until a
# surface's own feed exists, the shared one's, which is what installed apps took.
live_shell() {
  local env_name="$1" feed="${2:-shared}" account region profile bucket shell
  read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
  bucket="$(release_bucket "$env_name")"
  shell="$(AWS_PROFILE="$profile" aws s3 cp "s3://$bucket/$(feed_key "$feed")" - 2>/dev/null | shell_of || true)"
  if [ "$shell" = none ] && [ "$feed" != shared ]; then shell="$(live_shell "$env_name")"; fi
  echo "$shell"
}

# Whether an environment's downloads host serves a Mac app the MacApp step checked, as publish records it. A Mac app
# from before GitHub Actions built them, such as one released unsigned, has no record, so the next run replaces it.
checked_mac_live() {
  local env_name="$1" account region profile
  read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
  AWS_PROFILE="$profile" aws s3api head-object --bucket "$(release_bucket "$env_name")" --key mac/manifest.json >/dev/null 2>&1
}

# The newest TestFlight build testers can install, which Beta App Review approved for the Testers group, when it has a
# build's iPhone native code, given the build's shell as shell_of prints it; otherwise nothing. Only the newest, since
# TestFlight offers testers the newest build: an older one with this native code still out doesn't count. The
# TestFlight review workflow records it in the inbox every hour (.github/workflows/testflight-review.yml). Read as the
# pipeline's own role, which may read the inbox: the App Store Connect key stays in GitHub.
testflight_build() {
  [ -n "${MAC_INBOX_BUCKET:-}" ] || return 0
  aws s3 cp "s3://$MAC_INBOX_BUCKET/inbox/testflight/latest.json" - 2>/dev/null |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const r = JSON.parse(s); const ios = JSON.parse(process.argv[1]).ios; if (typeof ios === "string" && r.shell === ios && Number.isInteger(r.build) && r.build > 0) console.log(r.build); } catch {} });' "$1" || true
}

# One of an environment's stack outputs, from <env>.outputs.json in the config folder.
output() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? "")' "$MULTISCALE_CONFIG_DIR/$1.outputs.json" "$2"; }
release_bucket() { output "$1" ReleaseBucket; }

# 7-Zip, which reads a disk image's HFS+ volume on Linux, pinned by its hash. Ubuntu's p7zip is from 2016.
seven_zip() {
  if [ -n "${SEVENZIP:-}" ]; then echo "$SEVENZIP"; return; fi
  local dir=/tmp/7zip
  mkdir -p "$dir"
  curl -fsSL --retry 3 -o "$dir/7z.tar.xz" https://github.com/ip7z/7zip/releases/download/26.04/7z2604-linux-x64.tar.xz
  echo "fc0327ba27e89bd086cf426dff17d77de582953cdbbc10a6576540a06853ffcd  $dir/7z.tar.xz" | sha256sum -c --quiet >&2
  tar -xJf "$dir/7z.tar.xz" -C "$dir"
  echo "$dir/7zz"
}

# The version a web build names, such as 0.1.0-85e85c2: the package's version and the commit.
version_of() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$1/version.json"; }

# Uploads a version where no host serves it, so nothing anyone sees changes: the files its page and feed name by their
# contents into the stores the hosts serve, its page under versions/<version>/web/, and its signed feed under
# versions/<version>/, each with the headers a switch copies with it. Signed in to the environment: AWS_PROFILE.
upload() {
  local env_name="$1" web="$2" signed="$3" bucket version
  bucket="$(release_bucket "$env_name")"
  [ -n "$bucket" ] || { echo "$env_name has no ReleaseBucket to upload to." >&2; return 1; }
  version="$(version_of "$web")"
  # Named by their contents, so each uploads once and caches for good.
  aws s3 sync "$web/assets" "s3://$bucket/web/assets" --size-only --cache-control 'public, max-age=31536000, immutable' >&2
  aws s3 sync "$signed/files" "s3://$bucket/release/files" --size-only --cache-control 'public, max-age=31536000, immutable' --content-type application/octet-stream >&2
  aws s3 sync "$web" "s3://$bucket/versions/$version/web" --exclude 'assets/*' --cache-control 'no-cache' >&2
  aws s3 cp "$signed/release.json" "s3://$bucket/versions/$version/release.json" --cache-control 'public, max-age=60' --content-type application/json >&2
}

# Points one surface at a version already uploaded: web, or the desktop, iphone or shared feed. A few small copies inside
# the bucket, which keep the headers the upload set. Web's version.json goes last, so it names the version web serves
# only once the page is there. Each switch adds a line to state/history.json. Signed in to the environment: AWS_PROFILE.
switch() {
  local env_name="$1" surface="$2" version="$3" bucket info history
  bucket="$(release_bucket "$env_name")"
  info="$(aws s3 cp "s3://$bucket/versions/$version/web/version.json" - 2>/dev/null)" || { echo "$env_name has no version $version uploaded." >&2; return 1; }
  case "$surface" in
    web)
      aws s3 cp "s3://$bucket/versions/$version/web/" "s3://$bucket/web/" --recursive --exclude version.json >&2
      aws s3 cp "s3://$bucket/versions/$version/web/version.json" "s3://$bucket/web/version.json" >&2
      ;;
    desktop | iphone | shared) aws s3 cp "s3://$bucket/versions/$version/release.json" "s3://$bucket/$(feed_key "$surface")" >&2 ;;
    *) echo "There's no surface $surface: web, desktop, iphone or shared." >&2; return 1 ;;
  esac
  # Each surface's versions in the order it got them, for going back one.
  history="$(aws s3 cp "s3://$bucket/state/history.json" - 2>/dev/null || echo '{}')"
  node -e 'const [history, surface, info, at] = process.argv.slice(1); const h = JSON.parse(history); const { version, build } = JSON.parse(info); (h[surface] ??= []).push({ version, build, at }); console.log(JSON.stringify(h, null, 1));' \
    "$history" "$surface" "$info" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" |
    aws s3 cp - "s3://$bucket/state/history.json" --content-type application/json >&2
}

# A field of a page's version.json or a feed's manifest, from stdin, or nothing.
field_of() {
  node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { try { const r = JSON.parse(s); console.log((r.manifest ? JSON.parse(r.manifest) : r)[process.argv[1]] ?? ""); } catch { console.log(""); } });' "$1"
}

# The version a surface serves now, and the one it served before that, from state/history.json. Signed in: AWS_PROFILE.
serves() {
  local key
  case "$2" in web) key=web/version.json ;; *) key="$(feed_key "$2")" ;; esac
  aws s3 cp "s3://$1/$key" - 2>/dev/null | field_of version || true
}
served_before() {
  aws s3 cp "s3://$1/state/history.json" - 2>/dev/null |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const [surface, now] = process.argv.slice(1); let h = {}; try { h = JSON.parse(s); } catch {} const lines = (h[surface] ?? []).map((l) => l.version); while (lines.length > 0 && lines.at(-1) === now) lines.pop(); console.log(lines.at(-1) ?? ""); });' "$2" "$3" || true
}

# Whether a feed's apps couldn't take a version, given its version.json: one built for other native code than the feed
# serves now. Says why.
refuses() {
  local env_name="$1" surface="$2" info="$3" version app apps
  case "$surface" in desktop) apps=electron ;; iphone) apps=ios ;; shared) apps="electron ios" ;; *) return 1 ;; esac
  version="$(field_of version <<<"$info")"
  for app in $apps; do
    if differs "$(live_shell "$env_name" "$surface")" "$(shell_of <<<"$info")" "$app"; then
      echo "$version was built for other native code than the apps $env_name's $surface feed serves, so they couldn't take it." >&2
      return 0
    fi
  done
  return 1
}

# Switches one surface to a version kept, as make release-surface does, unless its apps couldn't take it. Going back
# further than one version on web is the owner's call, which it says. Signed in: AWS_PROFILE.
release_surface() {
  local env_name="$1" surface="$2" version="$3" bucket info now
  bucket="$(release_bucket "$env_name")"
  info="$(aws s3 cp "s3://$bucket/versions/$version/web/version.json" - 2>/dev/null)" || {
    echo "$env_name keeps no version $version. make release-surface ENV=$env_name lists the ones it keeps." >&2
    return 1
  }
  if refuses "$env_name" "$surface" "$info"; then return 1; fi
  now="$(serves "$bucket" "$surface")"
  if [ "$surface" = web ] && [ -n "$now" ] && [ "$version" != "$now" ] && [ "$version" != "$(served_before "$bucket" web "$now")" ] &&
    [ "$(field_of build <<<"$info")" -lt "$(aws s3 cp "s3://$bucket/web/version.json" - | field_of build)" ]; then
    echo "This takes web further back than the version before. The compatibility test only covers going back one, so check the app by hand."
  fi
  switch "$env_name" "$surface" "$version"
  echo "Switched $env_name's $surface from ${now:-nothing} to $version."
}

# What make release-surface lists without a VERSION: what each surface serves, its last versions, and the versions kept.
list_surfaces() {
  local env_name="$1" bucket surface
  bucket="$(release_bucket "$env_name")"
  echo "$env_name serves:"
  for surface in web desktop iphone shared; do printf '  %-8s %s\n' "$surface" "$(serves "$bucket" "$surface")"; done
  echo "Each surface's last versions, newest first:"
  aws s3 cp "s3://$bucket/state/history.json" - 2>/dev/null |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { let h = {}; try { h = JSON.parse(s); } catch {} for (const [surface, lines] of Object.entries(h)) console.log(`  ${surface.padEnd(8)} ${lines.slice(-3).reverse().map((l) => `${l.version} ${l.at}`).join(", ")}`); });' || true
  echo "Versions kept, newest first:"
  aws s3 ls "s3://$bucket/versions/" --recursive 2>/dev/null |
    node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => { const kept = s.split("\n").map((l) => /^(\S+ \S+) +\d+ versions\/([^/]+)\/web\/version\.json$/.exec(l)).filter(Boolean); for (const [, at, version] of kept.sort((a, b) => b[1].localeCompare(a[1]))) console.log(`  ${version.padEnd(16)} uploaded ${at}`); });' || true
  echo "To switch one: make release-surface ENV=$env_name SURFACE=web|desktop|iphone|shared VERSION=<version>"
}

# Waits up to two minutes for a surface's host to serve a version: a feed caches for a minute at the edge.
serving() {
  local env_name="$1" surface="$2" version="$3" url attempt
  case "$surface" in web) url="$(output "$env_name" WebUrl)/version.json" ;; *) url="$(output "$env_name" ReleaseUrl)/$(feed_key "$surface" | sed 's|^release/||')" ;; esac
  for attempt in $(seq 24); do
    [ "$(curl -fsS --max-time 20 "$url" 2>/dev/null | field_of version)" != "$version" ] || return 0
    sleep 5
  done
  echo "$env_name's $surface still doesn't serve $version after two minutes, at $url." >&2
  return 1
}

# Staging's web app and app feeds, each switched back one version and forward again with release-surface's code, and
# read back from its host after each switch. A surface with no version before, or one its apps couldn't take, is left.
# shortcut: a release that switches staging during the round trip may be switched back by it, though each surface
# takes seconds; move the round trip into the pipeline's Staging stage if that ever happens.
round_trip() {
  local env_name=staging bucket surface now before failed=""
  bucket="$(release_bucket "$env_name")"
  for surface in web desktop iphone; do
    now="$(serves "$bucket" "$surface")"
    before="$(served_before "$bucket" "$surface" "$now")"
    if [ -z "$now" ] || [ -z "$before" ]; then
      echo "$surface has no version before ${now:-this} to go back to, so it stays as it is."
      continue
    fi
    if refuses "$env_name" "$surface" "$(aws s3 cp "s3://$bucket/versions/$before/web/version.json" - 2>/dev/null || echo '{}')"; then continue; fi
    release_surface "$env_name" "$surface" "$before"
    serving "$env_name" "$surface" "$before" || failed="$failed $surface"
    release_surface "$env_name" "$surface" "$now"
    serving "$env_name" "$surface" "$now" || failed="$failed $surface"
  done
  [ -z "$failed" ] || { echo "Going back one version and forward again failed for:$failed." >&2; return 1; }
}

# Publishes one environment's build in today's single step, as release.sh does from a Mac: uploads it, then switches
# every surface that can take it, and sets version and feeds to the version and the feeds it switched. The web app
# always switches. Each feed compares only its own app's native code with what it serves now: the desktop feed switches
# when the Mac app's is unchanged or a Mac app the MacApp step checked is published first, the iPhone feed when the
# iPhone app's is unchanged or the newest TestFlight build testers can install has the new one, and the shared feed only
# when both do, so no installed app is told it needs an app that isn't out. A run doesn't wait for Beta App Review,
# which can take a day: the first run after it passes the build switches the iPhone feed. A Mac app the MacApp step
# checked is published whenever it hands one on, as when the downloads host served none it checked, with the record
# that it's a checked one.
publish() {
  local env_name="$1" signed="$2" web account region profile build mac="${CODEBUILD_SRC_DIR_MacApps:-}" dmg="" waiting="" feed testflight=""
  web="$(built)/web/$env_name"
  read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
  [ -n "$(release_bucket "$env_name")" ] || { echo "$env_name has no ReleaseBucket to publish to." >&2; exit 1; }
  build="$(shell_of <"$web/version.json")"
  version="$(version_of "$web")"
  feeds=""
  if [ -n "$mac" ] && [ -f "$mac/$env_name/Multiscale.dmg" ]; then dmg="$mac/$env_name/Multiscale.dmg"; fi
  if ! differs "$(live_shell "$env_name" desktop)" "$build" electron; then
    feeds=desktop
  elif [ -z "$mac" ]; then
    waiting="Mac"
  elif [ -n "$dmg" ]; then
    feeds=desktop
  else
    echo "This build needs a newer Mac app than $env_name's desktop feed, but this run checked none for $env_name, so nothing is published." >&2
    echo "Run the Mac release workflow for this commit (docs/releasing.md), then run the pipeline again." >&2
    exit 1
  fi
  if ! differs "$(live_shell "$env_name" iphone)" "$build" ios; then
    feeds="$feeds iphone"
  else
    testflight="$(testflight_build "$build")"
    if [ -n "$testflight" ]; then feeds="$feeds iphone"; else waiting="${waiting:+$waiting and }iPhone"; fi
  fi
  [ -n "$waiting" ] || feeds="$feeds shared"
  (
    export AWS_PROFILE="$profile"
    upload "$env_name" "$web" "$signed"
    switch "$env_name" web "$version"
    if [ -n "$dmg" ]; then
      # Before the feed, which then links apps that can't take it to this app.
      aws s3 cp "$dmg" "s3://$(release_bucket "$env_name")/downloads/Multiscale.dmg" --cache-control 'public, max-age=300' --content-type application/x-apple-diskimage || exit 1
      # Then the record that it's a checked app, which the downloads host doesn't serve.
      aws s3 cp "$(dirname "$dmg")/manifest.json" "s3://$(release_bucket "$env_name")/mac/manifest.json" --content-type application/json || exit 1
      echo "Published the Mac app GitHub Actions built, which the MacApp step checked."
    fi
    for feed in $feeds; do switch "$env_name" "$feed" "$version"; done
  )
  if [ -n "$testflight" ]; then
    echo "Testers can install TestFlight build $testflight, which has this build's iPhone native code, so $env_name's iPhone feed takes it."
  fi
  if [ -n "$waiting" ]; then
    echo "This build needs a newer $waiting app than $env_name's feeds serve, so those feeds and the shared one stay as they are."
    case "$waiting" in *Mac*) echo "Release from the Mac, at this commit, to upload the app and then the feeds: make release ENV=$env_name." ;; esac
    case "$waiting" in *iPhone*) echo "GitHub Actions uploads an iPhone app with the new native code to TestFlight. The first run once the newest TestFlight build testers can install has this native code switches the iPhone feed (docs/releasing.md)." ;; esac
  fi
}

case "$command" in
  config)
    control
    for file in "${configs[@]}" $(for env_name in "${environments[@]}"; do echo "$env_name.release-key.pem"; done); do
      [ -f "$MULTISCALE_CONFIG_DIR/$file" ] || { echo "Missing $MULTISCALE_CONFIG_DIR/$file. Release from the Mac first if it's a key." >&2; exit 1; }
    done
    for file in "${configs[@]}"; do
      aws ssm put-parameter --name "$parameters/config/$file" --type SecureString --overwrite --value "file://$MULTISCALE_CONFIG_DIR/$file" >/dev/null
      echo "Uploaded $file"
    done
    for env_name in "${environments[@]}"; do
      key="$MULTISCALE_CONFIG_DIR/$env_name.release-key.pem"
      public="$(node -e 'const c = require("crypto"); console.log(c.createPublicKey(require("fs").readFileSync(process.argv[1])).export({ format: "der", type: "spki" }).subarray(-32).toString("base64"))' "$key")"
      aws ssm put-parameter --name "$parameters/config/$env_name.release-key.pub" --type String --overwrite --value "$public" >/dev/null
      # Deleted first, so the parameter's history keeps no earlier key.
      aws ssm delete-parameter --name "$parameters/signing/$env_name.release-key.pem" >/dev/null 2>&1 || true
      aws ssm put-parameter --name "$parameters/signing/$env_name.release-key.pem" --type SecureString \
        --key-id alias/multiscale-release-signing --value "file://$key" >/dev/null
      echo "Uploaded $env_name's release key, for the signing step only, and its public half"
    done
    ;;
  pause | resume)
    control
    value=true
    [ "$command" = pause ] || value=false
    aws ssm put-parameter --name "$parameters/paused" --type String --overwrite --value "$value" >/dev/null
    if [ "$command" = pause ]; then echo "Paused: main commits stop at Build. make promote still runs one."; else echo "Resumed: each main commit releases to staging."; fi
    ;;
  run)
    case "${CANARY:-}" in "" | skip) ;; *) echo "CANARY must be skip or unset, not $CANARY" >&2; exit 1 ;; esac
    case "${ALARMS:-}" in "" | off) ;; *) echo "ALARMS must be off or unset, not $ALARMS" >&2; exit 1 ;; esac
    case "${ENV:-prod}" in prod) ;; *) echo "A run promotes to prod, so ENV can only be prod, not $ENV" >&2; exit 1 ;; esac
    control
    args=(--name "$pipeline" --variables "name=RUN,value=hand" "name=CANARY,value=${CANARY:-on}" "name=ALARMS,value=${ALARMS:-on}")
    [ -z "${COMMIT:-}" ] || args+=(--source-revisions "actionName=GitHub,revisionType=COMMIT_ID,revisionValue=$COMMIT")
    id="$(aws codepipeline start-pipeline-execution "${args[@]}" --query pipelineExecutionId --output text)"
    skipping=""
    [ -z "${CANARY:-}" ] || skipping=", sending prod all traffic at once"
    [ -z "${ALARMS:-}" ] || skipping="$skipping, with the release alarms off"
    echo "Started run $id${COMMIT:+ at $COMMIT}$skipping. After staging it waits out its window before prod: make pipeline-stop stops it."
    ;;
  stop)
    control
    # The run in the Promote stage, if one is waiting there. Stopping abandons it: its window's wait ends, and nothing
    # after it runs.
    read -r id status <<<"$(aws codepipeline get-pipeline-state --name "$pipeline" --query "stageStates[?stageName=='Promote'].latestExecution.[pipelineExecutionId,status] | [0]" --output text)"
    if [ "${status:-}" != InProgress ]; then
      echo "No run is waiting to go to prod."
      exit 0
    fi
    commit="$(aws codepipeline get-pipeline-execution --pipeline-name "$pipeline" --pipeline-execution-id "$id" --query 'pipelineExecution.artifactRevisions[0].revisionId' --output text)"
    aws codepipeline stop-pipeline-execution --pipeline-name "$pipeline" --pipeline-execution-id "$id" --abandon --reason "Stopped before prod by make pipeline-stop" >/dev/null
    # Abandoning leaves the window's own wait running, and its email's Promote now link would still answer it.
    machine="$(aws stepfunctions list-state-machines --query "stateMachines[?starts_with(name, 'Promotion')].stateMachineArn | [0]" --output text)"
    if [ -n "$machine" ] && [ "$machine" != None ]; then
      for execution in $(aws stepfunctions list-executions --state-machine-arn "$machine" --status-filter RUNNING --query 'executions[].executionArn' --output text); do
        aws stepfunctions stop-execution --execution-arn "$execution" --cause "Stopped before prod by make pipeline-stop" >/dev/null
      done
    fi
    echo "Stopped run $id, at $commit, before prod. Staging keeps it; prod doesn't get it."
    ;;
  release-surface)
    env_name="${ENV:-staging}"
    case "$env_name" in staging | prod) ;; *) echo "ENV must be staging or prod, not $env_name" >&2; exit 1 ;; esac
    case "${SURFACE:-}" in "" | web | desktop | iphone | shared) ;; *) echo "SURFACE must be web, desktop, iphone or shared, not $SURFACE" >&2; exit 1 ;; esac
    [ -z "${VERSION:-}" ] || [ -n "${SURFACE:-}" ] || { echo "Name the SURFACE to switch to $VERSION: web, desktop, iphone or shared." >&2; exit 1; }
    sign_in "$env_name"
    signed_in="$(aws sts get-caller-identity --query Account --output text)"
    if [ "$signed_in" != "$account" ]; then
      echo "Profile $AWS_PROFILE is signed in to account $signed_in, but $env_name.yaml is for $account." >&2
      exit 1
    fi
    if [ -z "${VERSION:-}" ]; then list_surfaces "$env_name"; else release_surface "$env_name" "$SURFACE" "$VERSION"; fi
    ;;
  tag)
    control
    # The commit, then what the run noted: a skipped canary, or the release alarms off.
    read -r commit notes <<<"$(aws ssm get-parameter --name "$parameters/released" --query Parameter.Value --output text)"
    git -C "$root" fetch --quiet origin "$commit"
    tag="release-$(date -u +%Y-%m-%d)"
    n=1
    while git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null || git -C "$root" ls-remote --exit-code --tags origin "$tag" >/dev/null; do
      n=$((n + 1))
      tag="release-$(date -u +%Y-%m-%d)-$n"
    done
    git -C "$root" tag -a "$tag" -m "Released to prod by the pipeline.${notes:+ $notes}" "$commit"
    git -C "$root" push --quiet origin "$tag"
    echo "Tagged $commit as $tag. Build the signed apps from it: git checkout $tag && make release ENV=prod"
    ;;

  upload)
    # scripts/pipeline.sh upload <env> <web build> <signed release>, printing the version.
    upload "$2" "$3" "$4"
    version_of "$3"
    ;;
  switch)
    # scripts/pipeline.sh switch <env> web|desktop|iphone|shared <version>.
    switch "$2" "$3" "$4"
    ;;

  install)
    # Node and Go as CI has them. Go fetches go.mod's toolchain itself.
    command -v n >/dev/null || npm install --global --silent n
    n 25 >/dev/null
    (cd "$root/infrastructure" && npm ci --no-audit --no-fund)
    ;;
  build)
    # The pause switch holds back runs that main commits start, never one started by hand.
    if [ "${RUN:-auto}" != hand ] && [ "$(aws ssm get-parameter --name "$parameters/paused" --query Parameter.Value --output text 2>/dev/null || echo false)" = true ]; then
      echo "Automatic runs are paused (make pipeline-resume). Stopping this one."
      aws codepipeline stop-pipeline-execution --pipeline-name "$pipeline" --pipeline-execution-id "$EXECUTION_ID" --abandon --reason "Automatic runs are paused"
      sleep 60
      exit 1
    fi
    fetch_config
    for env_name in "${environments[@]}"; do (cd "$root/config" && go run ./cmd/check "$env_name"); done
    # Built once: both environments deploy these binaries, from these assemblies.
    for name in api calendar retention canary; do
      (cd "$root/backend" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -trimpath -ldflags='-s -w -buildid=' \
        -o "$root/backend/dist/$name/bootstrap" "./cmd/$name")
    done
    # The canary skip is prod's alone, since staging's is short. The alarms switch is the whole run's: the fix it ships
    # goes through staging, which may be alarming too.
    skip=()
    [ "${CANARY:-on}" != skip ] || skip=(-c canary=skip)
    alarms=()
    [ "${ALARMS:-on}" != off ] || alarms=(-c alarms=off)
    (
      cd "$root/infrastructure"
      npx cdk synth --quiet -c deploy=staging ${alarms[@]+"${alarms[@]}"} -o cdk.out/staging Multiscale-staging
      npx cdk synth --quiet -c deploy=prod ${skip[@]+"${skip[@]}"} ${alarms[@]+"${alarms[@]}"} -o cdk.out/prod Multiscale-prod
    )
    # Each environment's web build, from this commit, carrying its key's public half, and the script that signs them.
    profiles
    frontend_deps
    for env_name in "${environments[@]}"; do
      outputs "$env_name"
      (cd "$root/frontend" && ENV="$env_name" npx vite build --outDir "$root/web/$env_name" --emptyOutDir)
      # And its Mac app's main process, which a Mac app GitHub Actions built must hold exactly.
      (cd "$root/frontend" && ENV="$env_name" node scripts/electron-compile.mjs && mkdir -p "$root/mac/$env_name" && cp -R dist-electron "$root/mac/$env_name/")
    done
    mkdir -p "$root/web"
    cp "$root/frontend/scripts/sign-release.mjs" "$root/web/sign-release.mjs"
    ;;
  deploy-staging)
    # Waits out staging's short canary.
    (cd "$root/infrastructure" && npx cdk deploy --app "$(built)/infrastructure/cdk.out/staging" Multiscale-staging --require-approval never)
    ;;
  mac)
    # For each environment whose feed needs a newer Mac app than this build's, or whose downloads host serves none the
    # pipeline checked, the Mac app GitHub Actions built from this commit: waited for in the inbox, checked, and handed to
    # the releases (frontend/scripts/mac-inbox.ts).
    fetch_config
    profiles
    frontend_deps
    checked="$root/mac-checked"
    sevenzip=""
    mkdir -p "$checked"
    for env_name in "${environments[@]}"; do
      outputs "$env_name"
      if differs "$(live_shell "$env_name" desktop)" "$(shell_of <"$(built)/web/$env_name/version.json")" electron; then
        echo "$env_name's desktop feed needs a newer Mac app than this build's."
      elif ! checked_mac_live "$env_name"; then
        echo "$env_name's downloads host serves no Mac app the pipeline checked, so it gets this build's."
      else
        echo "$env_name's desktop feed can take this build as its Mac app is, so it needs no new one."
        echo "$env_name: no new Mac app needed" >>"$checked/checked.txt"
        continue
      fi
      key="inbox/${COMMIT:?}/$env_name"
      echo "Waiting up to $((MAC_WAIT_SECONDS / 60)) minutes for GitHub Actions' build of $COMMIT in s3://$MAC_INBOX_BUCKET/$key."
      deadline=$((SECONDS + MAC_WAIT_SECONDS))
      until aws s3api head-object --bucket "$MAC_INBOX_BUCKET" --key "$key/manifest.json" >/dev/null 2>&1; do
        if [ "$SECONDS" -ge "$deadline" ]; then
          echo "No Mac app for $env_name at $COMMIT reached the inbox in time, so this run stops before publishing anything." >&2
          echo "Approve the Mac release workflow's run for this commit, or start one: gh workflow run mac-release.yml -f commit=$COMMIT" >&2
          echo "Then run the pipeline again for it: make promote COMMIT=$COMMIT. See docs/releasing.md." >&2
          exit 1
        fi
        sleep 30
      done
      inbox="$(mktemp -d)"
      aws s3 cp "s3://$MAC_INBOX_BUCKET/$key/" "$inbox" --recursive --no-progress
      sevenzip="${sevenzip:-$(seven_zip)}"
      SEVENZIP="$sevenzip" node "$root/frontend/scripts/mac-inbox.ts" verify "$env_name" "$COMMIT" "$inbox" "$(built)/web/$env_name" "$(built)/mac/$env_name/dist-electron"
      mkdir -p "$checked/$env_name"
      cp "$inbox/Multiscale.dmg" "$inbox/manifest.json" "$checked/$env_name/"
      echo "$env_name: checked $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).files["Multiscale.dmg"].sha256)' "$inbox/manifest.json")" >>"$checked/checked.txt"
    done
    ;;
  release-staging)
    fetch_config
    profiles
    outputs staging
    # The cross-version suite tests against the bundle prod serves.
    outputs prod
    frontend_deps
    browsers
    publish staging "${CODEBUILD_SRC_DIR_SignedStaging:?}"
    # Retention and the history-scale test are left to the nightly run.
    ENV=staging EXPECT_VERSION="$version" EXPECT_FEEDS="$feeds" SKIP_IOS=1 SKIP_HISTORY=1 SKIP_RETENTION=1 "$root/scripts/test-deployed.sh"
    ;;
  prod-assets)
    # The Lambdas' code, into prod's CDK bucket, for the change set the next action makes.
    (cd "$root/infrastructure" && npx cdk publish-assets --unstable=publish-assets --app "$(built)/infrastructure/cdk.out/prod" Multiscale-prod)
    ;;
  test-prod)
    fetch_config
    profiles
    outputs prod
    frontend_deps
    browsers
    # The released apps against the promoted backend, before anything new is signed or published. The web app is still
    # the release before this one, so checks of this release's own screens wait for release-prod.
    ENV=prod CONFIRM_PROD=yes SKIP_IOS=1 DEPLOYED_BEFORE_PUBLISH=1 "$root/scripts/test-deployed.sh"
    ;;
  release-prod)
    fetch_config
    profiles
    outputs prod
    frontend_deps
    browsers
    publish prod "${CODEBUILD_SRC_DIR_SignedProd:?}"
    ENV=prod CONFIRM_PROD=yes EXPECT_VERSION="$version" EXPECT_FEEDS="$feeds" SKIP_IOS=1 "$root/scripts/test-deployed.sh"
    # For make release-tag, and the signed apps built from that tag.
    # With the release's notes: whether it skipped the canary or ran without the release alarms.
    notes=""
    [ "${CANARY:-on}" != skip ] || notes="Canary skipped."
    [ "${ALARMS:-on}" != off ] || notes="${notes:+$notes }Release alarms off."
    aws ssm put-parameter --name "$parameters/released" --type String --overwrite --value "${COMMIT:?}${notes:+ $notes}" >/dev/null
    ;;
  bake-check)
    # After a surface's bake on prod, web or desktop: whether a release alarm is in ALARM. If one is, the surface switches
    # back by itself to what it served before this run switched it, and the step fails, which stops the run before the
    # next surface and emails. Desktop is its feed and the shared one, each back to its own version before. A surface no
    # longer on this run's version, switched since by hand, stays. A run with ALARMS=off only reports, since its release
    # went out with the alarms off.
    case "${2:-}" in web) surfaces=web ;; desktop) surfaces="desktop shared" ;; *) echo "Use: scripts/pipeline.sh bake-check web|desktop" >&2; exit 1 ;; esac
    fetch_config
    profiles
    outputs prod
    read -r _ _ profile <<<"$(cd "$root/infrastructure" && node bin/target.ts prod)"
    export AWS_PROFILE="$profile"
    names="$(output prod ReleaseAlarms)"
    [ -n "$names" ] || { echo "prod's stack has no ReleaseAlarms output yet, so its alarms can't be checked. A run that deploys it adds it." >&2; exit 1; }
    firing="$(aws cloudwatch describe-alarms --alarm-names ${names//,/ } --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text | tr -s '\t\n' ' ' | sed 's/ *$//')"
    if [ -z "$firing" ] || [ "$firing" = None ]; then
      echo "No release alarm is in ALARM after $2's bake."
      exit 0
    fi
    if [ "${ALARMS:-on}" = off ]; then
      echo "$firing in ALARM after $2's bake, but this run has the release alarms off, so it goes on."
      exit 0
    fi
    version="$(version_of "$(built)/web/prod")"
    bucket="$(release_bucket prod)"
    for surface in $surfaces; do
      now="$(serves "$bucket" "$surface")"
      before="$(served_before "$bucket" "$surface" "$version")"
      if [ "$now" = "$version" ] && [ -n "$before" ]; then
        switch prod "$surface" "$before"
        echo "Switched prod's $surface back from $version to $before."
      else
        echo "prod's $surface serves ${now:-nothing}, not this run's $version, so it stays as it is."
      fi
    done
    echo "$firing in ALARM after $2's bake, so the run stops here. Look at the alarms in prod's account; make release-surface ENV=prod lists what each surface serves." >&2
    exit 1
    ;;
  nightly)
    commit="$(git -C "$root" rev-parse HEAD)"
    if [ "$(aws ssm get-parameter --name "$parameters/nightly" --query Parameter.Value --output text 2>/dev/null || true)" = "$commit" ]; then
      echo "Nothing new on main since the last nightly run passed at $commit."
      exit 0
    fi
    fetch_config
    profiles
    outputs staging
    outputs prod
    frontend_deps
    browsers
    # Each surface back one version and forward again, as make release-surface would, then the suites against it.
    (
      read -r _ _ profile <<<"$(cd "$root/infrastructure" && node bin/target.ts staging)"
      export AWS_PROFILE="$profile"
      round_trip
    )
    apt-get update -qq && apt-get install -y -qq xvfb >/dev/null
    # Every suite but the iPhone's, which needs a Mac. The history-scale test only reports its numbers.
    xvfb-run -a env ENV=staging SKIP_IOS=1 "$root/scripts/test-deployed.sh"
    aws ssm put-parameter --name "$parameters/nightly" --type String --overwrite --value "$commit" >/dev/null
    ;;
  *)
    echo "Use: scripts/pipeline.sh config | pause | resume | run | stop | release-surface | tag, or a CodeBuild step. See docs/releasing.md." >&2
    exit 1
    ;;
esac
