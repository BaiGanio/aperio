#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pandoc_bin="${PANDOC_BIN:-pandoc}"

mkdir -p "$proof_dir/build" "$proof_dir/artifacts" "$proof_dir/tmp/rendered/a4" "$proof_dir/tmp/rendered/letter"
find "$proof_dir/tmp/rendered/a4" "$proof_dir/tmp/rendered/letter" -type f -name 'page-*.png' -delete

"$pandoc_bin" \
  "$proof_dir/source/proof.md" \
  --from markdown+raw_html \
  --to html5 \
  --standalone \
  --section-divs \
  --toc \
  --toc-depth=3 \
  --template "$proof_dir/template.html5" \
  --css ../styles/screen.css \
  --css ../styles/print.css \
  --output "$proof_dir/build/proof.html"

node "$proof_dir/render-tagged-pdf.mjs" \
  "$proof_dir/build/proof.html" \
  "$proof_dir/artifacts/aperio-publishing-proof-a4.pdf" \
  "$proof_dir/styles/page-a4.css"

node "$proof_dir/render-tagged-pdf.mjs" \
  "$proof_dir/build/proof.html" \
  "$proof_dir/artifacts/aperio-publishing-proof-letter.pdf" \
  "$proof_dir/styles/page-letter.css"

pdftoppm -png -r 144 \
  "$proof_dir/artifacts/aperio-publishing-proof-a4.pdf" \
  "$proof_dir/tmp/rendered/a4/page"

pdftoppm -png -r 144 \
  "$proof_dir/artifacts/aperio-publishing-proof-letter.pdf" \
  "$proof_dir/tmp/rendered/letter/page"

printf '%s\n' "Built HTML, tagged A4 PDF, tagged Letter PDF, and QA page renders."
