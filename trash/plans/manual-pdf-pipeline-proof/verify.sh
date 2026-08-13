#!/usr/bin/env bash
set -euo pipefail

proof_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
a4="$proof_dir/artifacts/aperio-publishing-proof-a4.pdf"
letter="$proof_dir/artifacts/aperio-publishing-proof-letter.pdf"
html="$proof_dir/build/proof.html"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if ! grep -Fq "$needle" <<<"$haystack"; then
    printf 'FAIL: %s (missing %s)\n' "$label" "$needle" >&2
    return 1
  fi

  printf 'PASS: %s\n' "$label"
}

html_text="$(tr '\n' ' ' < "$html")"
assert_contains "$html_text" '<html lang="en">' 'HTML language metadata'
assert_contains "$html_text" '<main id="main-content">' 'HTML main landmark'
assert_contains "$html_text" 'role="doc-toc"' 'HTML table-of-contents landmark'
assert_contains "$html_text" 'alt="A four-step recall loop' 'HTML figure alternative text'

for pdf in "$a4" "$letter"; do
  info="$(pdfinfo "$pdf")"
  structure="$(pdfinfo -struct "$pdf")"
  urls="$(pdfinfo -url "$pdf")"
  destinations="$(pdfinfo -dests "$pdf")"
  extracted="$(pdftotext -layout "$pdf" -)"

  assert_contains "$info" 'Tagged:          yes' "$(basename "$pdf") is tagged"
  assert_contains "$structure" 'Document' "$(basename "$pdf") has a structure tree"
  assert_contains "$structure" 'Table' "$(basename "$pdf") carries a table tag"
  assert_contains "$structure" 'Figure' "$(basename "$pdf") carries a figure tag"
  assert_contains "$structure" 'A four-step recall loop' "$(basename "$pdf") carries figure alternative text"
  assert_contains "$urls" 'https://github.com/BaiGanio/aperio' "$(basename "$pdf") keeps an external link"
  assert_contains "$destinations" 'recall-path' "$(basename "$pdf") keeps internal destinations"
  assert_contains "$extracted" 'A reader can search and select this sentence' "$(basename "$pdf") has searchable text"
done

if [[ -n "${PYPDF_PYTHON:-}" ]]; then
  "$PYPDF_PYTHON" "$proof_dir/inspect-pdf.py" "$a4" "$letter"
fi

assert_contains "$(pdfinfo "$a4")" '(A4)' 'A4 page geometry'
assert_contains "$(pdfinfo "$letter")" 'Page size:       612 x 792 pts (letter)' 'Letter page geometry'

printf '%s\n' 'All structural checks passed. Visual inspection of rendered PNGs remains mandatory.'
