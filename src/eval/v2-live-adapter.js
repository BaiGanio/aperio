// src/eval/v2-live-adapter.js - the `v2-live` eval target (spec S2.7 rev 3 §2;
// S2.1 "Shape"). It wires store + embedder + the S2.5 provider + the memory
// tools, and records what each turn sent: { toolsJson, system, userTurn }.
//
// The model decides when to call remember / recall (developer decision
// 2026-11-11); code runs the calls in-process (src/tools/tool-loop.js). The
// user turn is the user's text exactly: code injects nothing.
// `memoryTools: false` is the baseline run: no tools on the wire. Every
// resource opened in start() is closed in stop(), also after a failed start.
// No module state. Not here: the history trim and the full budget function.
// History grows for the life of an eval session only.

import { join } from 'node:path';
import { openStore } from '../store/open-store.js';
import { createEmbedder } from '../embeddings/local-embedder.js';
import { reindex } from '../embeddings/embed-reindex.js';
import { startLlama } from '../providers/llama-launcher.js';
import { createChatProvider } from '../providers/chat-provider.js';
import { MEMORY_TOOLS } from '../tools/memory-tools.js';
import { makeToolCtx, runToolLoop } from '../tools/tool-loop.js';

/** The fixed test system (the real system prompt is a later step). */
export const TEST_SYSTEM = [
  'You are Aperio, a small local assistant that remembers.',
  'Answer briefly and honestly, in plain words.',
  'When the user asks you to remember something, or tells you a fact worth keeping, call remember.',
  'When a question may depend on something the user told you before, call recall first; when you do not know, say so.',
  'To change or forget a memory, find its id with recall or list first.',
].join('\n');

/** Streamed tokens are not kept: a turn returns only the events the runner scores. */
const DROPPED_EVENTS = new Set(['token', 'reasoning_token']);
const FALLBACK_DIMS = 1024;

/**
 * @param {{ config: Record<string, any>, memoryTools?: boolean, system?: string,
 *   deps?: { openStore?: Function, createEmbedder?: Function, startLlama?: Function,
 *            fetch?: typeof fetch, dims?: number, log?: { error: Function, warn: Function, info: Function } } }} opts
 */
export function createV2LiveAdapter({ config, memoryTools = true, system = TEST_SYSTEM, deps = {} }) {
  const tools = memoryTools ? MEMORY_TOOLS : [];
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
      // The memory tools save without a vector and search by words; the turn still runs.
      log.info(`[v2-live] no embedder: ${err.message}`);
    }
    res.embedder = embedder;
    res.store = await open({ path: sandbox.dbPath, dims: embedder?.dims ?? deps.dims ?? FALLBACK_DIMS, log });
    await sandbox.releasePort?.();
    const logPath = sandbox.root ? join(sandbox.root, 'llama-server.log') : undefined;
    res.llama = await launch({ config: { ...config, LLAMACPP_MODEL: model.id, LLAMACPP_PORT: sandbox.port }, deps: { logPath, log } });
    const provider = createChatProvider({ baseURL: res.llama.baseURL, tools, capabilities: res.llama.capabilities, fetch: deps.fetch, log });
    const { store } = res;
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
        history.push({ role: 'user', content: text });
        const ctx = makeToolCtx({ store, embedder, config, log });
        const r = await runToolLoop({ provider, system, history, tools, ctx, emit, log });
        emit({ type: 'turn_complete', status: r.error ? 'error' : r.aborted ? 'aborted' : 'completed' });
        return {
          events, text: r.text, assembled: { toolsJson: provider.toolsJson, system, userTurn: text },
          prefixHash: r.prefixHash, timings: r.timings, usage: r.usage,
        };
      },

      /** Every row, newest first: the live test checks the store after a turn (spec S2.8 §5). */
      async memories() {
        return store.list({ order: 'recent', limit: 200 });
      },

      async reset() {
        history = [];
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

  return { name: memoryTools ? 'v2-live' : 'v2-live-tools-off', start, stop };
}
