// Keep weight-file selection aligned with llama.cpp's download inventory.
// These are case-sensitive substring checks in common/download.cpp: an
// auxiliary projector, draft model, or quantization matrix is not a model
// weights candidate even when its package-specific prefix comes first.
export const GGUF_AUXILIARY_FILE_PATTERN = /mmproj|mtp-|imatrix/;

export function isGgufWeightsFile(name) {
  return /\.gguf$/i.test(name) && !GGUF_AUXILIARY_FILE_PATTERN.test(name);
}

// The detection half of the same exclusion: a vision projector file, matched
// by filename rather than filtered against. GGUF_AUXILIARY_FILE_PATTERN above
// excludes it (plus mtp-/imatrix) from weight-file selection; this is that
// same "mmproj" fact read the other direction, for model-capabilities.js.
export const MMPROJ_FILE_PATTERN = /^mmproj.*\.gguf$/i;

export function isMmprojFile(name) {
  return MMPROJ_FILE_PATTERN.test(name);
}
