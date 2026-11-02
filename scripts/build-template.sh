#!/usr/bin/env bash
# Builds the config template's firmware the way a user's repo does: it runs
# every `west build` line in the template's own workflow, so both halves in both
# variants, from the manifest and module as they'd be published. CI runs this.
# To run it here, in a copy of template/ inside the build image:
#   docker run --rm -v "$PWD/template-copy":/w -w /w <image from shared/pins.json> bash /w/build-template.sh /w
set -euo pipefail

cd "${1:-"$(dirname "$0")/../template"}"
export GITHUB_WORKSPACE="$PWD"

bin/get_version.sh V3.0 0000000
mkdir -p tandem
echo 'CONFIG_TANDEM_BUILD_ID="check"' > tandem/build-id.conf
echo 'CONFIG_TANDEM_REPO="itsthecsguy/tandem-config"' >> tandem/build-id.conf

[ -d .west ] || west init -l config
west update --narrow -o=--depth=1
west zephyr-export

sed -n 's/^ *run: \(west build .*\)$/\1/p' .github/workflows/build.yml | while IFS= read -r build; do
  rm -rf build
  echo "== $build"
  eval "$build" </dev/null
done
