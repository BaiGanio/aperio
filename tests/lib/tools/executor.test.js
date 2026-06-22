// tests/lib/tools/executor.test.js
import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import logger from "../../../lib/helpers/logger.js";
import { extractTextToolCall, ToolExecutor } from "../../../lib/tools/executor.js";

// =============================================================================
// extractTextToolCall
//
// Extraction is brace-balanced (string- and escape-aware) and strips JS-style
// comments before JSON.parse, so "name" can appear in any position — including
// the natural name-first { "name": …, "parameters": { … } } shape that local
// models emit — and a nested params object no longer truncates the match.
// =============================================================================

describe("extractTextToolCall", () => {

  test("returns null for empty text", () => {
    assert.equal(extractTextToolCall("", []), null);
  });

  test("returns null for text with no JSON", () => {
    assert.equal(extractTextToolCall("just some plain text", []), null);
  });

  test("returns null for text with no name field", () => {
    const text = '```json\n{"key": "value"}\n```';
    assert.equal(extractTextToolCall(text, []), null);
  });

  test("parses fenced JSON block with tool call", () => {
    const text = 'prefix\n```json\n{"input": {"arg1": "val1"}, "name": "test_tool"}\n```\nsome trailing';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "test_tool");
    assert.deepEqual(result.input, { arg1: "val1" });
    assert.ok(result.trailing.includes("some trailing"));
  });

  test("parses bare JSON (no fence) with tool call", () => {
    const text = '{"input": {"path": "x"}, "name": "bare_tool"} more text';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "bare_tool");
    assert.deepEqual(result.input, { path: "x" });
    assert.equal(result.trailing, "more text");
  });

  test("returns null for invalid JSON", () => {
    const text = '{"name": "t", "input": {broken}}';
    assert.equal(extractTextToolCall(text, []), null);
  });

  test("uses parameters key for params", () => {
    const text = '{"parameters": {"k": "v"}, "name": "a"}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.deepEqual(result.input, { k: "v" });
    assert.equal(result.name, "a");
  });

  test("uses input key as fallback for params", () => {
    const text = '{"input": {"x": 1}, "name": "a"}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.deepEqual(result.input, { x: 1 });
    assert.equal(result.name, "a");
  });

  test("uses arguments key as fallback for params", () => {
    const text = '{"arguments": {"a": "b"}, "name": "a"}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.deepEqual(result.input, { a: "b" });
    assert.equal(result.name, "a");
  });

  test("strips null, empty string, None, and null-string values from params", () => {
    // "parameters" BEFORE "name" so the regex captures the full outer object.
    const text = '{"parameters": {"a": "ok", "b": null, "c": "", "d": "None", "e": "null"}, "name": "cleaner"}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.deepEqual(result.input, { a: "ok" });
  });

  test("strips Response:/Result:/Answer:/Output: prefix from trailing text", () => {
    const text = '{"arg": "v", "name": "t"} - Response: the answer is here';
    const result = extractTextToolCall(text, []);
    assert.equal(result.trailing, "the answer is here");
  });

  test("strips various prefix formats from trailing text", () => {
    const testCases = [
      ['{"arg": 1, "name": "t"} - Result: done', "done"],
      ['{"arg": 1, "name": "t"} \u2014 Answer: yes', "yes"],
      ['{"arg": 1, "name": "t"} -- Output: hello', "hello"],
    ];
    for (const [text, expected] of testCases) {
      const result = extractTextToolCall(text, []);
      assert.equal(result.trailing, expected);
    }
  });

  test("returns empty trailing for bare tool call with no suffix", () => {
    const text = '{"arg": 1, "name": "t"}';
    const result = extractTextToolCall(text, []);
    assert.equal(result.trailing, "");
  });

  test("prefers first JSON with a name field when multiple exist", () => {
    const text = '{"value": 1, "name": "first"} ignored {"value": 2, "name": "second"}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "first");
  });

  test("parses name-first shape with nested params object", () => {
    // The shape local models actually emit — would truncate under the old regex.
    const text = '```json\n{"name": "list_github_issues", "parameters": {"only_untriaged": true, "repo": "owner/repo"}}\n```';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "list_github_issues");
    assert.deepEqual(result.input, { only_untriaged: true, repo: "owner/repo" });
  });

  test("parses tool call JSON containing // and /* */ comments", () => {
    const text = [
      '```json',
      '{',
      '    "name": "record_issue_triage",',
      '    "parameters": {',
      '        "repo": "owner/repo",',
      '        "priority": 3, // default',
      '        "run_id": 1234 /* block */',
      '    }',
      '}',
      '```',
    ].join("\n");
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "record_issue_triage");
    assert.deepEqual(result.input, { repo: "owner/repo", priority: 3, run_id: 1234 });
  });

  test("does not treat braces inside string values as object boundaries", () => {
    const text = '{"name": "t", "parameters": {"msg": "a } b { c"}}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "t");
    assert.deepEqual(result.input, { msg: "a } b { c" });
  });

  test("skips a leading unbalanced brace and finds the real object", () => {
    const text = 'note: use {curly} then\n{"name": "t", "parameters": {"x": 1}}';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "t");
    assert.deepEqual(result.input, { x: 1 });
  });
});

// =============================================================================
// ToolExecutor
// =============================================================================

describe("ToolExecutor", () => {
  let callTool, emitter, messages, executor;

  const mockEmitter = () => ({ send: mock.fn() });

  beforeEach(() => {
    callTool = mock.fn(async (name, input) => `result:${name}`);
    emitter = mockEmitter();
    messages = [];
    executor = new ToolExecutor(callTool, emitter, messages);
  });

  // ── constructor ───────────────────────────────────────────────────────────────

  describe("constructor", () => {
    test("stores callTool, emitter, messages references", () => {
      assert.equal(executor.callTool, callTool);
      assert.equal(executor.emitter, emitter);
      assert.equal(executor.messages, messages);
    });

    test("initializes streamUsage with zero tokens", () => {
      assert.deepEqual(executor.streamUsage, {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: 0,
      });
    });
  });

  // ── parseArgs ─────────────────────────────────────────────────────────────────

  describe("parseArgs", () => {
    let errorSpy;

    beforeEach(() => {
      errorSpy = mock.method(logger, "error", () => {});
    });

    afterEach(() => {
      errorSpy.mock.restore();
    });

    test("returns {} for empty string", () => {
      assert.deepEqual(executor.parseArgs(""), {});
    });

    test("returns {} for null", () => {
      assert.deepEqual(executor.parseArgs(null), {});
    });

    test("returns {} for whitespace-only string", () => {
      assert.deepEqual(executor.parseArgs("  \n  "), {});
    });

    test("parses valid JSON string", () => {
      const result = executor.parseArgs('{"path":"/tmp/test","content":"hello"}');
      assert.deepEqual(result, { path: "/tmp/test", content: "hello" });
    });

    test("returns __parse_error__ for invalid JSON in destructive tools", () => {
      const result = executor.parseArgs('{"path": broken}', "write_file");
      assert.ok(result.__parse_error__);
      assert.ok(result.__parse_error__.includes("write_file"));
      assert.ok(result.__parse_error__.includes("JSON.parse error"));
      assert.strictEqual(errorSpy.mock.calls.length, 1);
    });

    test("does NOT attempt regex repair for destructive tools", () => {
      const result = executor.parseArgs('{"key""val"}', "write_file");
      assert.ok(result.__parse_error__);
    });

    test("all destructive tools are covered", () => {
      const destructiveCases = [
        "write_file", "edit_file", "append_file", "generate_xlsx",
        "run_node_script", "run_python_script", "run_shell",
        "wiki_write", "remember", "update_memory", "forget",
        "backfill_embeddings", "deduplicate_memories", "delete_file",
      ];
      for (const toolName of destructiveCases) {
        const result = executor.parseArgs('{"x" broken}', toolName);
        assert.ok(result.__parse_error__,
          `Expected __parse_error__ for destructive tool: ${toolName}`);
      }
    });

    test("attempts regex repair for non-destructive tools", () => {
      const warnSpy = mock.method(logger, "warn", () => {});
      // Missing colon: {"key""val"} -> repaired to {"key":"val"}
      const result = executor.parseArgs('{"key""val"}', "read_file");
      assert.ok(!result.__parse_error__);
      assert.deepEqual(result, { key: "val" });
      assert.strictEqual(warnSpy.mock.calls.length, 1);
      warnSpy.mock.restore();
    });

    test("repairs missing colon between key and value", () => {
      const warnSpy = mock.method(logger, "warn", () => {});
      const result = executor.parseArgs('{"path""/tmp/x"}', "read_file");
      assert.deepEqual(result, { path: "/tmp/x" });
      warnSpy.mock.restore();
    });

    test("repairs unclosed key quotes", () => {
      const warnSpy = mock.method(logger, "warn", () => {});
      const result = executor.parseArgs('{"path: "/tmp/x"}', "read_file");
      assert.deepEqual(result, { path: "/tmp/x" });
      warnSpy.mock.restore();
    });

    test("repairs missing closing quote at end of value", () => {
      const warnSpy = mock.method(logger, "warn", () => {});
      // Input: {"path": "/tmp/x}  — the value "/tmp/x has no closing quote.
      // The repair regex adds one:  x}  ->  x"}
      const result = executor.parseArgs('{"path": "/tmp/x}', "read_file");
      assert.deepEqual(result, { path: "/tmp/x" });
      assert.strictEqual(warnSpy.mock.calls.length, 1);
      warnSpy.mock.restore();
    });

    test("returns __parse_error__ when regex repair fails for non-destructive tools", () => {
      const warnSpy = mock.method(logger, "warn", () => {});
      const result = executor.parseArgs("{[[[broken", "read_file");
      assert.ok(result.__parse_error__);
      assert.ok(result.__parse_error__.includes("not valid JSON"));
      // Called once from the outer catch fallthrough
      assert.strictEqual(errorSpy.mock.calls.length, 1);
      warnSpy.mock.restore();
    });
  });

  // ── executeToolCalls ──────────────────────────────────────────────────────────

  describe("executeToolCalls", () => {
    test("returns false for empty array", async () => {
      const result = await executor.executeToolCalls([]);
      assert.equal(result, false);
    });

    test("returns false for null", async () => {
      const result = await executor.executeToolCalls(null);
      assert.equal(result, false);
    });

    test("returns false for undefined", async () => {
      const result = await executor.executeToolCalls(undefined);
      assert.equal(result, false);
    });

    test("creates assistant message with tool_use content", async () => {
      const tc = [{ id: "tc1", name: "read_file", args: '{"path":"x.txt"}' }];
      await executor.executeToolCalls(tc);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, "assistant");
      assert.equal(messages[0].content.length, 1);
      assert.equal(messages[0].content[0].type, "tool_use");
      assert.equal(messages[0].content[0].name, "read_file");
      assert.equal(messages[0].content[0].id, "tc1");
    });

    test("emits tool event for each call", async () => {
      const tc = [
        { id: "t1", name: "read_file", args: '{"p":"a"}' },
        { id: "t2", name: "list_dir", args: '{"p":"b"}' },
      ];
      await executor.executeToolCalls(tc);
      assert.equal(emitter.send.mock.calls.length, 2);
      assert.equal(emitter.send.mock.calls[0].arguments[0].type, "tool");
      assert.equal(emitter.send.mock.calls[0].arguments[0].name, "read_file");
      assert.equal(emitter.send.mock.calls[1].arguments[0].name, "list_dir");
    });

    test("calls callTool for each tool call", async () => {
      const tc = [{ id: "t1", name: "read_file", args: '{"path":"a.txt"}' }];
      await executor.executeToolCalls(tc);
      assert.equal(callTool.mock.calls.length, 1);
      assert.equal(callTool.mock.calls[0].arguments[0], "read_file");
      assert.deepEqual(callTool.mock.calls[0].arguments[1], { path: "a.txt" });
    });

    test("pushes tool result messages", async () => {
      const tc = [{ id: "tc1", name: "read_file", args: '{"path":"x.txt"}' }];
      await executor.executeToolCalls(tc);
      assert.equal(messages.length, 2);
      assert.equal(messages[1].role, "tool");
      assert.equal(messages[1].content.length, 1);
      assert.equal(messages[1].content[0].type, "tool_result");
      assert.equal(messages[1].content[0].tool_use_id, "tc1");
    });

    test("includes validated cleanText in assistant message", async () => {
      const tc = [{ id: "t1", name: "read_file", args: '{"path":"x"}' }];
      await executor.executeToolCalls(tc, "some preamble text");
      assert.equal(messages[0].content.length, 2);
      assert.equal(messages[0].content[0].type, "text");
      assert.equal(messages[0].content[0].text, "some preamble text");
      assert.equal(messages[0].content[1].type, "tool_use");
    });

    test("handles reasoningContent", async () => {
      const tc = [{ id: "t1", name: "read_file", args: "{}" }];
      await executor.executeToolCalls(tc, "", "model reasoning steps");
      assert.equal(messages[0].reasoning_content, "model reasoning steps");
    });
  });

  // ── executeInterceptedToolCall ────────────────────────────────────────────────

  describe("executeInterceptedToolCall", () => {
    test("returns false for null intercepted", async () => {
      const result = await executor.executeInterceptedToolCall(null);
      assert.equal(result, false);
    });

    test("returns false for undefined intercepted", async () => {
      const result = await executor.executeInterceptedToolCall(undefined);
      assert.equal(result, false);
    });

    test("emits retract and tool events", async () => {
      await executor.executeInterceptedToolCall({ name: "test_tool", input: { arg: 1 }, trailing: "" });
      assert.equal(emitter.send.mock.calls.length, 2);
      assert.equal(emitter.send.mock.calls[0].arguments[0].type, "retract");
      assert.equal(emitter.send.mock.calls[1].arguments[0].type, "tool");
    });

    test("calls callTool with intercepted name and input", async () => {
      await executor.executeInterceptedToolCall({ name: "my_tool", input: { x: 42 }, trailing: "" });
      assert.equal(callTool.mock.calls.length, 1);
      assert.equal(callTool.mock.calls[0].arguments[0], "my_tool");
      assert.deepEqual(callTool.mock.calls[0].arguments[1], { x: 42 });
    });

    test("pushes assistant and user messages", async () => {
      await executor.executeInterceptedToolCall({ name: "t", input: {}, trailing: "" });
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, "assistant");
      assert.equal(messages[0].content[0].type, "tool_use");
      assert.equal(messages[1].role, "user");
      assert.equal(messages[1].content[0].type, "tool_result");
    });

    test("with trailing: validates, emits stream events, returns validated text", async () => {
      const result = await executor.executeInterceptedToolCall({ name: "t", input: {}, trailing: "Operation completed" });
      assert.equal(result, "Operation completed");

      const streamStart = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_start");
      const streamEnd = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end");
      assert.ok(streamStart);
      assert.ok(streamEnd);
      assert.equal(streamEnd.arguments[0].text, "Operation completed");
    });

    test("without trailing returns null", async () => {
      const result = await executor.executeInterceptedToolCall({ name: "t", input: {}, trailing: "" });
      assert.equal(result, null);
    });

    test("passes reasoningContent to assistant message", async () => {
      await executor.executeInterceptedToolCall({ name: "t", input: {}, trailing: "done" }, "reasoning steps");
      const assistant = messages.find(m => m.role === "assistant");
      assert.ok(assistant);
      assert.equal(assistant.reasoning_content, "reasoning steps");
    });
  });

  // ── executeThinkingResponse ───────────────────────────────────────────────────

  describe("executeThinkingResponse", () => {
    let streamHandler;

    beforeEach(() => {
      streamHandler = { flushRemainingTokenBuffer: mock.fn() };
    });

    test("intercepts tool call from cleanText when no toolCalls", async () => {
      const cleanText = '{"arg": 1, "name": "think_tool"} - Response: done';
      const result = await executor.executeThinkingResponse(cleanText, [], streamHandler, true);
      assert.equal(result, "done");
      assert.equal(callTool.mock.calls.length, 1);
      assert.equal(callTool.mock.calls[0].arguments[0], "think_tool");
    });

    test("executes toolCalls when no interception", async () => {
      const tc = [{ id: "tc1", name: "list_dir", args: '{"path":"."}' }];
      const result = await executor.executeThinkingResponse("", tc, streamHandler, true);
      assert.equal(result, null);
      assert.equal(callTool.mock.calls.length, 1);
    });

    test("returns validated text when no toolCalls and no interception", async () => {
      const cleanText = "Just some text output";
      const result = await executor.executeThinkingResponse(cleanText, [], streamHandler, true);
      assert.equal(result, "Just some text output");

      const assistant = messages.find(m => m.role === "assistant");
      assert.ok(assistant);
      assert.equal(assistant.content[0].text, "Just some text output");
    });

    test("passes reasoningContent through", async () => {
      const cleanText = "Plain output text";
      await executor.executeThinkingResponse(cleanText, [], streamHandler, true, "deep thoughts");
      const assistant = messages.find(m => m.role === "assistant");
      assert.equal(assistant.reasoning_content, "deep thoughts");
    });

    test("emits reasoning_done on intercepted path", async () => {
      const cleanText = '{"arg": true, "name": "t"}';
      await executor.executeThinkingResponse(cleanText, [], streamHandler, true);
      const reasoningDone = emitter.send.mock.calls.find(c => c.arguments[0].type === "reasoning_done");
      assert.ok(reasoningDone);
    });

    test("emits reasoning_done on toolCalls path", async () => {
      const tc = [{ id: "t1", name: "read_file", args: "{}" }];
      await executor.executeThinkingResponse("", tc, streamHandler, true);
      const reasoningDone = emitter.send.mock.calls.find(c => c.arguments[0].type === "reasoning_done");
      assert.ok(reasoningDone);
    });

    test("emits reasoning_done on no-tool/no-intercept path", async () => {
      await executor.executeThinkingResponse("text", [], streamHandler, true);
      const reasoningDone = emitter.send.mock.calls.find(c => c.arguments[0].type === "reasoning_done");
      assert.ok(reasoningDone);
    });
  });

  // ── executeNonThinkingResponse ────────────────────────────────────────────────

  describe("executeNonThinkingResponse", () => {
    let streamHandler;

    beforeEach(() => {
      streamHandler = { flushRemainingTokenBuffer: mock.fn(), tokenBuffer: "buffered text" };
    });

    test("executes toolCalls when present", async () => {
      const tc = [{ id: "t1", name: "read_file", args: '{"path":"x"}' }];
      const result = await executor.executeNonThinkingResponse("", tc, streamHandler);
      assert.equal(result, null);
      assert.equal(callTool.mock.calls.length, 1);
    });

    test("emits stream_end with empty on tool calls path", async () => {
      const tc = [{ id: "t1", name: "read_file", args: "{}" }];
      await executor.executeNonThinkingResponse("", tc, streamHandler);
      const streamEnd = emitter.send.mock.calls.find(c => c.arguments[0].type === "stream_end");
      assert.ok(streamEnd);
      assert.equal(streamEnd.arguments[0].text, "");
    });

    test("intercepts text tool call from cleanText when no toolCalls", async () => {
      const cleanText = '{"arg": "v", "name": "intercepted"} - Result: done';
      const result = await executor.executeNonThinkingResponse(cleanText, [], streamHandler);
      assert.equal(result, "done");
      assert.equal(callTool.mock.calls.length, 1);
      assert.equal(streamHandler.tokenBuffer, "");
    });

    test("returns validated text when no toolCalls and no interception", async () => {
      const cleanText = "Final answer";
      const result = await executor.executeNonThinkingResponse(cleanText, [], streamHandler);
      assert.equal(result, "Final answer");
      assert.equal(streamHandler.flushRemainingTokenBuffer.mock.calls.length, 1);
    });

    test("flushes token buffer on final text path", async () => {
      await executor.executeNonThinkingResponse("final text", [], streamHandler);
      assert.equal(streamHandler.flushRemainingTokenBuffer.mock.calls.length, 1);
    });

    test("pushes assistant message with validated text on final path", async () => {
      await executor.executeNonThinkingResponse("output", [], streamHandler);
      const assistant = messages.find(m => m.role === "assistant");
      assert.ok(assistant);
      assert.equal(assistant.content[0].text, "output");
    });
  });
});
