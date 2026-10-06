#!/usr/bin/env bash
# Cuts a release: bumps the version, commits, tags and pushes main and the tag in one go; release.yml
# builds and publishes it. The next version comes from the tags, never from package.json.
# Usage: npm run release -- [--check] [--minor]
#   --check  show the next version, the changes since the last tag and the CI status, change nothing
#   --minor  bump the minor version instead of the patch version
set -euo pipefail
cd "$(dirname "$0")/.."

check=false part=patch
for arg; do
  case $arg in
    --check) check=true ;;
    --minor) part=minor ;;
    *) echo "usage: npm run release -- [--check] [--minor]" >&2; exit 2 ;;
  esac
done

git fetch -q --tags origin main
last=$(git tag -l 'v*' --sort=-v:refname | head -1)
IFS=. read -r major minor patch <<<"${last#v}"
if [ $part = minor ]; then next=$major.$((minor + 1)).0; else next=$major.$minor.$((patch + 1)); fi

# CI result of the newest tested commit on main. The screenshot commits release.yml pushes get no
# CI run of their own, so commits after it may only touch those screenshots.
head=$(git rev-parse origin/main)
runs=$(gh run list --workflow ci.yml --branch main --limit 30 --json headSha,status,conclusion)
ci=none
for sha in $(git rev-list -30 origin/main); do
  ci=$(jq -r --arg s "$sha" 'map(select(.headSha == $s))[0] // empty | if .conclusion != "" then .conclusion else .status end' <<<"$runs")
  [ -n "$ci" ] && break
done
[ -n "$ci" ] || ci=none
if [ "$ci" != none ] && ! git diff --quiet "$sha" "$head" -- . ':!docs/screenshots' ':!site/img'; then
  ci="untested commits after ${sha:0:7}"
fi

echo "next:    v$next (last $last)"
echo "main:    $(git log -1 --format='%h %s' "$head")"
echo "ci:      $ci"
echo "changes since $last:"
git log --oneline --no-merges "$last..$head" | sed 's/^/  /'
$check && exit 0

fail() { echo "release: $*" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || fail "not on main"
[ "$(git rev-parse HEAD)" = "$head" ] || fail "local main differs from origin/main"
[ "$ci" = success ] || fail "CI is not green: $ci"
files=(package.json package-lock.json desktop/package.json desktop/package-lock.json)
git diff --quiet HEAD -- "${files[@]}" || fail "uncommitted changes in the version files"

npm version "$next" --no-git-tag-version >/dev/null
(cd desktop && npm version "$next" --no-git-tag-version --allow-same-version >/dev/null)
git commit -q -m "chore: release v$next" -- "${files[@]}"
git tag -s "v$next" -m "Savor v$next"
git push -q --atomic origin main "v$next"
echo "pushed v$next, release.yml builds it: https://github.com/robinchoice/savor/actions/workflows/release.yml"
