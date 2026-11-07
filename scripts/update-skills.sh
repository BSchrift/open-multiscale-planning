#!/usr/bin/env bash
# Updates each skill in .claude/skills to its repo's latest release, as .claude/skills/sources.tsv lists them: its
# SKILL.md and the repo's LICENSE, then the release in sources.tsv. It never commits: these files instruct agents, so
# read the diff before you do.
#   scripts/update-skills.sh, or make update-skills
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/.claude/skills"
list="$dir/sources.tsv"
next="$(mktemp)"
trap 'rm -f "$next"' EXIT

latest() {
  curl -sfL "https://api.github.com/repos/$1/releases/latest" | node -e 'let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => console.log(JSON.parse(s).tag_name ?? ""))'
}
fetch() {
  curl -sfL "https://raw.githubusercontent.com/$1/$2/$3" -o "$4"
}

while IFS= read -r line; do
  case "$line" in '#'* | '') echo "$line" >>"$next"; continue ;; esac
  IFS=$'\t' read -r skill repo path release <<<"$line"
  tag="$(latest "$repo" || true)"
  if [ -z "$tag" ]; then
    echo "$skill: couldn't read $repo's latest release; kept $release" >&2
    echo "$line" >>"$next"
    continue
  fi
  mkdir -p "$dir/$skill"
  fetch "$repo" "$tag" "$path/SKILL.md" "$dir/$skill/SKILL.md"
  fetch "$repo" "$tag" LICENSE "$dir/$skill/LICENSE"
  printf '%s\t%s\t%s\t%s\n' "$skill" "$repo" "$path" "$tag" >>"$next"
  [ "$tag" = "$release" ] && echo "$skill: $tag, up to date" || echo "$skill: $release to $tag"
done <"$list"
mv "$next" "$list"
trap - EXIT

git -C "$root" --no-pager diff --stat -- .claude/skills
echo "Read the changes before committing them: agents follow these files."
