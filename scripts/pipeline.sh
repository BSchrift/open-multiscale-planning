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
#   tag      make release-tag        tags the commit prod last released as release-<date>, and pushes the tag
# In CodeBuild: install, build, deploy-staging, mac, release-staging, prod-assets, test-prod, release-prod and nightly.
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

# Signs in as control.yaml's profile, after checking the config folder, as deploy.sh does.
control() {
  config_dir="${MULTISCALE_CONFIG_DIR:-$root/config}"
  case "$config_dir" in /*) ;; *) config_dir="$PWD/$config_dir" ;; esac
  export MULTISCALE_CONFIG_DIR="$config_dir"
  [ -d "$root/infrastructure/node_modules" ] || (cd "$root/infrastructure" && npm ci)
  local target
  target="$(cd "$root/infrastructure" && node bin/target.ts control)"
  read -r _ region profile <<<"$target"
  export AWS_PROFILE="$profile" AWS_REGION="$region"
}

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

# The shell of the feed an environment's apps update from now, signed in as its release role.
live_shell() {
  local env_name="$1" account region profile bucket
  read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
  bucket="$(release_bucket "$env_name")"
  AWS_PROFILE="$profile" aws s3 cp "s3://$bucket/release/release.json" - 2>/dev/null | shell_of || true
}

release_bucket() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ReleaseBucket ?? "")' "$MULTISCALE_CONFIG_DIR/$1.outputs.json"
}

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

# Publishes one environment's web build from the Build output and its feed from the signing step's, as release.sh does
# on a Mac, and prints the version. The web app goes as it is. When the build needs newer native code than the feed's,
# the feed waits for the apps that can take it: a Mac app the MacApp step checked is published first, as a release from
# the Mac uploads the app before the feed. An iPhone app is still released from the Mac.
publish() {
  local env_name="$1" signed="$2" web account region profile bucket live build mac="${CODEBUILD_SRC_DIR_MacApps:-}" waiting=""
  web="$(built)/web/$env_name"
  read -r account region profile <<<"$(cd "$root/infrastructure" && node bin/target.ts "$env_name")"
  bucket="$(release_bucket "$env_name")"
  [ -n "$bucket" ] || { echo "$env_name has no ReleaseBucket to publish to." >&2; exit 1; }
  live="$(live_shell "$env_name")"
  build="$(shell_of <"$web/version.json")"
  (
    export AWS_PROFILE="$profile"
    if differs "$live" "$build" electron; then
      if [ -z "$mac" ]; then
        waiting="Mac"
      elif [ -f "$mac/$env_name/Multiscale.dmg" ]; then
        # Before the feed, which then links apps that can't take it to this app.
        aws s3 cp "$mac/$env_name/Multiscale.dmg" "s3://$bucket/downloads/Multiscale.dmg" --cache-control 'public, max-age=300' --content-type application/x-apple-diskimage >&2 || exit 1
        echo "Published the Mac app GitHub Actions built, which the MacApp step checked." >&2
      else
        echo "This build needs a newer Mac app than $env_name's feed, but this run checked none for $env_name, so nothing is published." >&2
        echo "Run the Mac release workflow for this commit (docs/releasing.md), then run the pipeline again." >&2
        exit 1
      fi
    fi
    if differs "$live" "$build" ios; then waiting="${waiting:+$waiting and }iPhone"; fi
    if [ -z "$waiting" ]; then
      # Files are named by their contents, so each uploads once and caches for good.
      aws s3 sync "$signed/files" "s3://$bucket/release/files" --size-only --cache-control 'public, max-age=31536000, immutable' --content-type application/octet-stream >&2
      aws s3 cp "$signed/release.json" "s3://$bucket/release/release.json" --cache-control 'public, max-age=60' --content-type application/json >&2
    else
      echo "This build needs a newer $waiting app than $env_name's feed, so the feed stays as it is. Release from the Mac," >&2
      echo "at this commit, to upload the app and then the feed: make release ENV=$env_name." >&2
    fi
    # Its named-by-content assets first, then the page that loads them. Old assets stay, as release.sh leaves them.
    aws s3 sync "$web/assets" "s3://$bucket/web/assets" --size-only --cache-control 'public, max-age=31536000, immutable' >&2
    aws s3 sync "$web" "s3://$bucket/web" --exclude 'assets/*' --cache-control 'no-cache' >&2
  ) || exit 1
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$web/version.json"
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
    echo "Stopped run $id, at $commit, before prod. Staging keeps it; prod doesn't get it."
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
    # For each environment whose feed needs a newer Mac app than this build's, the Mac app GitHub Actions built from
    # this commit: waited for in the inbox, checked, and handed to the releases (frontend/scripts/mac-inbox.ts).
    fetch_config
    profiles
    frontend_deps
    checked="$root/mac-checked"
    sevenzip=""
    mkdir -p "$checked"
    for env_name in "${environments[@]}"; do
      outputs "$env_name"
      if ! differs "$(live_shell "$env_name")" "$(shell_of <"$(built)/web/$env_name/version.json")" electron; then
        echo "$env_name's feed can take this build as its Mac app is, so it needs no new one."
        echo "$env_name: no new Mac app needed" >>"$checked/checked.txt"
        continue
      fi
      key="inbox/${COMMIT:?}/$env_name"
      echo "$env_name needs a new Mac app. Waiting up to $((MAC_WAIT_SECONDS / 60)) minutes for GitHub Actions' build of $COMMIT in s3://$MAC_INBOX_BUCKET/$key."
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
    version="$(publish staging "${CODEBUILD_SRC_DIR_SignedStaging:?}")"
    # Retention and the history-scale test are left to the nightly run.
    ENV=staging EXPECT_VERSION="$version" SKIP_IOS=1 SKIP_HISTORY=1 SKIP_RETENTION=1 "$root/scripts/test-deployed.sh"
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
    # The released apps against the promoted backend, before anything new is signed or published.
    ENV=prod CONFIRM_PROD=yes SKIP_IOS=1 "$root/scripts/test-deployed.sh"
    ;;
  release-prod)
    fetch_config
    profiles
    outputs prod
    frontend_deps
    browsers
    version="$(publish prod "${CODEBUILD_SRC_DIR_SignedProd:?}")"
    ENV=prod CONFIRM_PROD=yes EXPECT_VERSION="$version" SKIP_IOS=1 "$root/scripts/test-deployed.sh"
    # For make release-tag, and the signed apps built from that tag.
    # With the release's notes: whether it skipped the canary or ran without the release alarms.
    notes=""
    [ "${CANARY:-on}" != skip ] || notes="Canary skipped."
    [ "${ALARMS:-on}" != off ] || notes="${notes:+$notes }Release alarms off."
    aws ssm put-parameter --name "$parameters/released" --type String --overwrite --value "${COMMIT:?}${notes:+ $notes}" >/dev/null
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
    apt-get update -qq && apt-get install -y -qq xvfb >/dev/null
    # Every suite but the iPhone's, which needs a Mac. The history-scale test only reports its numbers.
    xvfb-run -a env ENV=staging SKIP_IOS=1 "$root/scripts/test-deployed.sh"
    aws ssm put-parameter --name "$parameters/nightly" --type String --overwrite --value "$commit" >/dev/null
    ;;
  *)
    echo "Use: scripts/pipeline.sh config | pause | resume | run | stop | tag, or a CodeBuild step. See docs/releasing.md." >&2
    exit 1
    ;;
esac
