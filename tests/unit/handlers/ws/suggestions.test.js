import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  parseSuggestionItem,
  guessSuggestionType,
  handleSaveSuggestions,
} from "../../../../lib/emitters/handlers/ws/suggestions.js";

// =============================================================================
// parseSuggestionItem — parse structured agent output into title/content
// =============================================================================
describe("parseSuggestionItem", () => {
  test("parses full format: [type] title — content", () => {
    const result = parseSuggestionItem("[fact] **User prefers dark mode** — The user explicitly set their theme to dark");
    assert.equal(result.type, "fact");
    assert.equal(result.title, "User prefers dark mode");
    assert.equal(result.content, "The user explicitly set their theme to dark");
  });

  test("parses preference type", () => {
    const result = parseSuggestionItem("[preference] **Dislikes notifications** — User turned off all non-essential notifications");
    assert.equal(result.type, "preference");
    assert.equal(result.title, "Dislikes notifications");
  });

  test("parses decision type", () => {
    const result = parseSuggestionItem("[decision] **Use Postgres** — Team agreed to migrate from SQLite");
    assert.equal(result.type, "decision");
  });

  test("parses person type", () => {
    const result = parseSuggestionItem("[person] **Alice** — Lead designer on the project");
    assert.equal(result.type, "person");
  });

  test("parses project type", () => {
    const result = parseSuggestionItem("[project] **Aperio** — Self-hosted memory layer");
    assert.equal(result.type, "project");
  });

  test("parses solution type", () => {
    const result = parseSuggestionItem("[solution] **Use Redis cache** — Improves response time by 40%");
    assert.equal(result.type, "solution");
  });

  test("parses source type", () => {
    const result = parseSuggestionItem("[source] **RFC 1234** — Defines the protocol");
    assert.equal(result.type, "source");
  });

  test("guesses type when no type prefix is present", () => {
    const result = parseSuggestionItem("**User prefers Python** — They mentioned preferring Python for scripting");
    // "prefers" contains "prefer" → guessSuggestionType returns "preference"
    assert.equal(result.type, "preference");
  });

  test("handles missing dash-separator by using full rest as both title and content", () => {
    const result = parseSuggestionItem("[fact] **A simple note**");
    assert.equal(result.title, "A simple note");
    assert.equal(result.content, "A simple note");
  });

  test("truncates long titles at 68 chars (67 + ellipsis) when there is no dash-separator", () => {
    const long = "A".repeat(80);
    const result = parseSuggestionItem(`[fact] **${long}**`);
    assert.equal(result.title.length, 68); // 67 chars + "…"
    assert.ok(result.title.endsWith("…"));
  });

  test("does not truncate title when dash-separator is present even if title is long", () => {
    const long = "A".repeat(100);
    const result = parseSuggestionItem(`[fact] **${long}** — but content is short`);
    assert.equal(result.title.length, 100);
    assert.equal(result.content, "but content is short");
  });

  test("ignores invalid type prefix and uses guess instead", () => {
    const result = parseSuggestionItem("[invalid] **Something important** — Some description");
    // "important" doesn't match preference/decision/project → guess returns "fact"
    assert.equal(result.type, "fact");
  });

  test("strips ** bold markers from the rest text", () => {
    const result = parseSuggestionItem("[fact] **bold title** — **bold content**");
    assert.equal(result.title, "bold title");
    assert.equal(result.content, "bold content");
  });

  test("handles case-insensitive type prefix", () => {
    const result = parseSuggestionItem("[FACT] **A fact** — Some content");
    assert.equal(result.type, "fact");
  });

  test("handles whitespace-only input as empty string (trimmed)", () => {
    const result = parseSuggestionItem("   ");
    assert.equal(result.type, "fact");
    assert.equal(result.title, ""); // trimmed
    assert.equal(result.content, ""); // trimmed
  });

  test("handles empty string input", () => {
    const result = parseSuggestionItem("");
    assert.equal(result.type, "fact");
    assert.equal(result.title, "");
    assert.equal(result.content, "");
  });
});

// =============================================================================
// guessSuggestionType — infer type from text keywords
// =============================================================================
describe("guessSuggestionType", () => {
  test("returns 'preference' for text containing 'prefer'", () => {
    assert.equal(guessSuggestionType("User prefers Python over JavaScript"), "preference");
  });

  test("returns 'preference' for 'dislike' with a word boundary after it", () => {
    assert.equal(guessSuggestionType("User has a strong dislike for notifications"), "preference");
  });

  test("returns 'decision' for text containing 'decided'", () => {
    assert.equal(guessSuggestionType("Team decided to use Vite"), "decision");
  });

  test("returns 'decision' for text containing 'chose'", () => {
    assert.equal(guessSuggestionType("Architecture chose microservices"), "decision");
  });

  test("returns 'decision' for text containing 'agreed'", () => {
    assert.equal(guessSuggestionType("Team agreed on the schema"), "decision");
  });

  test("returns 'decision' for text containing 'resolved'", () => {
    assert.equal(guessSuggestionType("Resolved to ship by Friday"), "decision");
  });

  test("returns 'project' for text containing 'project'", () => {
    assert.equal(guessSuggestionType("Project uses React"), "project");
  });

  test("returns 'project' for text containing 'stack'", () => {
    assert.equal(guessSuggestionType("Node.js stack with Express"), "project");
  });

  test("returns 'fact' as the default fallback", () => {
    assert.equal(guessSuggestionType("The sky is blue"), "fact");
  });
});

// =============================================================================
// handleSaveSuggestions — persist accepted memory suggestions
// =============================================================================
describe("handleSaveSuggestions", () => {
  test("saves valid items via callTool(remember)", async () => {
    const callTool = mock.fn(async () => "OK");
    const send = mock.fn();
    const store = { listAll: async () => [] };

    await handleSaveSuggestions(
      [{ text: "[fact] **User likes cats** — They mentioned having two cats" }],
      { callTool, send, sessionLogger: { error: mock.fn() }, store },
    );

    assert.equal(callTool.mock.calls.length, 1);
    const [, args] = callTool.mock.calls[0].arguments;
    assert.equal(args.title, "User likes cats");
    assert.equal(args.content, "They mentioned having two cats");
    assert.deepEqual(args.tags, ["memory-suggestion"]);
    assert.equal(args.importance, 3);
  });

  test("skips items with empty text", async () => {
    const callTool = mock.fn();
    const send = mock.fn();
    const store = { listAll: async () => [] };

    await handleSaveSuggestions(
      [{ text: "" }, { text: "   " }, { text: "[fact] **Valid** — content" }],
      { callTool, send, sessionLogger: { error: mock.fn() }, store },
    );

    // Only the valid item should be saved
    assert.equal(callTool.mock.calls.length, 1);
  });

  test("handles callTool rejection gracefully (logs and continues)", async () => {
    const callTool = mock.fn(async () => { throw new Error("duplicate"); });
    const send = mock.fn();
    const store = { listAll: async () => [] };

    await handleSaveSuggestions(
      [{ text: "[fact] **X** — Y" }],
      { callTool, send, sessionLogger: { error: mock.fn() }, store },
    );

    assert.equal(send.mock.calls.length, 2); // suggestions_saved + sendMemories(memories)
    const [type, payload] = send.mock.calls[0].arguments;
    assert.equal(type, "suggestions_saved");
    assert.equal(payload.saved, 0);
    assert.equal(payload.total, 1);
  });

  test("reports correct saved/total counts", async () => {
    const callTool = mock.fn(async () => "OK");
    const send = mock.fn();
    const store = { listAll: async () => [] };

    await handleSaveSuggestions(
      [
        { text: "[fact] **A** — first" },
        { text: "[preference] **B** — second" },
      ],
      { callTool, send, sessionLogger: { error: mock.fn() }, store },
    );

    assert.equal(callTool.mock.calls.length, 2);
    assert.equal(send.mock.calls[0].arguments[0], "suggestions_saved");
    assert.deepEqual(send.mock.calls[0].arguments[1], { saved: 2, total: 2 });
  });

  test("calls sendMemories after saving", async () => {
    const callTool = mock.fn(async () => "OK");
    const send = mock.fn();
    const store = { listAll: async () => [] };

    await handleSaveSuggestions(
      [{ text: "[fact] **C** — third" }],
      { callTool, send, sessionLogger: { error: mock.fn() }, store },
    );

    // Second send call should be memories broadcast
    assert.ok(send.mock.calls.length >= 2);
    assert.equal(send.mock.calls[1].arguments[0], "memories");
  });
});
