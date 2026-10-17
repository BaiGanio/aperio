import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runPreflight } from "../../../lib/agent/preflight.js";

describe("document retrieval preflight", () => {
  test("runs manifest then one bounded batch for a bare aggregation question", async () => {
    const messages = [{ role: "user", content: "How much did I pay for utilities last month?" }];
    const calls = [];
    const preExecutedTools = new Set();
    const callTool = async (name) => {
      calls.push(["plain", name]);
      if (name === "doc_manifest") return JSON.stringify({ candidates: [{ id: 1, rel_path: "utility.txt", size: 10 }] });
      return "";
    };
    const callToolHooked = async (name) => {
      calls.push(["hooked", name]);
      return JSON.stringify({ coverage: { found: 1, read: 1, skipped: 0, complete: true }, documents: [{ id: 1, status: "read", text: "260.50 BGN" }] });
    };
    await runPreflight({
      messages,
      opts: { noTools: false },
      provider: { name: "llamacpp", model: "test-model" },
      mcpTools: [{ name: "doc_manifest" }, { name: "doc_batch" }],
      skillIndex: [],
      callTool,
      callToolHooked,
      setActiveSearchScopes: () => {},
      extractUserText: message => typeof message.content === "string" ? message.content : "",
      modelIsCapable: () => true,
      preExecutedTools,
    });

    assert.deepEqual(calls, [["plain", "recall"], ["plain", "doc_manifest"], ["hooked", "doc_batch"]]);
    assert.deepEqual([...preExecutedTools], ["doc_manifest", "doc_batch"]);
    assert.deepEqual(messages.filter(m => m.role === "assistant").flatMap(m => m.content).map(c => c.name), ["doc_manifest", "doc_batch"]);
    assert.equal(messages.filter(m => m.role === "user").length, 3);
  });

  test("doc_batch still runs even when the hooked/offload path would mangle a large manifest", async () => {
    // Regression for the bug this fix closes: callToolHooked's result-offload
    // middleware can replace an oversized reply with a truncated preview that
    // fails JSON.parse. The manifest fetch must go through the unhooked
    // `callTool` so doc_batch keeps running regardless of what the hooked
    // path would have done to the same tool's output.
    const preExecutedTools = new Set();
    const callTool = async (name) => {
      if (name === "doc_manifest") return JSON.stringify({ candidates: [{ id: 7, rel_path: "big-corpus.txt", size: 20 }] });
      return "";
    };
    const callToolHooked = async (name) => {
      if (name === "doc_manifest") return "[truncated preview — see artifact abc123]";
      return JSON.stringify({ coverage: { found: 1, read: 1, skipped: 0, complete: true }, documents: [{ id: 7, status: "read", text: "42.00 BGN" }] });
    };
    const messages = [{ role: "user", content: "How much did I pay for utilities last month?" }];
    await runPreflight({
      messages,
      opts: { noTools: false },
      provider: { name: "llamacpp", model: "test-model" },
      mcpTools: [{ name: "doc_manifest" }, { name: "doc_batch" }],
      skillIndex: [],
      callTool,
      callToolHooked,
      setActiveSearchScopes: () => {},
      extractUserText: message => typeof message.content === "string" ? message.content : "",
      modelIsCapable: () => true,
      preExecutedTools,
    });

    assert.deepEqual([...preExecutedTools], ["doc_manifest", "doc_batch"]);
    const batchCall = messages.find(m =>
      m.role === "assistant" && m.content.some(c => c.name === "doc_batch"));
    assert.ok(batchCall, "doc_batch must still be invoked despite the hooked path's truncated manifest");
    assert.deepEqual(batchCall.content[0].input.candidates, [{ id: 7, rel_path: "big-corpus.txt", size: 20 }]);
  });
});
