import { Worker } from "node:worker_threads";

const DEFAULT_WORKER_URL = new URL("./embedding-worker.js", import.meta.url);

/**
 * RPC client for the local embedding worker. Keeping this transport separate
 * makes the event-loop isolation testable without loading the real ONNX model.
 */
export function createEmbeddingWorkerClient({ workerUrl = DEFAULT_WORKER_URL, WorkerClass = Worker } = {}) {
  let worker = null;
  let disposed = false;
  let nextId = 1;
  let disposeResolve = null;
  const pending = new Map();

  function rejectPending(err) {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  }

  function ensureWorker() {
    if (disposed) throw new Error("Embedding worker has been disposed");
    if (worker) return worker;

    const instance = new WorkerClass(workerUrl, { type: "module" });
    instance.unref?.();
    instance.on("message", (message) => {
      if (message?.type === "disposed") {
        instance.unref?.();
        disposeResolve?.();
        disposeResolve = null;
        return;
      }
      if (message?.id == null) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
      if (pending.size === 0) instance.unref?.();
    });
    instance.on("error", (err) => {
      rejectPending(err);
      if (worker === instance) worker = null;
      disposeResolve?.();
      disposeResolve = null;
    });
    instance.on("exit", (code) => {
      if (worker === instance) worker = null;
      if (!disposed) {
        rejectPending(new Error(`Embedding worker exited with code ${code}`));
      }
      disposeResolve?.();
      disposeResolve = null;
    });
    worker = instance;
    return instance;
  }

  function embed(text, inputType = "document") {
    if (disposed) return Promise.reject(new Error("Embedding worker has been disposed"));
    const instance = ensureWorker();
    const id = nextId++;
    instance.ref?.();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        instance.postMessage({ type: "embed", id, text, inputType });
      } catch (err) {
        pending.delete(id);
        if (pending.size === 0) instance.unref?.();
        reject(err);
      }
    });
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    const instance = worker;
    worker = null;
    rejectPending(new Error("Embedding worker has been disposed"));
    if (!instance) return;
    instance.ref?.();
    await new Promise((resolve) => {
      disposeResolve = resolve;
      try {
        instance.postMessage({ type: "dispose" });
      } catch {
        disposeResolve = null;
        instance.unref?.();
        resolve();
      }
    });
  }

  return {
    embed,
    dispose,
    pendingSize: () => pending.size,
  };
}
