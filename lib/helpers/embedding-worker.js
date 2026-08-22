import { parentPort } from "node:worker_threads";
import { join } from "node:path";
import { homedir } from "node:os";

let extractorPromise = null;
let running = false;
let stopping = false;
const queue = [];

async function getExtractor() {
  if (extractorPromise) return extractorPromise;
  const loading = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = process.env.TRANSFORMERS_CACHE || join(homedir(), ".cache", "aperio", "transformers");
    return pipeline(
      "feature-extraction",
      "mixedbread-ai/mxbai-embed-large-v1",
      { dtype: "q8" },
    );
  })();
  extractorPromise = loading;
  try {
    return await loading;
  } catch (err) {
    if (extractorPromise === loading) extractorPromise = null;
    throw err;
  }
}

function takeNext() {
  const queryIndex = queue.findIndex((entry) => entry.inputType === "query");
  return queryIndex === -1 ? queue.shift() : queue.splice(queryIndex, 1)[0];
}

async function drain() {
  if (running || stopping || queue.length === 0) return;
  running = true;
  try {
    const request = takeNext();
    try {
      const extractor = await getExtractor();
      const output = await extractor(request.text, { pooling: "cls", normalize: true });
      parentPort.postMessage({ id: request.id, result: Array.from(output.data) });
    } catch (err) {
      parentPort.postMessage({ id: request.id, error: err?.message ?? String(err) });
    }
  } finally {
    running = false;
    // Yield to the worker event loop between embeddings so a shutdown or a
    // higher-priority interactive request can be observed before backfill work.
    if (queue.length && !stopping) setImmediate(() => void drain());
  }
}

parentPort.on("message", async (message) => {
  if (message?.type === "dispose") {
    stopping = true;
    for (const request of queue.splice(0)) {
      parentPort.postMessage({ id: request.id, error: "Embedding worker has been disposed" });
    }
    try {
      const extractor = await extractorPromise;
      await extractor?.dispose?.();
    } catch {}
    parentPort.postMessage({ type: "disposed" });
    parentPort.close();
    return;
  }
  if (message?.type !== "embed" || stopping) return;
  queue.push(message);
  void drain();
});
