#!/usr/bin/env node
/**
 * lib/chat.js — Aperio terminal chat (REFACTORED FOR TESTING)
 *
 * Auto-detects whether an Aperio server is already running.
 *   PROXY      → server found on SERVER_PORT → thin WebSocket client
 *   STANDALONE → no server → boots agent directly via lib/agent.js
 *
 * Pure utilities live in chat-utils.js (imported below) so they can be
 * unit-tested and covered by c8 independently of this entry-point.
 *
 * Set DEBUG=1 to see raw stderr from sub-processes.
 */

import { WebSocket }                   from "ws";
import { createInterface }             from "readline";
import { fileURLToPath }               from "url";
import { dirname, resolve }            from "path";
import { createRequire }               from "module";
import { spawn, execSync }             from "child_process";
import { existsSync }                  from "fs";
import dotenv                          from "dotenv";
import { createAgent }                 from "./agent.js";
import { makeCliEmitter }              from "./assets/cliEmitter.js";
import { isDockerAvailable }           from "../db/index.js";

import {
  // ANSI
  R, BOLD, DIM, CYAN, GRAY, GREEN, YELLOW, RED,
  RESET_SCROLL, HEADER_LINES,
  moveTo,
  // header
  initDockerState,
  setScrollArea, redrawHeader,
  initHeader, setHeaderStatus,
  updateHeaderModel, updateHeaderReasoning,
  // spinner
  startSpinner, stopSpinner,
  // readline helpers
  ask, printQ,
  // port / process
  isPortOpen, pidsOnPort, killPids,
  // ollama
  ollamaHealthy, listOllamaModels, resolveModelChoice,
  // server probe
  probeServer,
  // memory display
  printMemories,
  // misc
  detectMightThink, makeStderrShim,
  parseServerPort, parseOllamaPort,
} from "../lib/assets/chat-utils.js";

// ─── Suppress subprocess stderr noise ────────────────────────────────────────
if (!process.env.DEBUG) {
  process.stderr.write = makeStderrShim();
}

const require   = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const envPath   = existsSync(resolve(ROOT, ".env"))
  ? resolve(ROOT, ".env")
  : resolve(ROOT, ".env.example");

dotenv.config({ path: envPath });

const { version } = require(resolve(ROOT, "package.json"));

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_PORT = parseServerPort(process.env);
const OLLAMA_PORT = parseOllamaPort(process.env);

// ─── Seed docker state into chat-utils module-level vars ─────────────────────
const _dockerOn = isDockerAvailable();
initDockerState(_dockerOn);

// ─── Ollama base URL helper (needs resolved OLLAMA_PORT) ─────────────────────
const OLLAMA_BASE = () => process.env.OLLAMA_BASE_URL || `http://localhost:${OLLAMA_PORT}`;

// ─── EXPORTED UTILITY FUNCTIONS FOR TESTING ─────────────────────────────────

/**
 * Determines if a command string is empty
 */
export function isEmptyCommand(cmd) {
  return !cmd.trim();
}

/**
 * Determines if a command is the 'exit' command
 */
export function isExitCommand(cmd) {
  return cmd.trim() === "exit";
}

/**
 * Determines if a command is the 'clear' command
 */
export function isClearCommand(cmd) {
  return cmd.trim() === "clear";
}

/**
 * Determines if a command is the 'memories' command
 */
export function isMemoriesCommand(cmd) {
  return cmd.trim() === "memories";
}

/**
 * Determines if a command is the 'reasoning' command
 */
export function isReasoningCommand(cmd) {
  return cmd.trim() === "reasoning";
}

/**
 * Determines if a command is a "remember that" intent
 */
export function isRememberIntent(cmd) {
  return /^remember\s+that\b/i.test(cmd);
}

/**
 * Checks if provider is ollama (case-insensitive)
 */
export function isOllamaProvider(providerName) {
  return (providerName || "").toLowerCase() === "ollama";
}

/**
 * Toggles reasoning visibility
 */
export function toggleReasoning(currentState) {
  return !currentState;
}

/**
 * Constructs WebSocket URL from port
 */
export function buildWebSocketUrl(port) {
  return `ws://localhost:${port}`;
}

/**
 * Validates port number
 */
export function isValidPort(port) {
  return typeof port === "number" && port > 0 && port < 65536;
}

/**
 * Gets default model name
 */
export function getDefaultModel() {
  return "llama3.1";
}

/**
 * Normalizes model name to lowercase
 */
export function normalizeModelName(name) {
  return name.toLowerCase();
}

/**
 * Validates model name is not empty
 */
export function isValidModelName(name) {
  return name.trim().length > 0;
}

/**
 * Formats ANSI colored text
 */
export function formatColoredText(text, colorCode, resetCode = "\x1b[0m") {
  return `${colorCode}${text}${resetCode}`;
}

/**
 * Creates a message object for the queue
 */
export function createMessage(role, content) {
  return { role, content };
}

/**
 * Adds a message to queue and returns new queue
 */
export function addMessageToQueue(messages, role, content) {
  return [...messages, createMessage(role, content)];
}

/**
 * Parses JSON message safely
 */
export function parseMessage(data) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    return null;
  }
}

/**
 * Checks if WebSocket is open
 */
export function isWebSocketOpen(ws) {
  return !!(ws && ws.readyState === 1);
}

/**
 * Gets reconnection delay in milliseconds
 */
export function getReconnectionDelay() {
  return 1500;
}

/**
 * Handles SIGINT counter logic
 */
export function handleSigint(currentCount) {
  return currentCount + 1;
}

/**
 * Checks if double-tap exit threshold is met (requires 2+ presses)
 */
export function shouldExitOnSigint(count) {
  return count >= 2;
}

/**
 * Checks if command is a special command (not regular chat)
 */
export function isSpecialCommand(cmd) {
  const trimmed = cmd.trim();
  return (
    isEmptyCommand(cmd) ||
    isExitCommand(trimmed) ||
    isClearCommand(trimmed) ||
    isMemoriesCommand(trimmed) ||
    isReasoningCommand(trimmed) ||
    isRememberIntent(trimmed)
  );
}

/**
 * Creates an empty message queue
 */
export function createMessageQueue() {
  return [];
}

/**
 * Gets queue length
 */
export function getQueueLength(messages) {
  return messages.length;
}

/**
 * Gets message from queue by index
 */
export function getMessageFromQueue(messages, index) {
  return messages[index] || null;
}

// ─── ensureOllama — stays here because it needs createInterface + spawn ───────
async function ensureOllama() {
  if (await ollamaHealthy(OLLAMA_PORT)) return true;

  if (await isPortOpen(OLLAMA_PORT)) {
    const pids   = pidsOnPort(OLLAMA_PORT, execSync);
    const pidStr = pids.length ? ` ${DIM}(PID ${pids.join(", ")})${R}` : "";
    process.stdout.write(
      `\n${YELLOW}  ⚠  Port ${OLLAMA_PORT} is occupied${pidStr}${YELLOW} but ollama is not responding.${R}\n`
    );
    const tmpRl = createInterface({ input: process.stdin, output: process.stdout });
    const ans   = await new Promise(res =>
      tmpRl.question(`${GRAY}  Kill it and restart ollama? (Y/n) ${R}`, res)
    );
    tmpRl.close();
    if (ans.trim().toLowerCase() === "n") {
      process.stdout.write(`\n${RED}  Aborted.${R}\n\n`);
      return false;
    }
    if (pids.length) {
      process.stdout.write(`${GRAY}  Stopping PID ${pids.join(", ")}…${R}\n`);
      killPids(pids);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  process.stdout.write(`${GRAY}  Starting ollama serve…${R}\n`);
  const child = spawn("ollama", ["serve"], {
    detached: false,
    stdio:    ["ignore", "ignore", "ignore"],
  });
  child.on("error", err => {
    process.stdout.write(
      `\n${RED}  ✖ Could not start ollama: ${err.message}${R}\n` +
      `${DIM}  Is ollama installed? → https://ollama.com${R}\n\n`
    );
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 350));
    if (await ollamaHealthy(OLLAMA_PORT)) {
      process.stdout.write(`${GREEN}  ✓ ollama ready${R}\n\n`);
      return true;
    }
  }
  process.stdout.write(`${RED}  ✖ ollama did not become ready in time.${R}\n\n`);
  return false;
}

// ─── pickOllamaModel — stays here because it needs createInterface + spawn ────
async function pickOllamaModel(currentModel) {
  const installed = await listOllamaModels(OLLAMA_PORT);

  process.stdout.write(`\n${BOLD}  Select model${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(40)}${R}\n`);
  process.stdout.write(`  ${DIM}[0]${R}  ${CYAN}${currentModel}${R}  ${GRAY}(current)${R}\n`);

  const others = installed.filter(m => m !== currentModel);
  others.forEach((m, i) => {
    process.stdout.write(`  ${DIM}[${i + 1}]${R}  ${m}\n`);
  });

  const pullIdx = others.length + 1;
  process.stdout.write(`  ${DIM}[${pullIdx}]${R}  ${GRAY}Pull a different model…${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(40)}${R}\n`);

  const tmpRl  = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res =>
    tmpRl.question(`${GRAY}  Choice [0]: ${R}`, res)
  );
  tmpRl.close();

  const { action, model } = resolveModelChoice(answer, currentModel, others);

  if (action === "keep") { process.stdout.write("\n"); return currentModel; }

  if (action === "switch") { process.stdout.write("\n"); return model; }

  if (action === "pull") {
    const pullRl  = createInterface({ input: process.stdin, output: process.stdout });
    const rawName = await new Promise(res =>
      pullRl.question(`${GRAY}  Model name to pull (e.g. llama3.2): ${R}`, res)
    );
    pullRl.close();
    const modelName = rawName.trim();
    if (!modelName) { process.stdout.write("\n"); return currentModel; }

    process.stdout.write(`\n${GRAY}  Pulling ${modelName}…${R}\n`);
    await new Promise((resolve, reject) => {
      const child = spawn("ollama", ["pull", modelName], { stdio: "inherit" });
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      child.on("error", reject);
    }).catch(err => {
      process.stdout.write(`${RED}  Pull failed: ${err.message}${R}\n`);
    });

    process.stdout.write(`${GREEN}  ✓ ${modelName} ready${R}\n\n`);
    return modelName;
  }

  return currentModel;
}

// ─── Graceful Ctrl+C (double-tap to exit) ────────────────────────────────────
let _sigintCount = 0;
process.on("SIGINT", () => {
  _sigintCount++;
  if (_sigintCount === 1) {
    stopSpinner();
    process.stdout.write(`\n${GRAY}  Press Ctrl+C again to quit.${R}\n\n`);
    setTimeout(() => { _sigintCount = 0; }, 2000);
  } else {
    process.stdout.write(RESET_SCROLL);
    process.stdout.write(`${GRAY}  bye${R}\n`);
    process.exit(0);
  }
});
process.on("exit", () => { process.stdout.write(RESET_SCROLL); });

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — PROXY
// ══════════════════════════════════════════════════════════════════════════════
async function runProxy(port, initialReasoning) {
  let showReasoning = initialReasoning;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let ws;
  let _intentionalClose = false;
  let _reconnectTimer   = null;
  let pendingMemories   = false;
  let currentEmitter;

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning });
  }

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.on("open", () => {
      clearTimeout(_reconnectTimer);
      ws.send(JSON.stringify({ type: "init" }));
    });

    ws.on("close", () => {
      if (_intentionalClose) { process.stdout.write(RESET_SCROLL); process.exit(0); return; }
      stopSpinner();
      process.stdout.write(`\n${GRAY}  ⟳ disconnected — reconnecting…${R}\n`);
      _reconnectTimer = setTimeout(connect, 1500);
    });

    ws.on("error", () => {});

    ws.on("message", data => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "provider") {
        updateHeaderModel(`${msg.name} (${msg.model})`);
        return;
      }
      if (msg.type === "memories" && pendingMemories) {
        pendingMemories = false;
        stopSpinner();
        printMemories(msg.memories);
        promptUser();
        return;
      }
      currentEmitter.send(msg);
    });
  }

  initHeader(`proxy :${port}`, `${process.env.AI_PROVIDER} (${process.env.OLLAMA_MODEL})`, showReasoning);
  startSpinner("waking up");
  currentEmitter = makeEmitter();
  connect();

  function safeSend(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function promptUser() {
    currentEmitter = makeEmitter();
    printQ();

    rl.once("line", line => {
      const cmd = line.trim();
      if (!cmd) { promptUser(); return; }

      if (cmd === "exit") {
        _intentionalClose = true;
        process.stdout.write(RESET_SCROLL);
        console.log(`${GRAY}  bye${R}`);
        process.exit(0);
      }

      if (cmd === "clear") {
        process.stdout.write("\x1b[2J");
        setScrollArea();
        redrawHeader();
        process.stdout.write(moveTo(HEADER_LINES + 1) + "\n");
        promptUser();
        return;
      }

      if (cmd === "memories") {
        pendingMemories = true;
        safeSend({ type: "get_memories" });
        return;
      }

      if (cmd === "reasoning") {
        showReasoning = !showReasoning;
        updateHeaderReasoning(showReasoning);
        const label = showReasoning ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  reasoning: ${label}${R}\n\n`);
        promptUser();
        return;
      }

      startSpinner();
      safeSend({ type: "chat", text: cmd });
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — STANDALONE
// ══════════════════════════════════════════════════════════════════════════════
async function runStandalone(initialReasoning) {
  let showReasoning = initialReasoning;
  const isOllama = isOllamaProvider(process.env.AI_PROVIDER);

  if (isOllama) {
    const ready = await ensureOllama();
    if (!ready) process.exit(1);
    const currentModel = process.env.OLLAMA_MODEL || "llama3.1";
    const chosenModel  = await pickOllamaModel(currentModel);
    if (chosenModel !== currentModel) process.env.OLLAMA_MODEL = chosenModel;
  }

  let agent;
  try {
    agent = await createAgent({ root: ROOT, version, clientName: "aperio-chat-cli" });
  } catch (e) {
    process.stdout.write(`${RED}  failed to start agent: ${e.message}${R}\n`);
    process.exit(1);
  }

  const { runAgentLoop, handleRememberIntent, fetchMemories, buildGreeting, OLLAMA_NO_TOOLS, provider } = agent;

  initHeader("standalone", `${provider.name} (${provider.model})`, showReasoning);

  const rl       = createInterface({ input: process.stdin, output: process.stdout });
  const messages = [];

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning });
  }

  function promptUser() {
    printQ();
    rl.once("line", async line => {
      const cmd = line.trim();
      if (!cmd) { promptUser(); return; }

      if (cmd === "exit") {
        process.stdout.write(RESET_SCROLL);
        console.log(`${GRAY}  bye${R}`);
        process.exit(0);
      }

      if (cmd === "clear") {
        process.stdout.write("\x1b[2J");
        setScrollArea();
        redrawHeader();
        process.stdout.write(moveTo(HEADER_LINES + 1) + "\n");
        promptUser();
        return;
      }

      if (cmd === "memories") {
        try   { const { parsed } = await fetchMemories(); console.log(); printMemories(parsed); }
        catch { console.log(`${GRAY}  no memories${R}\n`); }
        promptUser();
        return;
      }

      if (cmd === "reasoning") {
        showReasoning = !showReasoning;
        updateHeaderReasoning(showReasoning);
        const label = showReasoning ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  reasoning: ${label}${R}\n\n`);
        promptUser();
        return;
      }

      messages.push({ role: "user", content: cmd });
      startSpinner();

      if (OLLAMA_NO_TOOLS && isRememberIntent(cmd)) {
        await handleRememberIntent(cmd, makeEmitter());
        promptUser();
        return;
      }

      try   { await runAgentLoop(messages, makeEmitter()); }
      catch (e) { stopSpinner(); process.stdout.write(`\n${RED}  error: ${e.message}${R}\n\n`); promptUser(); }
    });
  }

  startSpinner("waking up");
  messages.push({ role: "user", content: await buildGreeting() });
  try   { await runAgentLoop(messages, makeEmitter(), { noTools: true }); }
  catch (e) { stopSpinner(); process.stdout.write(`\n${RED}  startup error: ${e.message}${R}\n\n`); promptUser(); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Entry point
// ══════════════════════════════════════════════════════════════════════════════
if (process.env.NODE_ENV !== "test") {
  (async () => {
    const modelName = (process.env.OLLAMA_MODEL || "").toLowerCase();
    const mightThink = detectMightThink(modelName);

    let showReasoning = false;
    if (mightThink) {
      const setupRl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = await ask(setupRl, `${GRAY}show reasoning? (y/N) ${R}`);
      setupRl.close();
      showReasoning = ans.trim().toLowerCase() === "y";
    }

    const serverRunning = await probeServer(SERVER_PORT, WebSocket);
    if (serverRunning) {
      await runProxy(SERVER_PORT, showReasoning);
    } else {
      await runStandalone(showReasoning);
    }
  })();
}