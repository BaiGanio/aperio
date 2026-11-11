// src/eval/v2-live-adapter.js - the `v2-live` eval target (spec S2.6 §2
// "Interface"; S2.1 "Shape"). It wires store + embedder + the S2.5 provider +
// auto-recall, and records what each turn sent: { toolsJson, system, userTurn }.
//
// `recall: false` is the baseline run (spec §4 decision 1): same wiring, the
// user turn is the text exactly. `capture: true` runs the S2.7 explicit
// capture on the user text after turn_complete (default off). Every resource opened in start() is closed in
// stop(), also after a failed start. No module state.
// Not here: the history trim and the full budget function (decision 3), tools
// that run (S2.8). History grows for the life of an eval session only.

import { join } from 'node:path';
import { openStore } from '../store/open-store.js';
import { createEmbedder } from '../embeddings/local-embedder.js';
import { reindex } from '../embeddings/embed-reindex.js';
import { startLlama } from '../providers/llama-launcher.js';
import { createChatProvider } from '../providers/chat-provider.js';
import { buildRecallBlock, createRecallSession } from '../context/recall-block.js';
import { assembleUserTurn } from '../context/assemble-turn.js';
import { captureTurn, createCaptureSession } from '../capture/capture-turn.js';

/** The fixed 3-line test system of S2.6 (the real system prompt is a later step). */
export const TEST_SYSTEM = [
  'You are Aperio, a small local assistant that remembers.',
  'Answer briefly and honestly, in plain words.',
  'When the user message holds memories that help, use them; when you do not know, say so.',
].join('\n');

/** Streamed tokens are not kept: a turn returns only the events the runner scores. */
const DROPPED_EVENTS = new Set(['token', 'reasoning_token']);
const FALLBACK_DIMS = 1024;

/**
 * @param {{ config: Record<string, any>, recall?: boolean, capture?: boolean, system?: string,
 *   tools?: { name: string, description?: string, parameters?: object }[],
 *   deps?: { openStore?: Function, createEmbedder?: Function, startLlama?: Function,
 *            fetch?: typeof fetch, dims?: number, log?: { error: Function, warn: Function, info: Function } } }} opts
 */
export function createV2LiveAdapter({ config, recall = true, capture = false, system = TEST_SYSTEM, tools = [], deps = {} }) {
  const log = deps.log ?? console;
  const open = deps.openStore ?? openStore;
  const makeEmbedder = deps.createEmbedder ?? createEmbedder;
  const launch = deps.startLlama ?? startLlama;
  /** @type {{ store: any, embedder: any, llama: any }} */
  let res = { store: null, embedder: null, llama: null };

  async function start({ sandbox, model }) {
    let embedder = null;
    try {
      embedder = await makeEmbedder({ model: config.EMBEDDING_MODEL, cacheDir: config.TRANSFORMERS_CACHE, threads: config.EMBEDDING_THREADS, log });
    } catch (err) {
      // Recall reports it per turn (recall_skipped + one warn); the turn still runs.
      log.info(`[v2-live] no embedder: ${err.message}`);
    }
    res.embedder = embedder;
    res.store = await open({ path: sandbox.dbPath, dims: embedder?.dims ?? deps.dims ?? FALLBACK_DIMS, log });
    await sandbox.releasePort?.();
    const logPath = sandbox.root ? join(sandbox.root, 'llama-server.log') : undefined;
    res.llama = await launch({ config: { ...config, LLAMACPP_MODEL: model.id, LLAMACPP_PORT: sandbox.port }, deps: { logPath, log } });
    const provider = createChatProvider({ baseURL: res.llama.baseURL, tools, capabilities: res.llama.capabilities, fetch: deps.fetch, log });
    const { store } = res;
    const recallSession = createRecallSession();
    const captureSession = createCaptureSession();
    let history = [];

    return {
      async seedMemories(rows) {
        for (const row of rows) await store.insert(row);
        if (embedder) await reindex(store, embedder, { log });
      },

      async recall(query, k, { mode = 'auto' } = {}) {
        const queryEmbedding = embedder ? await embedder.embedQuery(query) : null;
        const hits = await store.search({ query, queryEmbedding, mode, limit: k, sig: embedder?.sig });
        return { titles: hits.map((h) => h.title) };
      },

      async turn(text) {
        const events = [];
        const emit = (e) => { if (!DROPPED_EVENTS.has(e.type)) events.push(e); };
        let rec = { block: null, rows: [], tokens: 0, ms: 0 };
        if (recall) {
          rec = await buildRecallBlock({ store, embedder, text, session: recallSession, config, emit, log });
          if (rec.block) emit({ type: 'recall_injected', rows: rec.rows, tokens: rec.tokens, ms: rec.ms });
        }
        const userTurn = assembleUserTurn({ recallBlock: rec.block, text });
        history.push({ role: 'user', content: userTurn });
        const r = await provider.streamChat({ system, messages: [...history], emit });
        history.push({ role: 'assistant', content: r.text });
        emit({ type: 'turn_complete', status: r.error ? 'error' : r.aborted ? 'aborted' : 'completed' });
        // The user's own text only: never the recall block, never the reply.
        if (capture) await captureTurn({ text, store, embedder, session: captureSession, config, emit, log });
        return {
          events, text: r.text, assembled: { toolsJson: provider.toolsJson, system, userTurn },
          prefixHash: r.prefixHash, recall: rec, timings: r.timings, usage: r.usage,
        };
      },

      async reset() {
        history = [];
        recallSession.reset();
        captureSession.reset();
      },
    };
  }

  async function stop() {
    const { store, embedder, llama } = res;
    res = { store: null, embedder: null, llama: null };
    const errors = [];
    for (const close of [() => llama?.stop(), () => embedder?.close?.(), () => store?.close()]) {
      try {
        await close();
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length) throw new AggregateError(errors, `v2-live stop: ${errors.map((e) => e.message).join('; ')}`);
  }

  return { name: recall ? 'v2-live' : 'v2-live-recall-off', start, stop };
}
