// src/boot/start-server.js - open everything the app needs, in order, and close
// it in reverse (spec S2.14 §2.5; v1 shutdown order, archive/v1-final).
//
// Order: embedder → store (it needs the embedder's dims) → llama → HTTP + WS.
// A failed start closes what it opened, then rethrows. stop() is safe twice.
// Config comes in as an argument (AP1); `deps` are test seams.

import { openStore } from '../store/open-store.js';
import { createEmbedder } from '../embeddings/local-embedder.js';
import { startLlama } from '../providers/llama-launcher.js';
import { createChatProvider } from '../providers/chat-provider.js';
import { MEMORY_TOOLS } from '../tools/memory-tools.js';
import { buildSystem } from '../context/system-prompt.js';
import { createTurnRunner } from '../chat/turn-runner.js';
import { createServer } from '../server/app-server.js';

const FALLBACK_DIMS = 1024;

/**
 * @param {{ config: Record<string, any>, deps?: { openStore?: Function, createEmbedder?: Function,
 *   startLlama?: Function, fetch?: typeof fetch, publicDir?: string,
 *   log?: { error: Function, warn: Function, info: Function } } }} opts
 * @returns {Promise<{ port: number, stop(): Promise<void> }>}
 */
export async function startServer({ config, deps = {} }) {
  const log = deps.log ?? console;
  /** Closers, pushed as each part opens; run in reverse. */
  const closers = [];
  let stopping = null;

  const stop = () => {
    stopping ??= (async () => {
      const errors = [];
      for (const close of closers.reverse()) {
        try {
          await close();
        } catch (err) {
          log.error(`[boot] close failed: ${err.message}`);
          errors.push(err);
        }
      }
      if (errors.length) throw new AggregateError(errors, `stop: ${errors.map((e) => e.message).join('; ')}`);
    })();
    return stopping;
  };

  try {
    let embedder = null;
    try {
      embedder = await (deps.createEmbedder ?? createEmbedder)({
        model: config.EMBEDDING_MODEL, cacheDir: config.TRANSFORMERS_CACHE, threads: config.EMBEDDING_THREADS, log,
      });
      closers.push(() => embedder.close?.());
    } catch (err) {
      // Same as the eval: tools save without a vector and search by words; chat still runs.
      log.warn(`[boot] no embedder: ${err.message}`);
    }

    const store = await (deps.openStore ?? openStore)({ path: config.SQLITE_PATH, dims: embedder?.dims ?? FALLBACK_DIMS, log });
    closers.push(() => store.close());

    const llama = await (deps.startLlama ?? startLlama)({ config, deps: { log } });
    closers.push(() => llama.stop());

    const provider = createChatProvider({ baseURL: llama.baseURL, tools: MEMORY_TOOLS, capabilities: llama.capabilities, fetch: deps.fetch, log });
    const runner = createTurnRunner({
      store, embedder, provider, system: buildSystem(), tools: MEMORY_TOOLS, config,
      nCtx: llama.servedCtx ?? config.LLAMACPP_SERVE_CTX, log,
    });

    const server = createServer({ config, runner, log, publicDir: deps.publicDir });
    closers.push(() => server.close());
    const { port } = await server.listen();
    log.info(`[boot] Aperio is listening on http://${config.HOST}:${port}`);
    return { port, stop };
  } catch (err) {
    await stop().catch((closeErr) => log.error(`[boot] cleanup after a failed start: ${closeErr.message}`));
    throw err;
  }
}
