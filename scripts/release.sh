#!/usr/bin/env bash
# Puts out a release of Tandem, in an order that stops a broken one before it
# reaches anyone. Keyboard updates commit whatever the site bundles into every
# user's repo, so the site goes last:
#
#   1. The tests here, the same engine against the real GitHub, and CI on this
#      commit, including the firmware builds.
#   2. template/ goes to the config template repo.
#   3. That repo's own firmware build has to pass, both variants.
#   4. tandemkb.com deploys.
#
# Any step that fails stops the rest. Push the commit first. Usage: npm run release
set -euo pipefail

site_repo="${SITE_REPO:-itsthecsguy/tandem}"
template_repo="${TEMPLATE_REPO:-itsthecsguy/tandem-config}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

say() { printf '\n== %s\n' "$*"; }
stop() {
  printf '\nStopping: %s\n' "$*" >&2
  exit 1
}

# Waits for every Actions run of a commit, and stops unless they all passed.
wait_for_runs() {
  local repo="$1" sha="$2" none=0 runs
  for _ in $(seq 1 180); do
    runs="$(gh api "repos/$repo/actions/runs?head_sha=$sha&event=push&per_page=30" --jq '.workflow_runs[] | "\(.status) \(.conclusion // "-") \(.name) \(.html_url)"')"
    if [ -z "$runs" ]; then
      none=$((none + 1))
      [ "$none" -lt 15 ] || stop "$repo has no Actions run for ${sha:0:7}."
    elif ! grep -qv '^completed ' <<<"$runs"; then
      if grep -qv '^completed success ' <<<"$runs"; then
        grep -v '^completed success ' <<<"$runs" >&2
        stop "a run on $repo failed for ${sha:0:7}."
      fi
      echo "$repo passed at ${sha:0:7}."
      return
    fi
    sleep 20
  done
  stop "$repo's runs for ${sha:0:7} took over an hour."
}

[ "$(gh api user --jq .login)" = "itsthecsguy" ] || stop "the GitHub CLI isn't on the itsthecsguy account. Run: gh auth switch -u itsthecsguy"
[ -z "$(git status --porcelain)" ] || stop "there are uncommitted changes."
[ "$(git branch --show-current)" = main ] || stop "this isn't the main branch."
git fetch --quiet origin main
sha="$(git rev-parse HEAD)"
[ "$sha" = "$(git rev-parse origin/main)" ] || stop "this commit isn't on origin/main. Push it first, so CI runs on it."

say "Checks"
npm run --silent typecheck
npm --prefix helper run --silent typecheck
npm test --silent
npm run --silent build

say "Real GitHub"
npm run --silent e2e

say "CI on ${sha:0:7}"
wait_for_runs "$site_repo" "$sha"

say "Release number"
published="$(mktemp -d)"
trap 'rm -rf "$published"' EXIT
git clone --quiet --depth 1 "https://github.com/$template_repo.git" "$published"
version_file=tandem/zmk-tandem/version.txt
if ! diff -rq --exclude .git template "$published" >/dev/null && cmp -s "template/$version_file" "$published/$version_file"; then
  diff -rq --exclude .git template "$published" || true
  stop "template/ changed, but $version_file still says $(cat "template/$version_file"). Add a release to it and to shared/changelog.ts."
fi
echo "Tandem $(cat "template/$version_file")."

say "Config template"
scripts/publish-template.sh
wait_for_runs "$template_repo" "$(gh api "repos/$template_repo/commits/main" --jq .sha)"

say "Site"
npx wrangler deploy
echo "Released ${sha:0:7}."
