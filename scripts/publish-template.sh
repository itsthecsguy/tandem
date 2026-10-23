#!/usr/bin/env bash
# Publishes template/ as the config template repo, one commit per publish.
# Commits as this repo's git identity. Usage: scripts/publish-template.sh
set -euo pipefail

repo="${TEMPLATE_REPO:-itsthecsguy/tandem-config}"
remote="${TEMPLATE_REMOTE:-https://github.com/$repo.git}"
root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if ! git clone --quiet "$remote" "$work" 2>/dev/null; then
  echo "$repo has no history yet, starting it."
  git init --quiet -b main "$work"
  git -C "$work" remote add origin "$remote"
fi
# A repo created empty clones with no branch. Publish to main.
git -C "$work" rev-parse --quiet --verify HEAD >/dev/null || git -C "$work" symbolic-ref HEAD refs/heads/main

rsync -a --delete --exclude .git "$root/template/" "$work/"

git -C "$work" config user.name "$(git -C "$root" config user.name)"
git -C "$work" config user.email "$(git -C "$root" config user.email)"
git -C "$work" config commit.gpgsign false
git -C "$work" add -A
if git -C "$work" diff --cached --quiet; then
  echo "$repo already matches template/."
  exit 0
fi
git -C "$work" commit --quiet -m "Update from tandem $(git -C "$root" rev-parse --short HEAD)"
git -C "$work" push --quiet origin main
echo "Published template/ to $remote"
