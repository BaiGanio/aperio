// src/capture/capture-cues.js - find the explicit "Remember ..." asks in a user
// message (spec S2.7 §2 behaviour 3-6). Pure, no model call (L-M02, L-M22).
//
// The only trigger: a sentence whose first word is "Remember" (any case) and
// that is not a question. "that" or ":" after the cue is dropped too.

/** Words that end in "." but do not end a sentence ("Dr. Ivanova"). */
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'st', 'jr', 'sr', 'vs', 'etc', 'e.g', 'i.e', 'no', 'mt', 'ave', 'rd']);
const CUE = /^remember\b(?:\s+that\b)?\s*:?\s*/i;
/** The rest names only something said earlier: code cannot know what it is (decision 2). */
const POINTERS = new Set(['', 'this', 'it', 'that', 'that one', 'this one', 'what i said']);
const MIN_WORDS = 3;

/**
 * Split text into sentences. A sentence ends at a newline, or at . ! ? that is
 * followed by white space and is not part of an abbreviation. "1.23" and
 * "ci.example.net" do not split: no white space after the dot.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    let start = 0;
    const end = /[.!?]+(?=\s|$)/g;
    for (let m = end.exec(line); m; m = end.exec(line)) {
      const stop = m.index + m[0].length;
      const lastWord = line.slice(start, m.index).split(/\s+/).at(-1)?.toLowerCase() ?? '';
      if (m[0] === '.' && ABBREVIATIONS.has(lastWord)) continue;
      out.push(line.slice(start, stop));
      start = stop;
    }
    out.push(line.slice(start));
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

const words = (s) => s.split(/\s+/).filter(Boolean);
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * @param {unknown} text  the user's message
 * @returns {({ sentence: string, content: string } | { sentence: string, unresolved: true })[]}
 */
export function findExplicit(text) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const hits = [];
  for (const sentence of splitSentences(text)) {
    if (!CUE.test(sentence) || sentence.endsWith('?')) continue;
    const rest = sentence.replace(CUE, '').trim();
    const bare = rest.replace(/[.!]+$/, '').trim();
    if (POINTERS.has(bare.toLowerCase()) || words(bare).length < MIN_WORDS) {
      hits.push({ sentence, unresolved: true });
    } else {
      hits.push({ sentence, content: capitalize(rest) });
    }
  }
  return hits;
}
