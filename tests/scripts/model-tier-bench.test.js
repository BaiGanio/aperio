import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, runWsCase } from "../../scripts/model-tier-bench.js";

test("parseArgs collects repeatable case ids and the environment note", () => {
  assert.deepEqual(parseArgs([
    "--model", "qwen35-9b-q4km", "--case", "recall", "--case", "guardrail",
    "--note", "contaminated", "--allow-download",
  ]), {
    modelId: "qwen35-9b-q4km",
    caseIds: ["recall", "guardrail"],
    environmentNote: "contaminated",
    allowDownload: true,
    validate: false,
  });
});

test("runWsCase waits for the correlated turn_complete, not stream_end", async () => {
  class FakeSocket extends EventEmitter {
    send(raw) {
      const request = JSON.parse(raw);
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ type: "stream_end", text: "intermediate" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "tool_start", name: "recall" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "turn_complete", turnId: "other", status: "completed" })));
        this.emit("message", Buffer.from(JSON.stringify({ type: "turn_complete", turnId: request.turnId, status: "completed" })));
      });
    }
  }
  const result = await runWsCase(new FakeSocket(), { id: "recall", prompt: "Recall it", timeoutMs: 1_000 });
  assert.deepEqual(result.events.map(event => event.type), ["stream_end", "tool_start", "turn_complete", "turn_complete"]);
  assert.equal(result.events.at(-1).turnId, "recall");
});
