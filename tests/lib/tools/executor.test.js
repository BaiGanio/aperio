// tests/lib/tools/executor.test.js
import { describe, test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import logger from "../../../lib/helpers/logger.js";
import { extractTextToolCall, extractBracketToolCall, detectToolCallLeak, recoverToolName, ToolExecutor, DESTRUCTIVE_TOOLS, getDestructiveTools, findPriorToolResult } from "../../../lib/tools/executor.js";

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

  test("recovers an Ornith [tool_call] bbcode call leaked into text", () => {
    const text = 'Let me get its details now...\n[tool_call](fetch_github_issue) [url]https://github.com/BaiGanio/aperio/issues/49[/url][repo]aperio[/repo]';
    const result = extractTextToolCall(text, []);
    assert.notEqual(result, null);
    assert.equal(result.name, "fetch_github_issue");
    assert.deepEqual(result.input, { url: "https://github.com/BaiGanio/aperio/issues/49", repo: "aperio" });
  });

  test("recovers OpenAI wire-format leak (name under call/tool, params under args)", () => {
    for (const key of ["call", "tool", "function"]) {
      const text = `{"${key}": "recall", "args": {"query": "exam"}}`;
      const result = extractTextToolCall(text, []);
      assert.equal(result?.name, "recall", `name via "${key}"`);
      assert.deepEqual(result.input, { query: "exam" });
    }
  });

  test("recovers the fenced wire-format leak and leaves a mis-typed arg untouched", () => {
    // Model wrapped the scalar url in a one-element array — we do NOT coerce it;
    // the tool's schema validation + retry loop handles the wrong shape.
    const text = '```json|mask:step\n{"tool_call_id": "tool_7","call": "fetch_github_issue", "args": {"repo": "aperio","url": ["https://x/issues/49"]}}\n{"id": 123, "type": "function"}\n```';
    const result = extractTextToolCall(text, []);
    assert.equal(result?.name, "fetch_github_issue");
    assert.deepEqual(result.input, { repo: "aperio", url: ["https://x/issues/49"] });
  });
});

// =============================================================================
// extractBracketToolCall
//
// Ornith-family models leak tool calls as "[tool_call](name) [key]val[/key]"
// bbcode when the Ollama renderer's parser fails. Recover name + args so the
// call dispatches instead of rendering as dead text.
// =============================================================================

describe("extractBracketToolCall", () => {
  test("returns null for empty or non-bracket text", () => {
    assert.equal(extractBracketToolCall(""), null);
    assert.equal(extractBracketToolCall("I'll remember that for you."), null);
  });

  test("parses the tool name and [key]value[/key] string args", () => {
    const result = extractBracketToolCall("[tool_call](fetch_github_issue) [url]https://x/issues/49[/url][repo]aperio[/repo]");
    assert.deepEqual(result, { name: "fetch_github_issue", input: { url: "https://x/issues/49", repo: "aperio" }, trailing: "" });
  });

  test("JSON-parses array/object arg values, keeps scalars as strings", () => {
    const result = extractBracketToolCall('[tool_call](remember) [content]blue[/content][tags]["prefs","color"][/tags]');
    assert.equal(result.name, "remember");
    assert.deepEqual(result.input, { content: "blue", tags: ["prefs", "color"] });
  });

  test("handles a no-arg call", () => {
    assert.deepEqual(extractBracketToolCall("[tool_call](scan_project)"), { name: "scan_project", input: {}, trailing: "" });
  });

  test("captures trailing text after the call, stripping a Response: prefix", () => {
    const result = extractBracketToolCall("[tool_call](x) [a]1[/a] Response: done");
    assert.equal(result.trailing, "done");
  });
});

// =============================================================================
// ToolExecutor
// =============================================================================

// =============================================================================
// detectToolCallLeak
//
// Flags tool calls a weak model rendered as prose (XML-ish tags or function
// notation from skill docs) that the JSON-object extractor can't recover —
// without false-positiving on plain chat.
// =============================================================================

describe("detectToolCallLeak", () => {
  test("flags the <execute_tool> blob from the screenshot", () => {
    const text = '<execute_tool>\nskills/memory-protocol/SKILL.md:call(recall, query="exam")\n</execute_tool>\nPlease wait while I retrieve…';
    assert.equal(detectToolCallLeak(text), true);
  });

  test("flags call(recall, …) notation", () => {
    assert.equal(detectToolCallLeak('call(recall, query="exam")'), true);
  });

  test("flags <tool_call> / <invoke> tags", () => {
    assert.equal(detectToolCallLeak("<tool_call>recall</tool_call>"), true);
    assert.equal(detectToolCallLeak('<invoke name="recall">'), true);
  });

  test("flags Ornith [tool_call](name) bbcode", () => {
    assert.equal(detectToolCallLeak("[tool_call](fetch_github_issue) [url]x[/url]"), true);
  });

  test("flags OpenAI wire-format JSON whose value is a known tool", () => {
    assert.equal(detectToolCallLeak('{"call": "fetch_github_issue", "args": {}}', ["fetch_github_issue"]), true);
    assert.equal(detectToolCallLeak('{"tool": "recall"}', ["recall"]), true);
  });

  test("does not flag ordinary JSON whose value is not a tool name", () => {
    assert.equal(detectToolCallLeak('{"name": "Alice", "role": "admin"}', ["recall", "fetch_github_issue"]), false);
  });

  test("flags a known-tool function call with a named arg", () => {
    assert.equal(detectToolCallLeak('recall(query="exam")', ["recall", "db_query"]), true);
  });

  test("flags a narrated call the model never issued (gemma e4b)", () => {
    const text = "I need to load the content of that issue first before giving you an opinion.\n\nCalling `fetch_github_issue` for https://github.com/BaiGanio/aperio/issues/49.";
    assert.equal(detectToolCallLeak(text, ["fetch_github_issue", "recall"]), true);
  });

  test("flags first-person intent to call a known tool", () => {
    assert.equal(detectToolCallLeak("I'll call fetch_github_issue to get the details.", ["fetch_github_issue"]), true);
    assert.equal(detectToolCallLeak("Let me use recall to check your memories.", ["recall"]), true);
    assert.equal(detectToolCallLeak("I'm invoking db_query now.", ["db_query"]), true);
  });

  test("does not flag narration for an unknown tool name", () => {
    assert.equal(detectToolCallLeak("Calling fetch_github_issue for the URL.", ["recall"]), false);
  });

  test("does not flag plain prose that mentions a tool name", () => {
    assert.equal(detectToolCallLeak("I'll recall (from memory) what we discussed.", ["recall"]), false);
    assert.equal(detectToolCallLeak("Let me check your memories for the exam.", ["recall"]), false);
  });

  test("does not flag second-person advice or past-tense summaries", () => {
    assert.equal(detectToolCallLeak("You can call fetch_github_issue with the URL to load it.", ["fetch_github_issue"]), false);
    assert.equal(detectToolCallLeak("I called fetch_github_issue and here is what I found.", ["fetch_github_issue"]), false);
  });

  test("does not flag empty or whitespace text", () => {
    assert.equal(detectToolCallLeak(""), false);
    assert.equal(detectToolCallLeak("   \n  "), false);
  });
});

// =============================================================================
// recoverToolName
// =============================================================================
describe("recoverToolName", () => {
  const tools = ["db_connections", "db_schema", "db_query", "db_execute", "recall"];

  test("returns the name unchanged when it is already a known tool", () => {
    assert.equal(recoverToolName("db_schema", tools), "db_schema");
  });

  test("recovers the real tool name from gemma channel/harmony markup", () => {
    const garbage = "thought <|channel>thought <channel|><|tool_call>call:db_schema";
    assert.equal(recoverToolName(garbage, tools), "db_schema");
  });

  test("prefers the last embedded tool name (the one after the call marker)", () => {
    // A planning channel can mention one tool then actually call another.
    const garbage = "<|channel>I'll use db_query<|tool_call>call:db_schema";
    assert.equal(recoverToolName(garbage, tools), "db_schema");
  });

  test("matches on token boundaries, not substrings", () => {
    // "query" must not match inside "db_query".
    assert.equal(recoverToolName("call:db_query", ["query", "db_query"]), "db_query");
  });

  test("returns null when no known tool is embedded", () => {
    assert.equal(recoverToolName("<|tool_call>call:totally_made_up", tools), null);
    assert.equal(recoverToolName("", tools), null);
    assert.equal(recoverToolName("db_schema", []), null);
  });
});

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

// =============================================================================
// getDestructiveTools — built-in floor + APERIO_EXTRA_DESTRUCTIVE_TOOLS extend
// =============================================================================

describe("getDestructiveTools", () => {
  const saved = process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS;
  afterEach(() => {
    if (saved === undefined) delete process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS;
    else process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS = saved;
  });

  test("returns the built-in set when nothing is configured", () => {
    delete process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS;
    assert.equal(getDestructiveTools(), DESTRUCTIVE_TOOLS);
  });

  test("adds configured extras on top of the baseline", () => {
    process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS = " my_writer , my_db_mutator ";
    const eff = getDestructiveTools();
    assert.ok(eff.has("edit_file"), "built-in is still present");
    assert.ok(eff.has("my_writer"), "trimmed extra is present");
    assert.ok(eff.has("my_db_mutator"));
  });

  test("built-ins cannot be removed via config", () => {
    process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS = "only_this";
    assert.ok(getDestructiveTools().has("write_file"));
  });
});

// =============================================================================
// findPriorToolResult — loop-breaker for tiny-window trim thrash
//
// On a small context window, trimming evicts the freshest tool_use/tool_result
// pair, so the model re-issues the identical call and spins. The persistent
// `messages` array still holds the prior result; findPriorToolResult recovers
// it so the executor can hand it back instead of re-running the tool.
// =============================================================================

describe("findPriorToolResult", () => {
  // A completed identical call earlier in THIS turn: user text, then the
  // assistant's tool_use, then its tool_result.
  function turnWith(name, input, resultText) {
    return [
      { role: "user", content: "check issue 49" },
      { role: "assistant", content: [{ type: "tool_use", id: "a1", name, input }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "a1", content: resultText }] },
    ];
  }

  test("returns the prior result for an identical in-turn call", () => {
    const msgs = turnWith("fetch_github_issue", { url: "u/49" }, "ISSUE BODY");
    assert.equal(findPriorToolResult(msgs, "fetch_github_issue", { url: "u/49" }), "ISSUE BODY");
  });

  test("is order-independent on argument keys", () => {
    const msgs = turnWith("fetch_url", { a: 1, b: 2 }, "PAGE");
    assert.equal(findPriorToolResult(msgs, "fetch_url", { b: 2, a: 1 }), "PAGE");
  });

  test("returns null when args differ", () => {
    const msgs = turnWith("fetch_github_issue", { url: "u/49" }, "ISSUE BODY");
    assert.equal(findPriorToolResult(msgs, "fetch_github_issue", { url: "u/50" }), null);
  });

  test("returns null when the prior call is in an EARLIER turn (a fresh re-ask re-runs)", () => {
    const msgs = [
      ...turnWith("fetch_github_issue", { url: "u/49" }, "OLD BODY"),
      { role: "user", content: "check it again" }, // new turn — earlier result out of scope
    ];
    assert.equal(findPriorToolResult(msgs, "fetch_github_issue", { url: "u/49" }), null);
  });

  test("returns null when there is no matching prior call", () => {
    assert.equal(findPriorToolResult([{ role: "user", content: "hi" }], "recall", { query: "x" }), null);
  });
});

describe("executeToolCalls — duplicate-call short-circuit", () => {
  test("reuses the prior result instead of re-invoking callTool", async () => {
    const messages = [
      { role: "user", content: "check issue 49" },
      { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "fetch_github_issue", input: { url: "u/49" } }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "a1", content: "CACHED ISSUE BODY" }] },
    ];
    const callTool = mock.fn(async () => "FRESH FETCH");
    const emitter = { send: mock.fn() };
    const ex = new ToolExecutor(callTool, emitter, messages);
    await ex.executeToolCalls([{ id: "a2", name: "fetch_github_issue", args: '{"url":"u/49"}' }]);

    assert.equal(callTool.mock.calls.length, 0, "callTool must NOT run for the duplicate");
    const toolMsg = messages[messages.length - 1];
    const content = toolMsg.content[0].content;
    assert.ok(content.includes("CACHED ISSUE BODY"), "prior result is handed back");
    assert.ok(content.includes("do not call"), "model is nudged to stop repeating");
  });

  test("still runs callTool for a genuinely new call", async () => {
    const messages = [{ role: "user", content: "check issue 49" }];
    const callTool = mock.fn(async () => "FRESH FETCH");
    const ex = new ToolExecutor(callTool, { send: mock.fn() }, messages);
    await ex.executeToolCalls([{ id: "a1", name: "fetch_github_issue", args: '{"url":"u/49"}' }]);
    assert.equal(callTool.mock.calls.length, 1);
    assert.equal(messages[messages.length - 1].content[0].content, "FRESH FETCH");
  });

  test("intercepted (text-emitted) call also reuses the prior result", async () => {
    const messages = [
      { role: "user", content: "check issue 49" },
      { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "fetch_github_issue", input: { url: "u/49" } }] },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "a1", content: "CACHED ISSUE BODY" }] },
    ];
    const callTool = mock.fn(async () => "FRESH FETCH");
    const ex = new ToolExecutor(callTool, { send: mock.fn() }, messages);
    await ex.executeInterceptedToolCall({ name: "fetch_github_issue", input: { url: "u/49" }, trailing: "" });

    assert.equal(callTool.mock.calls.length, 0, "callTool must NOT run for the duplicate");
    // The intercepted path pushes its result as a role:"user" tool_result.
    const resultMsg = messages.find(m => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result");
    assert.ok(resultMsg, "prior result is handed back on the intercepted path");
    assert.ok(resultMsg.content[0].content.includes("CACHED ISSUE BODY"), "reuses the prior body");
    assert.ok(resultMsg.content[0].content.includes("do not call"), "model is nudged to stop repeating");
  });
});
