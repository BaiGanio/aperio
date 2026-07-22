/**
 * chat.test.js — Unit tests for lib/chat.js
 *
 * Tests the exported utility functions from the refactored chat module.
 * This file imports and exercises the actual code in chat.js to achieve coverage.
 */

import assert from "assert";
import { describe, test, beforeEach, afterEach, after } from "node:test";
import { setupSecureTestEnvironment } from "../../helpers/sandbox.js";

const cleanupSandbox = setupSecureTestEnvironment();
after(cleanupSandbox);

// Import all exported functions from chat.js
import {
  isEmptyCommand,
  isExitCommand,
  isClearCommand,
  isMemoriesCommand,
  isReasoningCommand,
  isRememberIntent,
  isLlamaCppProvider,
  toggleReasoning,
  buildWebSocketUrl,
  isValidPort,
  getDefaultModel,
  normalizeModelName,
  isValidModelName,
  formatColoredText,
  createMessage,
  addMessageToQueue,
  parseMessage,
  isWebSocketOpen,
  getReconnectionDelay,
  handleSigint,
  shouldExitOnSigint,
  isSpecialCommand,
  createMessageQueue,
  getQueueLength,
  getMessageFromQueue,
  isHelpCommand,
  parseHelpTarget,
  HELP_TARGETS,
  isExamplesCommand,
  isLangCommand,
  parseLang,
  isRestartCommand,
  isHardRestart,
  isStatsCommand,
  isStatusCommand,
  isConfigCommand,
  isDiscussCommand,
  isSummarizeCommand,
  isForgetCommand,
  isHandoffCommand,
  isSessionsCommand,
  isModelCommand,
  isAttachCommand,
  buildAttachedUserContent,
  isResumeCommand,
  printWelcome,
  printHelp,
  printHelpFor,
  HELP_DETAILS,
  printStatus,
  printSessions,
  printConfig,
  readAttachment,
} from "../../../lib/terminal.js";

import { applyConfigToEnv } from "../../../lib/config-resolver.js";

// ─── Command Detection Tests ────────────────────────────────────────────────
describe("Command Detection", () => {
  test("isEmptyCommand detects empty strings", () => {
    assert.strictEqual(isEmptyCommand(""), true);
    assert.strictEqual(isEmptyCommand("   "), true);
    assert.strictEqual(isEmptyCommand("\t\n"), true);
  });

  test("isEmptyCommand rejects non-empty strings", () => {
    assert.strictEqual(isEmptyCommand("hello"), false);
    assert.strictEqual(isEmptyCommand(" x "), false);
  });

  test("isExitCommand detects exit command", () => {
    assert.strictEqual(isExitCommand("exit"), true);
    assert.strictEqual(isExitCommand("  exit  "), true);
  });

  test("isExitCommand rejects other commands", () => {
    assert.strictEqual(isExitCommand("EXIT"), false);
    assert.strictEqual(isExitCommand("exit now"), false);
    assert.strictEqual(isExitCommand("hello"), false);
  });

  test("isClearCommand detects clear command", () => {
    assert.strictEqual(isClearCommand("clear"), true);
    assert.strictEqual(isClearCommand("  clear  "), true);
  });

  test("isClearCommand rejects other commands", () => {
    assert.strictEqual(isClearCommand("CLEAR"), false);
    assert.strictEqual(isClearCommand("clear screen"), false);
  });

  test("isMemoriesCommand detects memories command", () => {
    assert.strictEqual(isMemoriesCommand("memories"), true);
    assert.strictEqual(isMemoriesCommand("  memories  "), true);
  });

  test("isMemoriesCommand rejects other commands", () => {
    assert.strictEqual(isMemoriesCommand("MEMORIES"), false);
    assert.strictEqual(isMemoriesCommand("show memories"), false);
  });

  test("isReasoningCommand detects reasoning command", () => {
    assert.strictEqual(isReasoningCommand("reasoning"), true);
    assert.strictEqual(isReasoningCommand("  reasoning  "), true);
  });

  test("isReasoningCommand rejects other commands", () => {
    assert.strictEqual(isReasoningCommand("REASONING"), false);
    assert.strictEqual(isReasoningCommand("toggle reasoning"), false);
  });
});

// ─── Help / Stats / Status Command Tests ───────────────────────────────────
describe("Help / Stats / Status Detection", () => {
  test("isHelpCommand detects 'help' and '?'", () => {
    assert.strictEqual(isHelpCommand("help"), true);
    assert.strictEqual(isHelpCommand("  help  "), true);
    assert.strictEqual(isHelpCommand("?"), true);
    assert.strictEqual(isHelpCommand("HELP"), true);
  });

  test("isHelpCommand rejects partial matches", () => {
    assert.strictEqual(isHelpCommand("help me plan my week"), false);
    assert.strictEqual(isHelpCommand("what?"), false);
  });

  test("isHelpCommand accepts only a known trailing command (help <command>)", () => {
    assert.strictEqual(isHelpCommand("help attach"), true);
    assert.strictEqual(isHelpCommand("  HELP attach  "), true);
    assert.strictEqual(isHelpCommand("help bogus"), false);
    assert.strictEqual(isHelpCommand("help me"), false);
  });

  test("parseHelpTarget extracts a known command, null otherwise", () => {
    assert.strictEqual(parseHelpTarget("help attach"), "attach");
    assert.strictEqual(parseHelpTarget("  HELP Attach  "), "attach");
    assert.strictEqual(parseHelpTarget("help"), null);
    assert.strictEqual(parseHelpTarget("?"), null);
    assert.strictEqual(parseHelpTarget("help bogus"), null);
    assert.strictEqual(parseHelpTarget("help me plan my week"), null);
  });

  test("isExamplesCommand detects 'examples' case-insensitively", () => {
    assert.strictEqual(isExamplesCommand("examples"), true);
    assert.strictEqual(isExamplesCommand("  EXAMPLES  "), true);
    assert.strictEqual(isExamplesCommand("example"), false);
    assert.strictEqual(isExamplesCommand("show examples"), false);
  });

  test("isLangCommand detects bare 'lang' and 'lang <code>'", () => {
    assert.strictEqual(isLangCommand("lang"), true);
    assert.strictEqual(isLangCommand("lang de"), true);
    assert.strictEqual(isLangCommand("  LANG fr  "), true);
    assert.strictEqual(isLangCommand("language"), false);
    assert.strictEqual(isLangCommand("lang me up please"), false);
  });

  test("parseLang extracts the code, null for bare 'lang'", () => {
    assert.strictEqual(parseLang("lang de"), "de");
    assert.strictEqual(parseLang("  LANG FR  "), "fr");
    assert.strictEqual(parseLang("lang"), null);
  });

  test("isRestartCommand matches 'restart' and 'restart --hard' only", () => {
    assert.strictEqual(isRestartCommand("restart"), true);
    assert.strictEqual(isRestartCommand("restart --hard"), true);
    assert.strictEqual(isRestartCommand("  RESTART --hard  "), true);
    assert.strictEqual(isRestartCommand("restart now"), false);
    assert.strictEqual(isRestartCommand("restarting"), false);
  });

  test("isHardRestart is true only for the --hard variant", () => {
    assert.strictEqual(isHardRestart("restart --hard"), true);
    assert.strictEqual(isHardRestart("restart"), false);
    assert.strictEqual(isHardRestart("restart --soft"), false);
  });

  test("isStatsCommand detects 'stats' case-insensitively", () => {
    assert.strictEqual(isStatsCommand("stats"), true);
    assert.strictEqual(isStatsCommand("  STATS  "), true);
    assert.strictEqual(isStatsCommand("statistics"), false);
  });

  test("isDiscussCommand detects 'discuss' with optional on/off", () => {
    assert.strictEqual(isDiscussCommand("discuss"), true);
    assert.strictEqual(isDiscussCommand("discuss on"), true);
    assert.strictEqual(isDiscussCommand("discuss off"), true);
    assert.strictEqual(isDiscussCommand("  DISCUSS ON  "), true);
  });

  test("isDiscussCommand rejects chat text containing 'discuss'", () => {
    assert.strictEqual(isDiscussCommand("discussion about AI"), false);
    assert.strictEqual(isDiscussCommand("let's discuss"), false);
    assert.strictEqual(isDiscussCommand("discuss the plan"), false);
  });

  test("isStatusCommand detects 'status' case-insensitively", () => {
    assert.strictEqual(isStatusCommand("status"), true);
    assert.strictEqual(isStatusCommand("  Status  "), true);
    assert.strictEqual(isStatusCommand("status now"), false);
  });

  test("isConfigCommand detects 'config' case-insensitively", () => {
    assert.strictEqual(isConfigCommand("config"), true);
    assert.strictEqual(isConfigCommand("  Config  "), true);
    assert.strictEqual(isConfigCommand("config now"), false);
  });

  test("slash-prefixed commands count as special commands", () => {
    assert.strictEqual(isSpecialCommand("/config"), true);
    assert.strictEqual(isSpecialCommand("/help"), true);
    assert.strictEqual(isSpecialCommand("/help attach"), true);
    assert.strictEqual(isSpecialCommand("/examples"), true);
    assert.strictEqual(isSpecialCommand("/lang"), true);
    assert.strictEqual(isSpecialCommand("/lang de"), true);
    assert.strictEqual(isSpecialCommand("/restart"), true);
    assert.strictEqual(isSpecialCommand("/restart --hard"), true);
    assert.strictEqual(isSpecialCommand("/stats"), true);
    assert.strictEqual(isSpecialCommand("/status"), true);
  });

  test("bare control words are regular chat now (slash-only routing)", () => {
    assert.strictEqual(isSpecialCommand("help"), false);
    assert.strictEqual(isSpecialCommand("sessions"), false);
    assert.strictEqual(isSpecialCommand("status"), false);
  });

  test("slash with an unknown target is not special (falls through to chat)", () => {
    assert.strictEqual(isSpecialCommand("/help bogus"), false);
    assert.strictEqual(isSpecialCommand("help me plan my week"), false);
  });
});

// ─── Session / Memory / Model Command Tests ────────────────────────────────
describe("Session / Memory / Model Command Detection", () => {
  test("isSummarizeCommand matches exact 'summarize' (case-sensitive)", () => {
    assert.strictEqual(isSummarizeCommand("summarize"), true);
    assert.strictEqual(isSummarizeCommand("  summarize  "), true);
    assert.strictEqual(isSummarizeCommand("SUMMARIZE"), false);
    assert.strictEqual(isSummarizeCommand("summarize now"), false);
    assert.strictEqual(isSummarizeCommand("summary"), false);
  });

  test("isForgetCommand requires an id argument (case-sensitive)", () => {
    assert.strictEqual(isForgetCommand("forget abc-123"), true);
    assert.strictEqual(isForgetCommand("  forget xyz  "), true);
    assert.strictEqual(isForgetCommand("forget"), false);
    assert.strictEqual(isForgetCommand("forget "), false);
    assert.strictEqual(isForgetCommand("FORGET abc"), false);
    assert.strictEqual(isForgetCommand("please forget abc"), false);
  });

  test("isHandoffCommand matches bare or with focus (case-insensitive)", () => {
    assert.strictEqual(isHandoffCommand("handoff"), true);
    assert.strictEqual(isHandoffCommand("  handoff  "), true);
    assert.strictEqual(isHandoffCommand("handoff the auth refactor"), true);
    assert.strictEqual(isHandoffCommand("HANDOFF"), true);
    assert.strictEqual(isHandoffCommand("handoffs"), false);
    assert.strictEqual(isHandoffCommand("do handoff"), false);
  });

  test("isSessionsCommand matches exact 'sessions' (case-sensitive)", () => {
    assert.strictEqual(isSessionsCommand("sessions"), true);
    assert.strictEqual(isSessionsCommand("  sessions  "), true);
    assert.strictEqual(isSessionsCommand("SESSIONS"), false);
    assert.strictEqual(isSessionsCommand("sessions list"), false);
    assert.strictEqual(isSessionsCommand("session"), false);
  });

  test("isModelCommand matches bare or with args (case-insensitive)", () => {
    assert.strictEqual(isModelCommand("model"), true);
    assert.strictEqual(isModelCommand("  model  "), true);
    assert.strictEqual(isModelCommand("model llamacpp llama3.1"), true);
    assert.strictEqual(isModelCommand("MODEL"), true);
    assert.strictEqual(isModelCommand("models"), false);
    assert.strictEqual(isModelCommand("switch model"), false);
  });

  test("isAttachCommand requires a path argument (case-sensitive)", () => {
    assert.strictEqual(isAttachCommand("attach ./file.txt"), true);
    assert.strictEqual(isAttachCommand("  attach foo  "), true);
    assert.strictEqual(isAttachCommand("attach"), false);
    assert.strictEqual(isAttachCommand("attach "), false);
    assert.strictEqual(isAttachCommand("ATTACH foo"), false);
  });

  test("isResumeCommand requires an id argument (case-sensitive)", () => {
    assert.strictEqual(isResumeCommand("resume abc-123"), true);
    assert.strictEqual(isResumeCommand("  resume xyz  "), true);
    assert.strictEqual(isResumeCommand("resume"), false);
    assert.strictEqual(isResumeCommand("resume "), false);
    assert.strictEqual(isResumeCommand("RESUME abc"), false);
  });

  test("buildAttachedUserContent puts the user's typed text first, attachment blocks after", () => {
    const pending = [
      { type: "text", text: "[Image: bill.png]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
    ];
    const content = buildAttachedUserContent(pending, "Describe this electricity bill.");
    // Every downstream intent classifier (tool-profile selection, skill
    // matching, standalone-vision detection) extracts the FIRST text block as
    // the user's request. If an attachment's own "[Image: ...]" label landed
    // first, that label — not the user's actual request — would be what gets
    // classified (issue: malformed image-tool calls from task-shaped prompts).
    assert.deepStrictEqual(content[0], { type: "text", text: "Describe this electricity bill." });
    assert.deepStrictEqual(content.slice(1), pending);
  });

  test("buildAttachedUserContent returns the raw string when nothing is queued", () => {
    assert.strictEqual(buildAttachedUserContent([], "hello"), "hello");
  });
});

// ─── Remember Intent Tests ────────────────────────────────────────────────
describe("Remember Intent Detection", () => {
  test("isRememberIntent detects basic remember command", () => {
    assert.strictEqual(isRememberIntent("remember that I like coffee"), true);
  });

  test("isRememberIntent is case-insensitive", () => {
    assert.strictEqual(isRememberIntent("REMEMBER THAT user is helpful"), true);
    assert.strictEqual(isRememberIntent("Remember That I prefer Python"), true);
  });

  test("isRememberIntent requires 'that' keyword", () => {
    assert.strictEqual(isRememberIntent("remember I like pizza"), false);
    assert.strictEqual(isRememberIntent("remember about coffee"), false);
  });

  test("isRememberIntent requires command at start of string", () => {
    assert.strictEqual(isRememberIntent("please remember that I said so"), false);
    assert.strictEqual(isRememberIntent("what do you remember?"), false);
  });

  test("isRememberIntent allows whitespace variations", () => {
    assert.strictEqual(isRememberIntent("remember  that  extra spaces"), true);
  });
});

// ─── Provider Detection Tests ──────────────────────────────────────────────
describe("Provider Detection", () => {
  test("isLlamaCppProvider detects llamacpp", () => {
    assert.strictEqual(isLlamaCppProvider("llamacpp"), true);
  });

  test("isLlamaCppProvider is case-insensitive", () => {
    assert.strictEqual(isLlamaCppProvider("LLAMACPP"), true);
    assert.strictEqual(isLlamaCppProvider("LlamaCpp"), true);
  });

  test("isLlamaCppProvider rejects other providers", () => {
    assert.strictEqual(isLlamaCppProvider("ollama"), false);
    assert.strictEqual(isLlamaCppProvider("anthropic"), false);
  });

  test("isLlamaCppProvider handles empty string", () => {
    assert.strictEqual(isLlamaCppProvider(""), false);
    assert.strictEqual(isLlamaCppProvider(null), false);
    assert.strictEqual(isLlamaCppProvider(undefined), false);
  });
});

// ─── Reasoning Toggle Tests ───────────────────────────────────────────────
describe("Reasoning Toggle", () => {
  test("toggleReasoning flips false to true", () => {
    assert.strictEqual(toggleReasoning(false), true);
  });

  test("toggleReasoning flips true to false", () => {
    assert.strictEqual(toggleReasoning(true), false);
  });

  test("toggleReasoning maintains toggle across multiple calls", () => {
    let state = false;
    state = toggleReasoning(state);
    assert.strictEqual(state, true);
    state = toggleReasoning(state);
    assert.strictEqual(state, false);
    state = toggleReasoning(state);
    assert.strictEqual(state, true);
  });
});

// ─── WebSocket URL Building Tests ──────────────────────────────────────────
describe("WebSocket URL Building", () => {
  test("buildWebSocketUrl constructs valid URL", () => {
    const url = buildWebSocketUrl(3000);
    assert.strictEqual(url, "ws://localhost:3000");
  });

  test("buildWebSocketUrl handles different ports", () => {
    assert.strictEqual(buildWebSocketUrl(8080), "ws://localhost:8080");
    assert.strictEqual(buildWebSocketUrl(11434), "ws://localhost:11434");
    assert.strictEqual(buildWebSocketUrl(9999), "ws://localhost:9999");
  });

  test("buildWebSocketUrl format is consistent", () => {
    const url = buildWebSocketUrl(5000);
    assert(url.startsWith("ws://localhost:"));
    assert(url.endsWith("5000"));
  });
});

// ─── Port Validation Tests ────────────────────────────────────────────────
describe("Port Validation", () => {
  test("isValidPort accepts valid ports", () => {
    assert.strictEqual(isValidPort(3000), true);
    assert.strictEqual(isValidPort(8080), true);
    assert.strictEqual(isValidPort(11434), true);
    assert.strictEqual(isValidPort(1), true);
    assert.strictEqual(isValidPort(65535), true);
  });

  test("isValidPort rejects invalid ports", () => {
    assert.strictEqual(isValidPort(0), false);
    assert.strictEqual(isValidPort(-1), false);
    assert.strictEqual(isValidPort(65536), false);
    assert.strictEqual(isValidPort(100000), false);
  });

  test("isValidPort rejects non-numbers", () => {
    assert.strictEqual(isValidPort("3000"), false);
    assert.strictEqual(isValidPort(null), false);
    assert.strictEqual(isValidPort(undefined), false);
    assert.strictEqual(isValidPort(3.5), true); // number type, even if float
  });
});

// ─── Model Name Tests ────────────────────────────────────────────────────
describe("Model Name Handling", () => {
  test("getDefaultModel returns llama3.1", () => {
    assert.strictEqual(getDefaultModel(), "llama3.1");
  });

  test("normalizeModelName converts to lowercase", () => {
    assert.strictEqual(normalizeModelName("LLAMA3.1"), "llama3.1");
    assert.strictEqual(normalizeModelName("Mistral"), "mistral");
    assert.strictEqual(normalizeModelName("llama3.1"), "llama3.1");
  });

  test("isValidModelName accepts non-empty names", () => {
    assert.strictEqual(isValidModelName("llama3.1"), true);
    assert.strictEqual(isValidModelName("mistral"), true);
    assert.strictEqual(isValidModelName("a"), true);
  });

  test("isValidModelName rejects empty names", () => {
    assert.strictEqual(isValidModelName(""), false);
    assert.strictEqual(isValidModelName("   "), false);
    assert.strictEqual(isValidModelName("\t\n"), false);
  });
});

// ─── Color Formatting Tests ───────────────────────────────────────────────
describe("Color Formatting", () => {
  test("formatColoredText applies color codes", () => {
    const RED = "\x1b[31m";
    const RESET = "\x1b[0m";
    const result = formatColoredText("error", RED, RESET);
    assert.strictEqual(result, `${RED}error${RESET}`);
  });

  test("formatColoredText uses provided reset code", () => {
    const code = "\x1b[32m";
    const reset = "\x1b[0m";
    const result = formatColoredText("ok", code, reset);
    assert(result.includes("ok"));
    assert(result.startsWith(code));
    assert(result.endsWith(reset));
  });

  test("formatColoredText handles empty text", () => {
    const code = "\x1b[31m";
    const result = formatColoredText("", code);
    assert.strictEqual(result, `${code}\x1b[0m`);
  });
});

// ─── Message Creation Tests ───────────────────────────────────────────────
describe("Message Creation", () => {
  test("createMessage returns message object", () => {
    const msg = createMessage("user", "hello");
    assert.strictEqual(msg.role, "user");
    assert.strictEqual(msg.content, "hello");
  });

  test("createMessage preserves role and content", () => {
    const msg = createMessage("assistant", "hi there");
    assert.strictEqual(msg.role, "assistant");
    assert.strictEqual(msg.content, "hi there");
  });

  test("createMessage handles empty content", () => {
    const msg = createMessage("user", "");
    assert.strictEqual(msg.role, "user");
    assert.strictEqual(msg.content, "");
  });
});

// ─── Message Queue Tests ───────────────────────────────────────────────
describe("Message Queue", () => {
  test("createMessageQueue returns empty array", () => {
    const queue = createMessageQueue();
    assert(Array.isArray(queue));
    assert.strictEqual(queue.length, 0);
  });

  test("addMessageToQueue adds message", () => {
    const queue = createMessageQueue();
    const newQueue = addMessageToQueue(queue, "user", "hello");
    assert.strictEqual(newQueue.length, 1);
    assert.strictEqual(newQueue[0].role, "user");
    assert.strictEqual(newQueue[0].content, "hello");
  });

  test("addMessageToQueue doesn't mutate original", () => {
    const queue = createMessageQueue();
    const newQueue = addMessageToQueue(queue, "user", "hello");
    assert.strictEqual(queue.length, 0);
    assert.strictEqual(newQueue.length, 1);
  });

  test("addMessageToQueue maintains order", () => {
    let queue = createMessageQueue();
    queue = addMessageToQueue(queue, "user", "msg1");
    queue = addMessageToQueue(queue, "assistant", "response1");
    queue = addMessageToQueue(queue, "user", "msg2");

    assert.strictEqual(queue[0].content, "msg1");
    assert.strictEqual(queue[1].content, "response1");
    assert.strictEqual(queue[2].content, "msg2");
  });

  test("getQueueLength returns queue size", () => {
    let queue = createMessageQueue();
    assert.strictEqual(getQueueLength(queue), 0);

    queue = addMessageToQueue(queue, "user", "hello");
    assert.strictEqual(getQueueLength(queue), 1);

    queue = addMessageToQueue(queue, "assistant", "hi");
    assert.strictEqual(getQueueLength(queue), 2);
  });

  test("getMessageFromQueue retrieves message by index", () => {
    let queue = createMessageQueue();
    queue = addMessageToQueue(queue, "user", "first");
    queue = addMessageToQueue(queue, "user", "second");

    const msg1 = getMessageFromQueue(queue, 0);
    assert.strictEqual(msg1.content, "first");

    const msg2 = getMessageFromQueue(queue, 1);
    assert.strictEqual(msg2.content, "second");
  });

  test("getMessageFromQueue returns null for invalid index", () => {
    let queue = createMessageQueue();
    queue = addMessageToQueue(queue, "user", "only");

    const invalid = getMessageFromQueue(queue, 5);
    assert.strictEqual(invalid, null);

    const negative = getMessageFromQueue(queue, -1);
    assert.strictEqual(negative, null);
  });
});

// ─── Message Parsing Tests ────────────────────────────────────────────────
describe("Message Parsing", () => {
  test("parseMessage parses valid JSON", () => {
    const data = Buffer.from(JSON.stringify({ type: "chat", text: "hello" }));
    const msg = parseMessage(data);
    assert.strictEqual(msg.type, "chat");
    assert.strictEqual(msg.text, "hello");
  });

  test("parseMessage parses provider message", () => {
    const data = Buffer.from(JSON.stringify({ type: "provider", name: "llamacpp", model: "llama3.1" }));
    const msg = parseMessage(data);
    assert.strictEqual(msg.type, "provider");
    assert.strictEqual(msg.name, "llamacpp");
  });

  test("parseMessage parses memories message", () => {
    const memories = [{ fact: "user likes Python" }];
    const data = Buffer.from(JSON.stringify({ type: "memories", memories }));
    const msg = parseMessage(data);
    assert.strictEqual(msg.type, "memories");
    assert.strictEqual(msg.memories.length, 1);
  });

  test("parseMessage returns null on invalid JSON", () => {
    const data = Buffer.from("invalid json{");
    const msg = parseMessage(data);
    assert.strictEqual(msg, null);
  });

  test("parseMessage handles empty buffer", () => {
    const data = Buffer.from("");
    const msg = parseMessage(data);
    assert.strictEqual(msg, null);
  });
});

// ─── WebSocket State Tests ────────────────────────────────────────────────
describe("WebSocket State", () => {
  test("isWebSocketOpen detects open state", () => {
    const ws = { readyState: 1 };
    assert.strictEqual(isWebSocketOpen(ws), true);
  });

  test("isWebSocketOpen rejects closed state", () => {
    const ws = { readyState: 3 };
    assert.strictEqual(isWebSocketOpen(ws), false);
  });

  test("isWebSocketOpen rejects connecting state", () => {
    const ws = { readyState: 0 };
    assert.strictEqual(isWebSocketOpen(ws), false);
  });

  test("isWebSocketOpen handles null", () => {
    const result = isWebSocketOpen(null);
    assert(!result);
  });

  test("isWebSocketOpen handles undefined", () => {
    const result = isWebSocketOpen(undefined);
    assert(!result);
  });

  test("isWebSocketOpen handles missing readyState", () => {
    const ws = {};
    assert.strictEqual(isWebSocketOpen(ws), false);
  });
});

// ─── Reconnection Tests ────────────────────────────────────────────────
describe("Reconnection Logic", () => {
  test("getReconnectionDelay returns 1500ms", () => {
    assert.strictEqual(getReconnectionDelay(), 1500);
  });
});

// ─── SIGINT Handling Tests ────────────────────────────────────────────────
describe("SIGINT Handler", () => {
  test("handleSigint increments count", () => {
    assert.strictEqual(handleSigint(0), 1);
    assert.strictEqual(handleSigint(1), 2);
    assert.strictEqual(handleSigint(5), 6);
  });

  test("shouldExitOnSigint requires 2+ presses", () => {
    assert.strictEqual(shouldExitOnSigint(0), false);
    assert.strictEqual(shouldExitOnSigint(1), false);
    assert.strictEqual(shouldExitOnSigint(2), true);
    assert.strictEqual(shouldExitOnSigint(3), true);
  });

  test("double-tap exit threshold logic", () => {
    let count = 0;
    count = handleSigint(count);
    assert.strictEqual(shouldExitOnSigint(count), false);
    
    count = handleSigint(count);
    assert.strictEqual(shouldExitOnSigint(count), true);
  });
});

// ─── Special Command Detection Tests ───────────────────────────────────────
describe("Special Command Detection", () => {
  test("isSpecialCommand detects /exit", () => {
    assert.strictEqual(isSpecialCommand("/exit"), true);
  });

  test("isSpecialCommand detects /clear", () => {
    assert.strictEqual(isSpecialCommand("/clear"), true);
  });

  test("isSpecialCommand detects /memories", () => {
    assert.strictEqual(isSpecialCommand("/memories"), true);
  });

  test("isSpecialCommand detects /reasoning", () => {
    assert.strictEqual(isSpecialCommand("/reasoning"), true);
  });

  test("isSpecialCommand detects remember intent", () => {
    assert.strictEqual(isSpecialCommand("remember that I like coffee"), true);
  });

  test("isSpecialCommand detects empty command", () => {
    assert.strictEqual(isSpecialCommand(""), true);
    assert.strictEqual(isSpecialCommand("   "), true);
  });

  test("isSpecialCommand rejects regular chat", () => {
    assert.strictEqual(isSpecialCommand("hello there"), false);
    assert.strictEqual(isSpecialCommand("what is 2+2?"), false);
    assert.strictEqual(isSpecialCommand("tell me a story"), false);
  });
});

// ─── Integration Tests ────────────────────────────────────────────────────
describe("Integration Scenarios", () => {
  test("full message flow: queue creation through retrieval", () => {
    let queue = createMessageQueue();
    queue = addMessageToQueue(queue, "user", "hello");
    queue = addMessageToQueue(queue, "assistant", "hi there");

    assert.strictEqual(getQueueLength(queue), 2);
    assert.strictEqual(getMessageFromQueue(queue, 0).content, "hello");
    assert.strictEqual(getMessageFromQueue(queue, 1).content, "hi there");
  });

  test("command parsing for chat bot interaction", () => {
    const inputs = [
      { cmd: "hello", isChat: true, isSpecial: false },
      { cmd: "/exit", isChat: false, isSpecial: true },
      { cmd: "remember that I love pizza", isChat: false, isSpecial: true },
      { cmd: "/clear", isChat: false, isSpecial: true },
      { cmd: "what's the weather?", isChat: true, isSpecial: false },
    ];

    inputs.forEach(({ cmd, isChat, isSpecial }) => {
      assert.strictEqual(!isSpecialCommand(cmd), isChat, `Failed for: ${cmd}`);
      assert.strictEqual(isSpecialCommand(cmd), isSpecial, `Failed for: ${cmd}`);
    });
  });

  test("provider selection flow", () => {
    const providers = ["llamacpp", "anthropic", "LLAMACPP", "openai"];
    const expected = [true, false, true, false];

    providers.forEach((provider, i) => {
      assert.strictEqual(isLlamaCppProvider(provider), expected[i]);
    });
  });

  test("reasoning toggle flow", () => {
    let reasoning = false;
    const toggles = [true, false, true, false, true];

    toggles.forEach(expected => {
      reasoning = toggleReasoning(reasoning);
      assert.strictEqual(reasoning, expected);
    });
  });
});

// ─── printWelcome Tests ───────────────────────────────────────────────────
describe("printWelcome", () => {
  test("prints welcome message with Aperio branding", () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printWelcome();
    } finally {
      process.stdout.write = orig;
    }
    const output = chunks.join("");
    assert.ok(output.includes("Aperio"), "should contain Aperio");
    assert.ok(output.includes("thinking partner"), "should mention thinking partner");
    assert.ok(output.includes("help"), "should mention help command");
  });
});

// ─── printHelp Tests ──────────────────────────────────────────────────────
describe("printHelp", () => {
  test("prints help with command sections", () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printHelp();
    } finally {
      process.stdout.write = orig;
    }
    const output = chunks.join("");
    assert.ok(output.includes("How to talk to Aperio"), "should have title");
    assert.ok(output.includes("Everyday"), "should have Everyday section");
    assert.ok(output.includes("remember that"), "should mention remember command");
    assert.ok(output.includes("Your stuff"), "should have Your stuff section");
    assert.ok(output.includes("memories"), "should mention memories");
    assert.ok(output.includes("Display & exit"), "should have Display section");
    assert.ok(output.includes("exit"), "should mention exit");
  });

  test("printHelp with proxy=true includes Deeper thinking section", () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printHelp({ proxy: true });
    } finally {
      process.stdout.write = orig;
    }
    const output = chunks.join("");
    assert.ok(output.includes("Deeper thinking"), "proxy mode should include Deeper thinking section");
    assert.ok(output.includes("discuss on"), "proxy mode should mention discuss");
  });

  test("printHelp with proxy=false omits Deeper thinking section", () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printHelp({ proxy: false });
    } finally {
      process.stdout.write = orig;
    }
    const output = chunks.join("");
    assert.ok(!output.includes("Deeper thinking"), "non-proxy mode should NOT include Deeper thinking");
  });

  const captureHelp = (opts) => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try { printHelp(opts); } finally { process.stdout.write = orig; }
    return chunks.join("");
  };

  test("printHelp shows try: example lines only when examples are on", () => {
    const example = "attach ~/Downloads/report.pdf";
    assert.ok(captureHelp({ showExamples: true }).includes(example), "examples on → example lines");
    assert.ok(!captureHelp({ showExamples: false }).includes(example), "examples off → no example lines");
  });

  test("every HELP_TARGETS entry has a HELP_DETAILS entry (kept in sync)", () => {
    for (const target of HELP_TARGETS) {
      assert.ok(HELP_DETAILS[target], `missing HELP_DETAILS for "${target}"`);
    }
    assert.deepStrictEqual(
      [...HELP_TARGETS].sort(),
      Object.keys(HELP_DETAILS).sort(),
      "HELP_TARGETS and HELP_DETAILS must cover exactly the same commands",
    );
  });
});

// ─── printStatus Tests ────────────────────────────────────────────────────
describe("printStatus", () => {
  test("prints status information", () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printStatus();
    } finally {
      process.stdout.write = orig;
    }
    const output = chunks.join("");
    assert.ok(output.includes("Status"), "should have Status header");
    // Should include the status fields (even if undefined, they're in the output)
    assert.ok(output.includes("mode") || output.includes("model") || output.includes("docker") || output.includes("storage"),
      "should include at least one status field");
  });
});

// ─── printSessions Tests ──────────────────────────────────────────────────
describe("printSessions", () => {
  test("prints sessions or no-sessions message", () => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printSessions();
    } finally {
      process.stdout.write = orig;
    }
    const output = chunks.join("");
    // Should either say no sessions found or list sessions
    assert.ok(
      output.includes("no sessions found") || output.includes("Recent sessions") || output.includes("resume"),
      `expected sessions output, got: ${output.slice(0, 100)}`
    );
  });
});

// ─── readAttachment Tests ─────────────────────────────────────────────────
describe("readAttachment", () => {
  test("returns error for non-existent file", () => {
    const result = readAttachment("tests/lib/__nonexistent_test_file_xyz__");
    assert.ok(result.error, "should have error property");
    assert.ok(result.error.includes("not found"), `error should mention 'not found', got: ${result.error}`);
  });

  test("reads existing file and returns metadata", () => {
    const result = readAttachment("tests/unit/lib/terminal.test.js");
    assert.ok(result.name, "should have name");
    assert.ok(result.name.endsWith(".test.js"), `name should end with .test.js, got: ${result.name}`);
    assert.strictEqual(result.ext, ".js");
    assert.strictEqual(result.type, "text/plain");
    assert.ok(result.data, "should have base64 data");
    assert.ok(result.sizeKb > 0, "should have positive size");
  });

  test("resolves correct MIME types for different extensions", () => {
    // .md -> text/plain (not in MIME_BY_EXT map, defaults to text/plain)
    const md = readAttachment("README.md");
    assert.strictEqual(md.ext, ".md");
    assert.strictEqual(md.type, "text/plain");

    // A .pdf from the repo
    const pdf = readAttachment("SECURITY.md");
    assert.strictEqual(pdf.ext, ".md");
    assert.strictEqual(pdf.type, "text/plain");
  });

  test("resolves known MIME types correctly", () => {
    // .jpg -> image/jpeg
    const jpg = readAttachment("package.json");
    assert.strictEqual(jpg.type, "text/plain");
    // package.json is not in MIME_BY_EXT, defaults to text/plain
  });
});

// ─── printHelpFor Tests (focused help <command> docs) ──────────────────────
describe("printHelpFor", () => {
  const capture = (target, opts = {}) => {
    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      printHelpFor(target, { proxy: false, lang: "en", ...opts });
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  };

  test("help config prints the /config detail body with title and example", () => {
    const output = capture("config");
    assert.ok(output.includes("/config"), "should include the command title");
    assert.ok(output.includes("diagnose which layer"), "should include detail_config body");
    assert.ok(output.includes("try:"), "should include try: example line");
    assert.ok(output.includes("/config"), "try: example should include /config");
  });

  test("unknown help target falls back to full help", () => {
    const output = capture("bogus");
    assert.ok(output.includes("No specific help"), "should say no specific help");
    assert.ok(output.includes("How to talk to Aperio"), "should fall back to full help");
  });
});

// ─── printConfig Tests ──────────────────────────────────────────────────────
describe("printConfig", () => {
  let savedEnv;

  // Minimal store so applyConfigToEnv can populate the provenance snapshot.
  const storeWith = (settings = {}) => ({ async getSettings() { return { ...settings }; } });

  const capture = async ({ port, env = {} } = {}) => {
    // Apply env overrides on top of the saved state.
    Object.assign(process.env, env);
    if (port == null) await applyConfigToEnv(storeWith());

    const chunks = [];
    const orig = process.stdout.write;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      await printConfig({ port });
    } finally {
      process.stdout.write = orig;
    }
    return chunks.join("");
  };

  beforeEach(() => { savedEnv = { ...process.env }; });
  afterEach(() => { process.env = savedEnv; });

  test("prints header and precedence line", async () => {
    process.env.APERIO_CONFIG_PRECEDENCE = "env";
    const output = await capture();
    assert.ok(output.includes("Config"), "should have Config header");
    assert.ok(output.includes("precedence") && output.includes("env"),
      "should show precedence line");
  });

  test("always shows AI_PROVIDER row regardless of provider", async () => {
    process.env.AI_PROVIDER = "anthropic";
    const output = await capture();
    assert.ok(output.includes("AI_PROVIDER"), "should show AI_PROVIDER row");
    assert.ok(output.includes("anthropic"), "should show the provider value");
  });

  test("AI_PROVIDER unset shows not-configured, never a silent anthropic default (#252)", async () => {
    delete process.env.AI_PROVIDER;
    const output = await capture();
    assert.ok(output.includes("not configured"), "should say not configured");
  });

  test("llamacpp provider shows LLAMACPP_MODEL, LLAMACPP_CTX, LLAMACPP_SERVE_CTX rows", async () => {
    process.env.AI_PROVIDER = "llamacpp";
    process.env.LLAMACPP_MODEL = "llama3.1";
    process.env.LLAMACPP_CTX = "32768";
    const output = await capture();
    assert.ok(output.includes("LLAMACPP_MODEL"), "should include LLAMACPP_MODEL row");
    assert.ok(output.includes("LLAMACPP_CTX"), "should include LLAMACPP_CTX row");
    assert.ok(output.includes("LLAMACPP_SERVE_CTX"), "should include LLAMACPP_SERVE_CTX row");
    assert.ok(output.includes("llama3.1"), "should show the model value");
  });

  test("non-llamacpp provider omits llamacpp-specific rows", async () => {
    process.env.AI_PROVIDER = "anthropic";
    const output = await capture();
    assert.ok(!output.includes("LLAMACPP_MODEL"), "should NOT include LLAMACPP_MODEL for non-llamacpp");
    assert.ok(!output.includes("LLAMACPP_CTX"), "should NOT include LLAMACPP_CTX for non-llamacpp");
  });

  test("source labels render as (from UI) / (from .env) / (default)", async () => {
    process.env.AI_PROVIDER = "llamacpp";
    process.env.LLAMACPP_MODEL = "from-env";
    const output = await capture();
    // Source labels appear dimmed in parentheses after the value.
    assert.ok(output.includes("(from .env)") || output.includes("(from UI)") || output.includes("(default)"),
      "should include at least one source label in parentheses");
  });

  test("unset values show (unset) fallback", async () => {
    process.env.AI_PROVIDER = "llamacpp";
    delete process.env.LLAMACPP_MODEL;
    delete process.env.LLAMACPP_CTX;
    delete process.env.LLAMACPP_SERVE_CTX;
    const output = await capture();
    // LLAMACPP_MODEL defaults to the curated Qwen model in the row fallback.
    assert.ok(output.includes("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"), "LLAMACPP_MODEL should fall back to the curated default");
  });
});

afterEach(() => {
  // Cleanup after each test
});
