// src/capture/capture-turn.js - after a turn, code saves what the user
// explicitly asked to remember (spec S2.7 §2). Code does the memory work (L-M02).
//
// No model call (L-M22: a side prompt would wipe the one llama-server slot).
// Writes only to `memories`; the model sees a saved row only through recall in
// a later turn. Events and logs hold counts and ids, never memory text.
// No module state (AP6): the warn-once flag lives in createCaptureSession().

import { findExplicit } from './capture-cues.js';
import { hasSecret } from './secret-scan.js';

const TITLE_WORDS = 8;

/** Session state for capture. Lives and dies with the chat session. */
export function createCaptureSession() {
  return {
    embedWarned: false,
    reset() {
      this.embedWarned = false;
    },
  };
}

const titleOf = (content) => content.split(/\s+/).filter(Boolean).slice(0, TITLE_WORDS).join(' ');

/**
 * @param {{ text: string, store: { insert: Function, search: Function },
 *   embedder: { sig: string, embed: Function } | null,
 *   session: ReturnType<typeof createCaptureSession>,
 *   config: { CAPTURE_MODE: string, CAPTURE_DUP_SCORE: number, CAPTURE_MAX_PER_TURN: number },
 *   emit?: (e: object) => void, log?: { error: Function, warn: Function } }} args
 * @returns {Promise<{ saved: number, duplicate: number, unresolved: number, secretRefused: number, ids: string[] }>}
 */
export async function captureTurn({ text, store, embedder, session, config, emit = () => {}, log = console }) {
  const result = { saved: 0, duplicate: 0, unresolved: 0, secretRefused: 0, ids: [] };
  if (config.CAPTURE_MODE === 'off') return result;

  const warnOnce = (reason) => {
    if (session.embedWarned) return;
    session.embedWarned = true;
    log.warn(`[capture] saving without vectors for this session (the S2.4 reindex fills them later): ${reason}`);
  };

  let attempts = 0;
  for (const hit of findExplicit(text)) {
    // The secret check comes first: "Remember: token: abc" is short, but it is a secret.
    if (hasSecret(hit.sentence)) {
      result.secretRefused++;
      emit({ type: 'capture_secret_refused' });
      continue;
    }
    if (hit.unresolved) {
      result.unresolved++;
      emit({ type: 'capture_unresolved' });
      continue;
    }
    if (attempts >= config.CAPTURE_MAX_PER_TURN) break;
    attempts++;

    let vector = null;
    if (!embedder) warnOnce('no embedder');
    else {
      try {
        vector = await embedder.embed(hit.content);
      } catch (err) {
        warnOnce(`the embedder failed: ${err.message}`);
      }
    }

    try {
      if (vector) {
        const [top] = await store.search({ query: hit.content, queryEmbedding: vector, mode: 'semantic', limit: 1, sig: embedder.sig });
        if (top && top.score * 100 >= config.CAPTURE_DUP_SCORE) {
          result.duplicate++;
          emit({ type: 'capture_duplicate', id: top.id });
          continue;
        }
      }
      const row = await store.insert(
        { type: 'fact', title: titleOf(hit.content), content: hit.content, source: 'capture' },
        vector, vector ? embedder.sig : undefined,
      );
      result.saved++;
      result.ids.push(row.id);
    } catch (err) {
      // AP5: logged, reported, and the chat goes on. The message names no memory text.
      log.error(`[capture] store error, memory not saved: ${err.message}`);
      emit({ type: 'capture_failed' });
    }
  }

  emit({ type: 'capture_done', ...result, ids: [...result.ids] });
  return result;
}
