import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMessages,
  isSummarizeIntent,
  buildHistoryText,
  tagLastAssistant,
} from "../../../../lib/emitters/handlers/ws/helpers.js";

// =============================================================================
// normalizeMessages — collapse content arrays to plain text
// =============================================================================
describe("normalizeMessages", () => {
  test("leaves string content unchanged", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    normalizeMessages(msgs);
    assert.deepEqual(msgs, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]);
  });

  test("collapses content array text blocks into a single string", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: "World" },
        ],
      },
    ];
    normalizeMessages(msgs);
    assert.equal(msgs[0].content, "Hello\nWorld");
  });

  test("drops messages that are purely tool blocks with zero text", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "calc", input: {} }] },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }],
      },
    ];
    normalizeMessages(msgs);
    assert.deepEqual(msgs, [{ role: "user", content: "hi" }]);
  });

  test("mixes text blocks with tool blocks — keeps the text, drops tool-only messages", () => {
    const msgs = [
      { role: "user", content: "count to 3" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me count:" },
          { type: "tool_use", id: "tu_1", name: "count", input: { n: 3 } },
        ],
      },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "1, 2, 3" }] },
    ];
    normalizeMessages(msgs);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, "count to 3");
    assert.equal(msgs[1].content, "Let me count:");
  });

  test("handles an empty array", () => {
    const msgs = [];
    normalizeMessages(msgs);
    assert.deepEqual(msgs, []);
  });

  test("handles array content with empty string text blocks", () => {
    const msgs = [
      { role: "user", content: [{ type: "text", text: "" }] },
    ];
    normalizeMessages(msgs);
    // Empty text results in empty trimmed string — message is dropped
    assert.deepEqual(msgs, []);
  });

  test("preserves image blocks alongside text when present", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What's in this image?" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ],
      },
    ];
    normalizeMessages(msgs);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, "user");
    assert.equal(msgs[0].content[0].type, "text");
    assert.equal(msgs[0].content[0].text, "What's in this image?");
    assert.equal(msgs[0].content[1].type, "image");
    assert.equal(msgs[0].content[1].source.type, "base64");
  });

  test("preserves image-only messages (no text blocks)", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "imgdata" } },
        ],
      },
    ];
    normalizeMessages(msgs);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content.length, 1);
    assert.equal(msgs[0].content[0].type, "image");
  });

  test("strips tool_use blocks but keeps image + text in the same message", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's the result:" },
          { type: "image", source: { type: "url", url: "https://example.com/chart.png" } },
          { type: "tool_use", id: "tu_1", name: "get_data", input: {} },
        ],
      },
    ];
    normalizeMessages(msgs);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content.length, 2);
    assert.equal(msgs[0].content[0].type, "text");
    assert.equal(msgs[0].content[1].type, "image");
  });
});

// =============================================================================
// isSummarizeIntent — detect user asking for a summary
// =============================================================================
describe("isSummarizeIntent", () => {
  test("matches 'summarize the conversation'", () => {
    assert.ok(isSummarizeIntent("Please summarize the conversation"));
  });

  test("matches 'summarise the chat' (British spelling)", () => {
    assert.ok(isSummarizeIntent("Can you summarise the chat?"));
  });

  test("matches 'summary of this session'", () => {
    assert.ok(isSummarizeIntent("Give me a summary of this session"));
  });

  test("matches 'recap' paired with a conversation reference", () => {
    assert.ok(isSummarizeIntent("recap our conversation"));
  });

  test("matches 'recap the session'", () => {
    assert.ok(isSummarizeIntent("recap the session"));
  });

  test("matches 'tl;dr'", () => {
    assert.ok(isSummarizeIntent("tl;dr"));
  });

  test("matches 'TLDR' case-insensitively", () => {
    assert.ok(isSummarizeIntent("TLDR"));
  });

  test("matches 'summarize everything'", () => {
    assert.ok(isSummarizeIntent("summarize everything"));
  });

  test("does not match unrelated text", () => {
    assert.equal(isSummarizeIntent("What is the weather today?"), false);
  });

  test("does not match empty string", () => {
    assert.equal(isSummarizeIntent(""), false);
  });

  test("does not match whitespace-only string", () => {
    assert.equal(isSummarizeIntent("   "), false);
  });

  test("does not match 'summary' alone without a conversation reference", () => {
    // 'summary' appears in the regex only when paired with conversation/chat/etc
    assert.equal(isSummarizeIntent("I need a summary of the report"), false);
  });
});

// =============================================================================
// buildHistoryText — flatten messages into a plain-text transcript
// =============================================================================
describe("buildHistoryText", () => {
  test("formats user and assistant messages with role labels", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ];
    assert.equal(
      buildHistoryText(msgs),
      "User: Hello\n\nAssistant: Hi there!",
    );
  });

  test("filters out role: tool messages entirely", () => {
    const msgs = [
      { role: "user", content: "calc 1+1" },
      { role: "tool", content: "2" },
      { role: "assistant", content: "The result is 2" },
    ];
    assert.equal(
      buildHistoryText(msgs),
      "User: calc 1+1\n\nAssistant: The result is 2",
    );
  });

  test("filters messages whose content is a tool_result block", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42" }] },
    ];
    assert.equal(buildHistoryText(msgs), "User: hi");
  });

  test("extracts text blocks from array content, ignoring tool blocks", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Here's a thought:" },
          { type: "tool_use", id: "tu_1", name: "search", input: { q: "x" } },
        ],
      },
    ];
    assert.equal(buildHistoryText(msgs), "Assistant: Here's a thought:");
  });

  test("returns empty string for an empty array", () => {
    assert.equal(buildHistoryText([]), "");
  });

  test("skips messages with empty text", () => {
    const msgs = [
      { role: "user", content: "" },
      { role: "assistant", content: "  " },
    ];
    assert.equal(buildHistoryText(msgs), "");
  });

  test("trims whitespace from extracted text", () => {
    const msgs = [
      { role: "user", content: "  hello world  " },
    ];
    assert.equal(buildHistoryText(msgs), "User: hello world");
  });
});

// =============================================================================
// tagLastAssistant — stamp the final assistant message with model/provider id
// =============================================================================
describe("tagLastAssistant", () => {
  test("stamps _model and _provider on the last assistant message", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    tagLastAssistant(msgs, { model: "claude-3-haiku", name: "anthropic" });
    assert.equal(msgs[1]._model, "claude-3-haiku");
    assert.equal(msgs[1]._provider, "anthropic");
  });

  test("does nothing when the last message is not assistant", () => {
    const msgs = [{ role: "user", content: "hi" }];
    tagLastAssistant(msgs, { model: "gpt-4", name: "openai" });
    assert.equal(msgs[0]._model, undefined);
    assert.equal(msgs[0]._provider, undefined);
  });

  test("does nothing on an empty array", () => {
    const msgs = [];
    tagLastAssistant(msgs, { model: "gpt-4", name: "openai" });
    assert.deepEqual(msgs, []);
  });

  test("stamps on the last assistant even when preceded by tool messages", () => {
    const msgs = [
      { role: "user", content: "read file x" },
      { role: "tool", content: "file content" },
      { role: "assistant", content: "Here's what I found" },
    ];
    tagLastAssistant(msgs, { model: "deepseek-chat", name: "deepseek" });
    assert.equal(msgs[2]._model, "deepseek-chat");
    assert.equal(msgs[2]._provider, "deepseek");
  });
});
