// lib/codegraph/doc-comment.js
// Leading doc-comment extraction, shared by extract-ts.js and extract-generic.js.
//
// A doc comment sits immediately above its symbol, so only the text just before
// the symbol can ever contribute. Both extractors used to slice the ENTIRE file
// prefix per symbol (`source.slice(0, node.startIndex)`) and run $-anchored
// regexes over it. That is quadratic twice over — once in the copying, once in
// the backtracking — and it is not a theoretical cost: on a 400KB source file a
// single lookup measured ~3.4s, so one large file stalled the whole indexing
// pass. Indexing runs on the server's main thread, so the stall froze the event
// loop and every HTTP request with it (the Settings panel hung on "Loading…").
//
// Everything here is linear and bounded by DOC_WINDOW_CHARS.

// Far larger than any real doc comment. A block comment longer than this loses
// its text (the window cuts off its `/**`), which is the intended trade.
export const DOC_WINDOW_CHARS = 8192;

// The bounded slice of `source` immediately before `startIndex`.
export function docWindow(source, startIndex) {
  return source.slice(Math.max(0, startIndex - DOC_WINDOW_CHARS), startIndex);
}

// The `/** … */` block ending immediately above the symbol, or null.
//
// The regex this replaces (`/\/\*\*([\s\S]*?)\*\/\s*$/`) was lazy and unanchored
// at the start, so for two adjacent blocks it matched from the FIRST `/**` all
// the way to the LAST `*/` — capturing the first comment, the code between it
// and the second comment, and the second comment's opening. Anchoring on the
// closing `*/` and rejecting an intervening one fixes that as well.
export function leadingBlockDoc(before) {
  const trimmed = before.trimEnd();
  if (!trimmed.endsWith('*/')) return null;
  const body = trimmed.slice(0, -2);
  const open = body.lastIndexOf('/**');
  if (open === -1 || body.includes('*/', open)) return null;
  return body.slice(open + 3).replace(/^\s*\*\s?/gm, '').trim();
}

// The run of line comments ending immediately above the symbol, or null. Walked
// backwards one line at a time; blank lines inside the run are skipped, which is
// what the old `\s*` inside the repeated group did.
//
// `isComment` tests an already-trimmed line; `strip` removes the marker from it.
export function leadingLineDoc(before, isComment, strip) {
  const lines = before.split('\n');
  // The partial line the symbol itself starts on. Anything but indentation there
  // means the comment run does not lead THIS symbol (`// doc\nfoo(); bar()`).
  if (lines.pop().trim() !== '') return null;
  const picked = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (!isComment(line)) break;
    picked.unshift(line.replace(strip, ''));
  }
  return picked.length ? picked.join('\n').trim() : null;
}
