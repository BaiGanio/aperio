// src/context/recall-block.js - before each turn, code finds the memories that
// matter for this message and frames them as a preview (spec S2.6 §2, 1-9).
//
// S2.7 rev 4 (both, developer 2026-11-12): code adds the best memories to each
// turn (L-M02: a small model often does not call recall), and the model keeps
// its 5 tools. Each row carries its id, so the model can update / forget it
// without a recall first. The block goes into the USER turn, never the system
// prompt (TR9, L-M03).
// Kept from v1: recall every turn in code, "preview, not everything" framing
// (L-M01). Dropped: the English intent regex, the system-prompt injection, the
// 8-row preference preload (L-M18). New: a minimum cosine score, so off-topic
// chat injects nothing (S2.3 carry).
// No module state (AP6): per-session state lives in createRecallSession().

export const RECALL_HEADER = 'Memories that may help (a preview, not everything stored):';
const CLIP_MARK = '…';

/**
 * Token count upper bound: ceil(chars / 3). No tokenizer dependency; the live
 * test checks it against llama-server /tokenize for both models (spec §2.6).
 * @param {string} text
 */
export const estimateTokens = (text) => Math.ceil(String(text).length / 3);

/**
 * Session state for recall. Lives and dies with the chat session.
 * @returns {{ injectedIds: Set<string>, skipWarned: boolean, reset: () => void }}
 */
export function createRecallSession() {
  return {
    injectedIds: new Set(),
    skipWarned: false,
    reset() {
      this.injectedIds.clear();
      this.skipWarned = false;
    },
  };
}

/** @param {{ id: string, title: string, content: string, createdAt: string }} row */
const formatRow = (row) => `- [${String(row.createdAt).slice(0, 10)}] (id ${row.id}) ${row.title}: ${row.content}`;

/**
 * Fit rows best-first into the budget. A row that does not fit is skipped; if
 * the first row alone does not fit, it is clipped and marked with … (§2.5).
 * @param {object[]} rows  best first
 * @param {number} budget  tokens
 */
function fitRows(rows, budget) {
  const maxChars = budget * 3; // ceil(chars / 3) <= budget  <=>  chars <= budget * 3
  let block = RECALL_HEADER;
  const kept = [];
  for (const row of rows) {
    const line = formatRow(row);
    const next = `${block}\n${line}`;
    if (next.length <= maxChars) {
      block = next;
      kept.push(row);
    } else if (kept.length === 0) {
      const room = maxChars - block.length - 1 - CLIP_MARK.length;
      if (room <= 0) return { block: null, kept: [] };
      block = `${block}\n${line.slice(0, room)}${CLIP_MARK}`;
      kept.push(row);
    }
  }
  return kept.length ? { block, kept } : { block: null, kept: [] };
}

/**
 * @param {{ store: { search: Function }, embedder: { sig: string, embedQuery: Function } | null,
 *   text: string, session: ReturnType<typeof createRecallSession>,
 *   config: { RECALL_TOP_K: number, RECALL_TOKEN_BUDGET: number, RECALL_MIN_SCORE: number },
 *   emit?: (e: object) => void, log?: { warn: Function } }} args
 * @returns {Promise<{ block: string | null, rows: { id: string, title: string, score: number }[], tokens: number, ms: number }>}
 */
export async function buildRecallBlock({ store, embedder, text, session, config, emit = () => {}, log = console }) {
  const t0 = performance.now();
  const none = () => ({ block: null, rows: [], tokens: 0, ms: performance.now() - t0 });
  const query = String(text ?? '').trim();
  if (!query) return none();

  const skip = (reason) => {
    emit({ type: 'recall_skipped', reason });
    if (!session.skipWarned) {
      session.skipWarned = true;
      log.warn(`[recall] auto-recall is off for this session: ${reason}`);
    }
    return none();
  };
  if (!embedder) return skip('no embedder (the embedding model is not loaded). Run: npm run model:fetch');

  let vector;
  try {
    vector = await embedder.embedQuery(query);
  } catch (err) {
    return skip(`the embedder failed: ${err.message}`);
  }

  // A store error is rethrown: a broken store is not "no memories".
  const hits = await store.search({ query, queryEmbedding: vector, mode: 'semantic', limit: config.RECALL_TOP_K, sig: embedder.sig });
  const minScore = config.RECALL_MIN_SCORE / 100;
  const fresh = hits.filter((h) => h.score >= minScore && !session.injectedIds.has(h.id));
  const { block, kept } = fitRows(fresh, config.RECALL_TOKEN_BUDGET);
  if (!block) return none();

  for (const row of kept) session.injectedIds.add(row.id);
  const rows = kept.map((h) => ({ id: h.id, title: h.title, score: h.score }));
  return { block, rows, tokens: estimateTokens(block), ms: performance.now() - t0 };
}
