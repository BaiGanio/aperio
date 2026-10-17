import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";

import { completeWithCodex } from "../../../lib/helpers/completion.js";

describe("completeWithCodex", () => {
  test("runs an ephemeral read-only completion and returns the final message", async () => {
    const exec = mock.fn(async () => ({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Background result" } }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ].join("\n"),
      stderr: "",
    }));

    const result = await completeWithCodex(
      [{ role: "user", content: "Summarize this" }],
      { model: "gpt-5.5" },
      { exec, cwd: "/tmp/project" },
    );

    assert.equal(result, "Background result");
    const [command, args, options] = exec.mock.calls[0].arguments;
    assert.equal(command, "codex");
    assert.ok(args.includes("--ephemeral"));
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(options.cwd, "/tmp/project");
  });

  test("surfaces failed and empty Codex turns", async () => {
    await assert.rejects(
      completeWithCodex(
        [{ role: "user", content: "Summarize" }],
        { model: "gpt-5.5" },
        {
          exec: async () => ({
            stdout: JSON.stringify({ type: "turn.failed", error: { message: "auth failed" } }),
          }),
        },
      ),
      /Codex completion failed: auth failed/,
    );

    await assert.rejects(
      completeWithCodex(
        [{ role: "user", content: "Summarize" }],
        { model: "gpt-5.5" },
        { exec: async () => ({ stdout: JSON.stringify({ type: "turn.completed" }) }) },
      ),
      /without a final response/,
    );
  });
});
