#!/bin/sh
# Redraws the design system reference page's screenshots (frontend/e2e/reference.spec.ts) on Linux, as CI compares
# them, in Playwright's own image. Its node_modules live in a Docker volume, so the host's stay as they are.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(node -p "require('$root/frontend/node_modules/playwright-core/package.json').version")"
# The build reads git, and a worktree's git lives outside it, so that's mounted where the worktree says it is.
git="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)"
docker run --rm --ipc=host \
  -v "$root:/work" -v "$git:$git" -v multiscale-reference-modules:/work/frontend/node_modules -w /work/frontend \
  "mcr.microsoft.com/playwright:v$version-noble" \
  sh -c 'git config --global --add safe.directory "*" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && npx playwright test e2e/reference.spec.ts --update-snapshots --reporter=line'
