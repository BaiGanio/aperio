#!/usr/bin/env bash
set -euo pipefail

prototype_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$prototype_dir/../../.." && pwd)"
pdf_dir="$repo_dir/output/pdf"

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

for slug in signal-desk night-receiver field-console; do
  html="$prototype_dir/preview-$slug.html"
  html_text="$(tr '\n' ' ' < "$html")"
  assert_contains "$html_text" '<html lang="en"' "$slug HTML language"
  assert_contains "$html_text" '<main id="main-content">' "$slug main landmark"
  assert_contains "$html_text" 'alt="Aperio settings panel' "$slug screenshot alternative text"
  assert_contains "$html_text" 'alt="A four-stage signal path' "$slug diagram alternative text"

  for paper in a4 letter; do
    pdf="$pdf_dir/aperio-manual-$slug-$paper.pdf"
    info="$(pdfinfo "$pdf")"
    structure="$(pdfinfo -struct "$pdf")"
    extracted="$(pdftotext -layout "$pdf" -)"
    assert_contains "$info" 'Tagged:          yes' "$slug $paper PDF is tagged"
    assert_contains "$structure" 'Document' "$slug $paper structure tree"
    assert_contains "$structure" 'Table' "$slug $paper table tag"
    assert_contains "$structure" 'Figure' "$slug $paper figure tag"
    assert_contains "$extracted" 'Store one memory.' "$slug $paper searchable heading start"
    assert_contains "$extracted" 'Recall it later.' "$slug $paper searchable heading continuation"
    assert_contains "$extracted" 'WINDOWS' "$slug $paper platform lane text"
    if grep -Eq 'wrong type \((Strong|Aside)\)' <(pdfinfo -struct "$pdf" 2>&1); then
      printf 'FAIL: %s %s contains a nonstandard Strong or Aside structure role\n' "$slug" "$paper" >&2
      exit 1
    fi
  done
done

assert_contains "$(pdfinfo "$pdf_dir/aperio-manual-signal-desk-a4.pdf")" '(A4)' 'A4 geometry'
assert_contains "$(pdfinfo "$pdf_dir/aperio-manual-signal-desk-letter.pdf")" 'Page size:       612 x 792 pts (letter)' 'Letter geometry'

printf '%s\n' 'All structural checks passed. Full visual inspection of every rendered PNG remains mandatory.'
