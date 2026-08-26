// Keep weight-file selection aligned with llama.cpp's download inventory.
// These are case-sensitive substring checks in common/download.cpp: an
// auxiliary projector, draft model, or quantization matrix is not a model
// weights candidate even when its package-specific prefix comes first.
export const GGUF_AUXILIARY_FILE_PATTERN = /mmproj|mtp-|imatrix/;

export function isGgufWeightsFile(name) {
  return /\.gguf$/i.test(name) && !GGUF_AUXILIARY_FILE_PATTERN.test(name);
}
