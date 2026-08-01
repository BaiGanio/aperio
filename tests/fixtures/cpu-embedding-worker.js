import { parentPort } from "node:worker_threads";

parentPort.on("message", ({ id, type, text, inputType }) => {
  if (type === "dispose") {
    parentPort.postMessage({ type: "disposed" });
    parentPort.close();
    return;
  }
  const until = performance.now() + 250;
  while (performance.now() < until) {
    // Deliberately occupy this worker's JS thread. The main event loop must
    // remain responsive while an embedding backend performs CPU-bound work.
  }
  parentPort.postMessage({ id, result: [text.length, inputType === "query" ? 1 : 0] });
});
