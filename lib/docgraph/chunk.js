// lib/docgraph/chunk.js
// Slice section text into embedding-sized, overlapping chunks. Token counts
// are estimated (no tokenizer dependency) at ~4 chars/token — good enough for
// sizing; the embedding model truncates anything over its real limit.
//
// Defaults: ~512 tokens / chunk, ~64 tokens overlap (per the brief). Tunable
// via DOCGRAPH_CHUNK_TOKENS / DOCGRAPH_CHUNK_OVERLAP after Phase 2 measurement.

const CHARS_PER_TOKEN = 4;
const CHUNK_TOKENS  = Number(process.env.DOCGRAPH_CHUNK_TOKENS   || 512);
const OVERLAP_TOKENS = Number(process.env.DOCGRAPH_CHUNK_OVERLAP || 64);

const CHUNK_CHARS   = CHUNK_TOKENS  * CHARS_PER_TOKEN;
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN;

export const estimateTokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

// Find a "nice" break point (paragraph, then sentence, then whitespace) at or
// before `hardEnd`, but no earlier than `minEnd` so we don't produce slivers.
function softBreak(text, minEnd, hardEnd) {
  const window = text.slice(minEnd, hardEnd);
  const candidates = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf(' ')];
  for (const rel of candidates) {
    if (rel > 0) return minEnd + rel + 1;
  }
  return hardEnd;
}

/**
 * @param {string} text  Section body text.
 * @returns {Array<{ text, token_count }>} ordered chunks. Empty/whitespace-only
 *          input yields no chunks.
 */
export function chunkText(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= CHUNK_CHARS) {
    return [{ text: trimmed, token_count: estimateTokens(trimmed) }];
  }

  const chunks = [];
  let start = 0;
  while (start < trimmed.length) {
    const hardEnd = Math.min(start + CHUNK_CHARS, trimmed.length);
    const end = hardEnd === trimmed.length
      ? hardEnd
      : softBreak(trimmed, start + Math.floor(CHUNK_CHARS / 2), hardEnd);
    const slice = trimmed.slice(start, end).trim();
    if (slice) chunks.push({ text: slice, token_count: estimateTokens(slice) });
    if (end >= trimmed.length) break;
    start = Math.max(end - OVERLAP_CHARS, start + 1);
  }
  return chunks;
}
