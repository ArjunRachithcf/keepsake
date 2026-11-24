#!/usr/bin/env bash
# Refuses a release whose manifest still has placeholders or an image not pinned by digest. CI runs it on tags.
set -euo pipefail
cd "$(dirname "$0")/.."
image="$(awk '/^image:/{print $2}' contracts/homerslab-app.yaml)"
fail=0
if grep -q '<[a-z]*>' <<<"$image"; then echo "contracts/homerslab-app.yaml: image has placeholders: $image" >&2; fail=1; fi
if ! grep -Eq '@sha256:[0-9a-f]{64}$' <<<"$image"; then echo "contracts/homerslab-app.yaml: image is not pinned by digest: $image" >&2; fail=1; fi
version="$(awk '/^version:/{print $2}' contracts/homerslab-app.yaml)"
if [ -n "${GITHUB_REF_NAME:-}" ] && [ "${GITHUB_REF_NAME#v}" != "$version" ]; then echo "tag $GITHUB_REF_NAME does not match manifest version $version" >&2; fail=1; fi
# The manifest's icon, relative to it (contracts/icon.svg).
icon="$(awk '/^icon:/{print $2}' contracts/homerslab-app.yaml)"
if [ -z "$icon" ] || [ ! -s "contracts/$icon" ]; then echo "contracts/homerslab-app.yaml: icon contracts/$icon does not exist" >&2; fail=1; fi
# One version everywhere (the source is apps/server/package.json; test/version.contract.test.ts checks the rest too).
source_version="$(node -p "require('./apps/server/package.json').version")"
for f in apps/web/package.json packages/contracts/package.json packages/draw/package.json; do
  v="$(node -p "require('./$f').version")"
  [ "$v" = "$source_version" ] || { echo "$f: version $v, not $source_version" >&2; fail=1; }
done
[ "$version" = "$source_version" ] || { echo "contracts/homerslab-app.yaml: version $version, not $source_version" >&2; fail=1; }
api_version="$(awk '/^info:/{f=1} f&&/^  version:/{print $2; exit}' contracts/openapi.yaml)"
[ "$api_version" = "$source_version" ] || { echo "contracts/openapi.yaml: info.version $api_version, not $source_version" >&2; fail=1; }
grep -q "keepsake:$source_version}" docker-compose.yml || { echo "docker-compose.yml: default tag is not keepsake:$source_version" >&2; fail=1; }
exit "$fail"
