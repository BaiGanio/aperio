#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$prototype_dir/../../.." && pwd)"
pandoc_bin="${PANDOC_BIN:-pandoc}"
pdf_dir="$repo_dir/output/pdf"
render_dir="$repo_dir/tmp/pdfs/manual-visual-system"

mkdir -p "$pdf_dir" "$render_dir"

build_direction() {
  local slug="$1"
  local label="$2"
  local html="$prototype_dir/preview-$slug.html"

  "$pandoc_bin" \
    "$prototype_dir/source/prototype.md" \
    --from markdown+raw_html+fenced_divs \
    --to html5 \
    --standalone \
    --section-divs \
    --template "$prototype_dir/template.html5" \
    --variable "visual-system=$slug" \
    --variable "visual-system-label=$label" \
    --css styles/base.css \
    --css "styles/$slug.css" \
    --output "$html"

  for paper in a4 letter; do
    local pdf="$pdf_dir/aperio-manual-$slug-$paper.pdf"
    local pages="$render_dir/$slug/$paper"
    mkdir -p "$pages"
    find "$pages" -type f -name 'page-*.png' -delete
    node "$prototype_dir/render-tagged-pdf.mjs" "$html" "$pdf" "$prototype_dir/styles/page-$paper.css"
    pdftoppm -png -r 120 "$pdf" "$pages/page"
  done
}

build_direction signal-desk "Signal Desk"
build_direction night-receiver "Night Receiver"
build_direction field-console "Field Console"

printf '%s\n' "Built three responsive HTML previews, six tagged PDFs, and visual-QA page renders."
