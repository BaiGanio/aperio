#!/usr/bin/env bash
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pandoc_bin="${PANDOC_BIN:-pandoc}"

mkdir -p "$dir/build" "$dir/artifacts" "$dir/tmp/rendered"
rm -f "$dir/tmp/rendered"/*.png

"$pandoc_bin" \
  "$dir/source/setup-configuration.md" \
  --from markdown+raw_html \
  --to html5 \
  --standalone \
  --section-divs \
  --template "$dir/template.html5" \
  --css ../styles/content.css \
  --output "$dir/build/setup-configuration.html"

node "$dir/../_shared/render-tagged-pdf.mjs" \
  "$dir/build/setup-configuration.html" \
  "$dir/artifacts/aperio-setup-configuration-a4.pdf" \
  "$dir/styles/page-a4.css"

pdftoppm -png -r 100 "$dir/artifacts/aperio-setup-configuration-a4.pdf" "$dir/tmp/rendered/page"
