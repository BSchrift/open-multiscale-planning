#!/usr/bin/env bash
# The release pipeline (infrastructure/lib/pipeline-stack.ts, docs/releasing.md): the commands that steer it from a Mac,
# and the steps its CodeBuild projects run.
#
# From a Mac, signed in with control.yaml's profile, through make:
#   config   make pipeline-config    uploads the config folder's files the pipeline reads to SSM in the control account
#   pause    make pipeline-pause     main commits stop releasing; a run started by hand still goes
#   resume   make pipeline-resume    they release again
#   run      make promote            starts a run by hand: COMMIT=<sha> (default: the branch's latest), CANARY=skip
#   tag      make release-tag        tags the commit prod last released as release-<date>, and pushes the tag
# In CodeBuild: install, build, deploy-staging, release-staging, prod-assets, test-prod, release-prod and nightly.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
command="${1:-}"
pipeline=Multiscale
parameters=/multiscale/pipeline
# Everything a step reads from the config folder. The release keys sign each environment's feed.
files=(control.yaml staging.yaml prod.yaml staging.release-key.pem prod.release-key.pem)

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

# In CodeBuild: the config folder from SSM, outside the checkout.
fetch_config() {
  export MULTISCALE_CONFIG_DIR="$HOME/multiscale-config"
  mkdir -p "$MULTISCALE_CONFIG_DIR"
  for file in "${files[@]}"; do
    aws ssm get-parameter --name "$parameters/config/$file" --with-decryption --query Parameter.Value --output text \
      >"$MULTISCALE_CONFIG_DIR/$file"
  done
}

# In CodeBuild: each environment's profile, named as its YAML names it, signs in as that account's release role, so the
# suites and release.sh run as they do on a Mac. CDK uses the build's own role, and CDK's bootstrap roles from there.
profiles() {
  mkdir -p "$HOME/.aws"
  : >"$HOME/.aws/config"
  local env_name account region profile
  for env_name in staging prod; do
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

# The assemblies the Build step synthesized, beside the checkout.
built() { echo "${CODEBUILD_SRC_DIR_Built:?the Built artifact is missing}"; }

case "$command" in
  config)
    control
    for file in "${files[@]}"; do
      [ -f "$MULTISCALE_CONFIG_DIR/$file" ] || { echo "Missing $MULTISCALE_CONFIG_DIR/$file. Release from the Mac first if it's a key." >&2; exit 1; }
    done
    for file in "${files[@]}"; do
      aws ssm put-parameter --name "$parameters/config/$file" --type SecureString --overwrite --value "file://$MULTISCALE_CONFIG_DIR/$file" >/dev/null
      echo "Uploaded $file"
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
    case "${ENV:-prod}" in prod) ;; *) echo "A run promotes to prod, so ENV can only be prod, not $ENV" >&2; exit 1 ;; esac
    control
    args=(--name "$pipeline" --variables "name=RUN,value=hand" "name=CANARY,value=${CANARY:-on}")
    [ -z "${COMMIT:-}" ] || args+=(--source-revisions "actionName=GitHub,revisionType=COMMIT_ID,revisionValue=$COMMIT")
    id="$(aws codepipeline start-pipeline-execution "${args[@]}" --query pipelineExecutionId --output text)"
    skipping=""
    [ -z "${CANARY:-}" ] || skipping=", sending prod all traffic at once"
    echo "Started run $id${COMMIT:+ at $COMMIT}$skipping. It still waits for your approval before prod."
    ;;
  tag)
    control
    commit="$(aws ssm get-parameter --name "$parameters/released" --query Parameter.Value --output text)"
    git -C "$root" fetch --quiet origin "$commit"
    tag="release-$(date -u +%Y-%m-%d)"
    n=1
    while git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null || git -C "$root" ls-remote --exit-code --tags origin "$tag" >/dev/null; do
      n=$((n + 1))
      tag="release-$(date -u +%Y-%m-%d)-$n"
    done
    git -C "$root" tag -a "$tag" -m "Released to prod by the pipeline" "$commit"
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
    for env_name in staging prod; do (cd "$root/config" && go run ./cmd/check "$env_name"); done
    # Built once: both environments deploy these binaries, from these assemblies.
    for name in api calendar retention canary; do
      (cd "$root/backend" && GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -tags lambda.norpc -trimpath -ldflags='-s -w -buildid=' \
        -o "$root/backend/dist/$name/bootstrap" "./cmd/$name")
    done
    skip=()
    [ "${CANARY:-on}" != skip ] || skip=(-c canary=skip)
    cd "$root/infrastructure"
    npx cdk synth --quiet -c deploy=staging -o cdk.out/staging Multiscale-staging
    npx cdk synth --quiet -c deploy=prod ${skip[@]+"${skip[@]}"} -o cdk.out/prod Multiscale-prod
    ;;
  deploy-staging)
    # Waits out staging's short canary.
    (cd "$root/infrastructure" && npx cdk deploy --app "$(built)/infrastructure/cdk.out/staging" Multiscale-staging --require-approval never)
    ;;
  release-staging)
    fetch_config
    profiles
    outputs staging
    # The cross-version suite tests against the bundle prod serves.
    outputs prod
    (cd "$root/frontend" && npm ci --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium webkit)
    # Its web app and feed, then the suites against them. Retention and the history-scale test are left to the nightly run.
    SKIP_MAC_APP=1 SKIP_IOS=1 SKIP_HISTORY=1 SKIP_RETENTION=1 ENV=staging "$root/scripts/release.sh"
    ;;
  prod-assets)
    # The Lambdas' code, into prod's CDK bucket, for the change set the next action makes.
    (cd "$root/infrastructure" && npx cdk publish-assets --unstable=publish-assets --app "$(built)/infrastructure/cdk.out/prod" Multiscale-prod)
    ;;
  test-prod)
    fetch_config
    profiles
    outputs prod
    (cd "$root/frontend" && npm ci --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium webkit)
    # The released apps against the promoted backend, before anything new is published.
    ENV=prod CONFIRM_PROD=yes SKIP_IOS=1 "$root/scripts/test-deployed.sh"
    ;;
  release-prod)
    fetch_config
    profiles
    outputs prod
    (cd "$root/frontend" && npm ci --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium webkit)
    SKIP_MAC_APP=1 SKIP_IOS=1 ENV=prod "$root/scripts/release.sh"
    # For make release-tag, and the signed apps built from that tag.
    aws ssm put-parameter --name "$parameters/released" --type String --overwrite --value "${COMMIT:?}" >/dev/null
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
    # The cross-version suite tests against the bundle prod serves.
    outputs prod
    (cd "$root/frontend" && npm ci --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps chromium webkit)
    apt-get update -qq && apt-get install -y -qq xvfb >/dev/null
    # Every suite but the iPhone's, which needs a Mac. The history-scale budgets only report for now.
    xvfb-run -a env ENV=staging SKIP_IOS=1 HISTORY_REPORT_ONLY=1 "$root/scripts/test-deployed.sh"
    aws ssm put-parameter --name "$parameters/nightly" --type String --overwrite --value "$commit" >/dev/null
    ;;
  *)
    echo "Use: scripts/pipeline.sh config | pause | resume | run | tag, or a CodeBuild step. See docs/releasing.md." >&2
    exit 1
    ;;
esac
