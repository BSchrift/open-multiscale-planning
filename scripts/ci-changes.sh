#!/usr/bin/env bash
# Whether CI's iPhone job runs, and which of scripts/test-ios.sh's suites, since it holds one of the few macOS runners
# for its whole length. Usage:
#   git diff --name-only --no-renames <base> HEAD | scripts/ci-changes.sh <event>
# A push to main, a scheduled run and a run started by hand always run every test, whatever changed. A pull request, or
# a merge group, runs every test when its diff changes the iPhone tests, their test page or how they run; the smoke set
# when it changes something else the iPhone app is built from or runs, or something that decides how CI runs it; and
# nothing otherwise. The iPhone build is npm run ios:sync (vite build, then cap sync), then XCUITest:
#   - frontend/, except the Mac app (electron/), the browser tests (e2e/), unit tests, their configs, and the scripts
#     the iPhone build doesn't run. vite.config.ts imports electron/identity.ts only for the Mac app's shell hash.
#   - config/'s files the build reads: app.gen.ts, retention, and each environment's YAML. Not the Go that checks them.
#   - make test-ios: the Makefile and scripts/test-ios.sh, with the local stack it starts where Docker runs. CI's macOS
#     runners have no Docker, so the stack's own inputs aren't the iPhone job's.
#   - .github/workflows/ci.yml, which sets up the job.
# infrastructure/test/ci-changes.test.ts holds this list to what vite.config.ts and scripts/test-ios.sh read.
# Prints why, and adds ios=true or ios=false, and suite=full, smoke or none, to $GITHUB_OUTPUT and the why to
# $GITHUB_STEP_SUMMARY when they're set.
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

# The iPhone tests themselves, the test page they seed from and the script that runs them, which a pull request changes
# only to change what the tests do: every test runs to show they still pass.
ios_test() {
  case "$1" in
    *.md) return 1 ;;
    frontend/ios/App/UITests/* | frontend/ios/harness/* | frontend/src/platform/capacitor-checks.ts | scripts/test-ios.sh) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints whether the job runs, the suite, then why.
decide() {
  case "$event" in
    pull_request) what="this pull request" ;;
    merge_group) what="this merge group" ;;
    *)
      echo "true full The iPhone tests run, every iPhone test, on every push to main, scheduled run and run started by hand."
      return
      ;;
  esac
  count=0
  input=""
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    count=$((count + 1))
    if ios_test "$path"; then
      echo "true full The iPhone tests run, every iPhone test: $what changes \`$path\`, one of the iPhone tests or what runs them."
      return
    fi
    if [ -z "$input" ] && ios_input "$path"; then input="$path"; fi
  done
  if [ -n "$input" ]; then
    echo "true smoke The iPhone tests run, the smoke set: $what changes \`$input\`, which the iPhone app is built from or runs."
    return
  fi
  echo "false none The iPhone tests are skipped: none of the $count changed files in $what is something the iPhone app is built from or runs (scripts/ci-changes.sh). Main runs them after it merges."
}

decision="$(decide)"
# The rest of the diff, so git's end of the pipe doesn't fail on a closed pipe.
cat >/dev/null
read -r ios suite why <<<"$decision"
echo "$why" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
printf 'ios=%s\nsuite=%s\n' "$ios" "$suite" >>"${GITHUB_OUTPUT:-/dev/null}"
