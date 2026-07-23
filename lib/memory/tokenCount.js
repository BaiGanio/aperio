// lib/memory/tokenCount.js
// Single token-counting convention for the memory-compaction EPIC (#286, WS0).
// Wraps the same gpt-tokenizer `encode()` already used by lib/context/trim.js
// for real context-assembly token math — not a new estimator. Two other
// char/4 heuristics exist elsewhere (lib/docgraph/chunk.js,
// lib/agent/index.js's getStartupBreakdown) for cheap logging; baseline/eval
// numbers for this EPIC must not drift from what actually gets counted at
// context-assembly time, so they go through this function instead.

import { encode } from "gpt-tokenizer";

export function countTokens(text) {
  return encode(text || "").length;
}
