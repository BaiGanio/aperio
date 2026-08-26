#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
topics="$root/manual/topics"
publish="$root/docs/manual"

entries=(
  "getting-started:aperio-getting-started-a4.pdf"
  "everyday-memory:aperio-everyday-memory-a4.pdf"
  "files-tools:aperio-files-tools-a4.pdf"
  "connecting:aperio-connecting-a4.pdf"
  "setup-configuration:aperio-setup-configuration-a4.pdf"
  "privacy-upkeep:aperio-privacy-upkeep-a4.pdf"
)

mkdir -p "$publish"

for entry in "${entries[@]}"; do
  topic="${entry%%:*}"
  filename="${entry#*:}"
  "$topics/$topic/build.sh"
  cp "$topics/$topic/artifacts/$filename" "$publish/$filename"
done

printf 'Published %d English A4 manuals to %s\n' "${#entries[@]}" "$publish"
