/**
 * chat.test.js — Unit tests for lib/chat.js
 *
 * Tests the exported utility functions from the refactored chat module.
 * This file imports and exercises the actual code in chat.js to achieve coverage.
 */

import assert from "assert";
import { describe, test, afterEach, after } from "node:test";
import { setupSecureTestEnvironment } from "../helpers/sandbox.js";

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
  isOllamaProvider,
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
} from "../../lib/terminal.js";

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
  test("isOllamaProvider detects ollama", () => {
    assert.strictEqual(isOllamaProvider("ollama"), true);
  });

  test("isOllamaProvider is case-insensitive", () => {
    assert.strictEqual(isOllamaProvider("OLLAMA"), true);
    assert.strictEqual(isOllamaProvider("Ollama"), true);
    assert.strictEqual(isOllamaProvider("OlLaMa"), true);
  });

  test("isOllamaProvider rejects other providers", () => {
    assert.strictEqual(isOllamaProvider("anthropic"), false);
    assert.strictEqual(isOllamaProvider("openai"), false);
    assert.strictEqual(isOllamaProvider("mistral"), false);
  });

  test("isOllamaProvider handles empty string", () => {
    assert.strictEqual(isOllamaProvider(""), false);
    assert.strictEqual(isOllamaProvider(null), false);
    assert.strictEqual(isOllamaProvider(undefined), false);
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
    const data = Buffer.from(JSON.stringify({ type: "provider", name: "ollama", model: "llama3.1" }));
    const msg = parseMessage(data);
    assert.strictEqual(msg.type, "provider");
    assert.strictEqual(msg.name, "ollama");
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
  test("isSpecialCommand detects exit", () => {
    assert.strictEqual(isSpecialCommand("exit"), true);
  });

  test("isSpecialCommand detects clear", () => {
    assert.strictEqual(isSpecialCommand("clear"), true);
  });

  test("isSpecialCommand detects memories", () => {
    assert.strictEqual(isSpecialCommand("memories"), true);
  });

  test("isSpecialCommand detects reasoning", () => {
    assert.strictEqual(isSpecialCommand("reasoning"), true);
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
      { cmd: "exit", isChat: false, isSpecial: true },
      { cmd: "remember that I love pizza", isChat: false, isSpecial: true },
      { cmd: "clear", isChat: false, isSpecial: true },
      { cmd: "what's the weather?", isChat: true, isSpecial: false },
    ];

    inputs.forEach(({ cmd, isChat, isSpecial }) => {
      assert.strictEqual(!isSpecialCommand(cmd), isChat, `Failed for: ${cmd}`);
      assert.strictEqual(isSpecialCommand(cmd), isSpecial, `Failed for: ${cmd}`);
    });
  });

  test("provider selection flow", () => {
    const providers = ["ollama", "anthropic", "OLLAMA", "openai"];
    const expected = [true, false, true, false];

    providers.forEach((provider, i) => {
      assert.strictEqual(isOllamaProvider(provider), expected[i]);
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

afterEach(() => {
  // Cleanup after each test
});