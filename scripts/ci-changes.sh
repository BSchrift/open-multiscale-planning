#!/usr/bin/env bash
# Whether CI's iPhone jobs run, since they hold two of the few macOS runners for about half an hour. Usage:
#   git diff --name-only --no-renames <base> HEAD | scripts/ci-changes.sh <event>
# A push to main, a scheduled run and a run started by hand always run it, whatever changed. A pull request, or a merge
# group, runs it only when a path in its diff is something the iPhone app is built from or runs, or something that
# decides how CI runs it. The iPhone build is npm run ios:sync (vite build, then cap sync), then XCUITest:
#   - frontend/, except the Mac app (electron/), the browser tests (e2e/), unit tests, their configs, and the scripts
#     the iPhone build doesn't run. vite.config.ts imports electron/identity.ts only for the Mac app's shell hash.
#   - config/'s files the build reads: app.gen.ts, retention, and each environment's YAML. Not the Go that checks them.
#   - make test-ios: the Makefile and scripts/test-ios.sh, with the local stack it starts where Docker runs. CI's macOS
#     runners have no Docker, so the stack's own inputs aren't the iPhone job's.
#   - .github/workflows/ci.yml, which sets up the job.
# infrastructure/test/ci-changes.test.ts holds this list to what vite.config.ts and scripts/test-ios.sh read.
# Prints why, and adds ios=true or ios=false to $GITHUB_OUTPUT and the why to $GITHUB_STEP_SUMMARY when they're set.
set -euo pipefail

event="${1:?usage: scripts/ci-changes.sh <event>, with the changed paths on stdin}"

ios_input() {
  case "$1" in
    *.md) return 1 ;;
    # The native project, its UI tests and the test page test-ios.sh copies in.
    frontend/ios/*) return 0 ;;
    frontend/*.test.ts | frontend/*.test.tsx) return 1 ;;
    frontend/e2e/* | frontend/electron/* | frontend/playwright.config.ts | frontend/vitest.config.ts) return 1 ;;
    frontend/scripts/ios-sync.mjs | frontend/scripts/build-lock.sh | frontend/scripts/test-target.mjs) return 0 ;;
    # vite.config.ts imports these: the iPhone's shell hash and the release key go into the bundle's version.json.
    frontend/scripts/shell-hash.ts | frontend/scripts/sign-release.mjs) return 0 ;;
    frontend/scripts/*) return 1 ;;
    frontend/*) return 0 ;;
    config/*.go | config/go.mod | config/go.sum | config/cmd/* | config/*.example.yaml) return 1 ;;
    config/*) return 0 ;;
    scripts/test-ios.sh | scripts/local-stack.sh | Makefile | .github/workflows/ci.yml) return 0 ;;
    *) return 1 ;;
  esac
}

decide() {
  case "$event" in
    pull_request) what="this pull request" ;;
    merge_group) what="this merge group" ;;
    *)
      echo "true The iPhone tests run on every push to main, scheduled run and run started by hand."
      return
      ;;
  esac
  count=0
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    count=$((count + 1))
    if ios_input "$path"; then
      echo "true The iPhone tests run: $what changes \`$path\`, which the iPhone app is built from or runs."
      return
    fi
  done
  echo "false The iPhone tests are skipped: none of the $count changed files in $what is something the iPhone app is built from or runs (scripts/ci-changes.sh). Main runs them after it merges."
}

decision="$(decide)"
# The rest of the diff, so git's end of the pipe doesn't fail on a closed pipe.
cat >/dev/null
why="${decision#* }"
echo "$why" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "ios=${decision%% *}" >>"${GITHUB_OUTPUT:-/dev/null}"
