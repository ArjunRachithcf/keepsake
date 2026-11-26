#!/usr/bin/env bash
# Copies HomersLab's design kit (Homeward's design/, Apache-2.0) into apps/web/src/vendor/homerslab/, unchanged, and
# writes vendor.json: where it came from (the commit) and each file's SHA-256. apps/web/test/vendor.test.ts fails when
# a vendored file differs from vendor.json, so the kit changes only through this script, never by hand.
#   scripts/sync-design.sh [path to a Homeward checkout, default ~/homerslab]
#   scripts/sync-design.sh --check [path]   compares the vendored files, byte for byte, with design/ at the commit
#                                           vendor.json pins (needs the checkout, so a local check: CI has only the
#                                           test against vendor.json)
set -euo pipefail
cd "$(dirname "$0")/.."
check=0
if [ "${1:-}" = --check ]; then check=1; shift; fi
src="${1:-$HOME/homerslab}"
dest=apps/web/src/vendor/homerslab
# The files Keepsake uses: the tokens, the components, the icons, the motion, the font (and what components.css names).
files=(tokens.css components.css icons.js motion.js mark.svg fonts/inter.woff2 fonts/OFL-inter.txt)
[ -d "$src/design" ] || { echo "sync-design: no design/ in $src" >&2; exit 2; }
if [ "$check" -eq 1 ]; then
  pinned="$(sed -n 's/^  "commit": "\([0-9a-f]\{40\}\)",$/\1/p' "$dest/vendor.json")"
  [ -n "$pinned" ] || { echo "sync-design: vendor.json pins no commit" >&2; exit 2; }
  git -C "$src" cat-file -e "$pinned^{commit}" 2>/dev/null || { echo "sync-design: $pinned is not in $src (fetch it)" >&2; exit 2; }
  bad=0
  for f in "${files[@]}"; do
    if ! git -C "$src" show "$pinned:design/$f" | cmp -s - "$dest/$f"; then echo "sync-design: $dest/$f differs from design/$f at $pinned" >&2; bad=1; fi
  done
  [ "$bad" -eq 0 ] || exit 1
  echo "sync-design: $dest matches design/ at $pinned"
  exit 0
fi
if [ -n "$(git -C "$src" status --porcelain -- design)" ]; then echo "sync-design: $src/design has uncommitted changes" >&2; exit 2; fi
commit="$(git -C "$src" rev-parse HEAD)"
mkdir -p "$dest/fonts"
for f in "${files[@]}"; do cp "$src/design/$f" "$dest/$f"; done
{
  printf '{\n  "source": "https://github.com/ArjunRachithcf/homeward",\n  "path": "design/",\n  "commit": "%s",\n  "license": "Apache-2.0 (fonts/inter.woff2: SIL Open Font License 1.1, fonts/OFL-inter.txt)",\n  "files": {\n' "$commit"
  n=${#files[@]}; i=0
  for f in "${files[@]}"; do
    i=$((i + 1)); sep=','; [ "$i" -eq "$n" ] && sep=''
    printf '    "%s": "%s"%s\n' "$f" "$(sha256sum "$dest/$f" | cut -d' ' -f1)" "$sep"
  done
  printf '  }\n}\n'
} > "$dest/vendor.json"
echo "sync-design: $dest from $commit"
