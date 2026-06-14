#!/usr/bin/env node
/**
 * lib/terminal.js — Aperio terminal chat (REFACTORED FOR TESTING)
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
import { dirname, resolve, extname, basename } from "path";
import { createRequire }               from "module";
import { spawn, execSync }             from "child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync, statSync } from "fs";
import dotenv                          from "dotenv";
import { createAgent }                 from "./agent.js";
import { makeCliEmitter }              from "./emitters/cliEmitter.js";
import { isDockerAvailable }           from "../db/index.js";
import {
  init       as initSessions,
  createSession,
  setSessionTitle,
  appendSummary,
  finaliseSession,
  sessionScratchDir,
  listSessions,
  getSession,
  buildResumeContext,
  RESUME_SYSTEM_INSTRUCTIONS,
} from "./helpers/sessions.js";

import { runWithPaths, DEFAULT_READ_PATHS, DEFAULT_WRITE_PATHS } from "./routes/paths.js";
import { processAttachments } from "./handlers/attachments/index.js";

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
} from "../lib/utils/chat-utils.js";

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
    isRememberIntent(trimmed) ||
    isSummarizeCommand(trimmed) ||
    isForgetCommand(trimmed) ||
    isHandoffCommand(trimmed) ||
    isSessionsCommand(trimmed) ||
    isResumeCommand(trimmed) ||
    isModelCommand(trimmed) ||
    isAttachCommand(trimmed) ||
    isDiscussCommand(trimmed)
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

/**
 * Checks if command is the 'summarize' command
 */
export function isSummarizeCommand(cmd) {
  return cmd.trim() === "summarize";
}

/**
 * Checks if command is a forget command with an id (e.g. "forget abc-123")
 */
export function isForgetCommand(cmd) {
  return /^forget\s+\S+/.test(cmd.trim());
}

/**
 * Checks if command is a handoff command (e.g. "handoff" or "handoff <focus>")
 */
export function isHandoffCommand(cmd) {
  return /^handoff(\s|$)/i.test(cmd.trim());
}

/**
 * Checks if command is the 'sessions' command
 */
export function isSessionsCommand(cmd) {
  return cmd.trim() === "sessions";
}

/**
 * Checks if command is a model-switch command (e.g. "model ollama llama3.1")
 */
export function isModelCommand(cmd) {
  return /^model(\s|$)/i.test(cmd.trim());
}

/**
 * Checks if command is an attach command (e.g. "attach <path>")
 */
export function isAttachCommand(cmd) {
  return /^attach\s+\S+/.test(cmd.trim());
}

/**
 * Checks if command is a discuss command (e.g. "discuss on" / "discuss off")
 */
export function isDiscussCommand(cmd) {
  return /^discuss(\s+(on|off))?$/i.test(cmd.trim());
}

/**
 * Checks if command is a resume command (e.g. "resume <id>")
 */
export function isResumeCommand(cmd) {
  return /^resume\s+\S+/.test(cmd.trim());
}

// ─── Module-level state for SIGINT abort / stop ───────────────────────────────
let _standaloneAbort  = null;   // AbortController set while standalone is generating
let _proxyWaiting     = false;  // true while proxy client awaits a server response
let _proxySafeSend    = null;   // proxy's safeSend fn, used by SIGINT to send "stop"
let _sessionId        = null;   // current standalone session id
let _sessionMessages  = null;   // reference to standalone messages array

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

  // Match the served context window to the app's assumed window (see
  // startOllama.js) so the KV cache fits VRAM and the app never over-keeps.
  const serveCtx = process.env.OLLAMA_CONTEXT_LENGTH ?? process.env.OLLAMA_NUM_CTX ?? "32768";
  process.stdout.write(`${GRAY}  Starting ollama serve… (OLLAMA_CONTEXT_LENGTH=${serveCtx})${R}\n`);
  const child = spawn("ollama", ["serve"], {
    detached: false,
    stdio:    ["ignore", "ignore", "ignore"],
    env:      { ...process.env, OLLAMA_CONTEXT_LENGTH: serveCtx },
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

// ─── Graceful Ctrl+C — abort generation first, then double-tap to exit ───────
let _sigintCount = 0;
process.on("SIGINT", () => {
  // Abort standalone generation in progress
  if (_standaloneAbort) {
    _standaloneAbort.abort();
    _standaloneAbort = null;
    return; // catch block in promptUser will re-prompt
  }
  // Stop proxy server response in progress
  if (_proxyWaiting && _proxySafeSend) {
    _proxyWaiting = false;
    _proxySafeSend({ type: "stop" });
    stopSpinner();
    return; // stream_end from server will re-prompt via emitter
  }
  // Double-tap to exit
  _sigintCount++;
  if (_sigintCount === 1) {
    stopSpinner();
    process.stdout.write(`\n${GRAY}  Press Ctrl+C again to quit.${R}\n\n`);
    setTimeout(() => { _sigintCount = 0; }, 2000);
  } else {
    if (_sessionId && _sessionMessages) {
      try { finaliseSession(_sessionId, _sessionMessages); } catch { /* non-fatal */ }
      _sessionId = null;
      _sessionMessages = null;
    }
    process.stdout.write(RESET_SCROLL);
    process.stdout.write(`${GRAY}  bye${R}\n`);
    process.exit(0);
  }
});
process.on("exit", () => { process.stdout.write(RESET_SCROLL); });

// ── Attachment helpers ────────────────────────────────────────────────────────
const MIME_BY_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function readAttachment(filePath) {
  const abs  = resolve(filePath);
  if (!existsSync(abs)) return { error: `file not found: ${filePath}` };
  const ext    = extname(abs).toLowerCase();
  const name   = basename(abs);
  const data   = readFileSync(abs).toString("base64");
  const sizeKb = Math.round(statSync(abs).size / 1024);
  const type   = MIME_BY_EXT[ext] ?? "text/plain";
  return { name, data, type, sizeKb, ext };
}

// ── printSessions — shared by both proxy and standalone ───────────────────────
function printSessions() {
  initSessions(ROOT);
  const all = listSessions();
  if (!all.length) {
    process.stdout.write(`\n${GRAY}  no sessions found${R}\n\n`);
    return;
  }
  const shown = all.slice(0, 15);
  process.stdout.write(`\n${BOLD}  Recent sessions${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(72)}${R}\n`);
  for (const s of shown) {
    const date  = new Date(s.startedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const model = s.model ? ` ${GRAY}${s.provider}/${s.model}${R}` : "";
    const title = (s.title ?? "Untitled").slice(0, 44).padEnd(44);
    process.stdout.write(`  ${DIM}${s.id.slice(0, 8)}${R}  ${title}  ${GRAY}${date}${R}${model}\n`);
  }
  if (all.length > 15) process.stdout.write(`${GRAY}  … and ${all.length - 15} more${R}\n`);
  process.stdout.write(`\n${DIM}  Use: resume <id>${R}\n\n`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — PROXY
// ══════════════════════════════════════════════════════════════════════════════
async function runProxy(port, initialReasoning) {
  let showReasoning = initialReasoning;
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  let ws;
  let _intentionalClose    = false;
  let _reconnectTimer      = null;
  let pendingMemories      = false;
  let pendingDelete        = null;
  let pendingAttachments   = [];   // queued via `attach <path>`, sent with next message
  let roundtableMode       = false;
  let currentEmitter;

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning });
  }

  // Register for SIGINT stop — function declaration is hoisted within runProxy
  _proxySafeSend = safeSend;

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.on("open", () => {
      clearTimeout(_reconnectTimer);
      ws.send(JSON.stringify({ type: "init" }));
    });

    ws.on("close", () => {
      if (_intentionalClose) { process.stdout.write(RESET_SCROLL); process.exit(0); return; }
      stopSpinner();
      _proxyWaiting = false;
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
      if (msg.type === "deleted" && pendingDelete) {
        pendingDelete = null;
        process.stdout.write(`\n${GREEN}  ✓ memory deleted${R}\n\n`);
        promptUser();
        return;
      }
      // Clear waiting state when a response stream completes
      if (msg.type === "stream_end") {
        _proxyWaiting = false;
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
    _proxyWaiting = false;
    currentEmitter = makeEmitter();
    printQ();

    rl.once("line", line => {
      const cmd = line.trim();
      if (!cmd) { promptUser(); return; }

      if (cmd === "exit") {
        _intentionalClose = true;
        _proxySafeSend = null;
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

      if (cmd === "summarize") {
        _proxyWaiting = true;
        startSpinner("summarizing");
        safeSend({ type: "summarize" });
        return;
      }

      if (isHandoffCommand(cmd)) {
        const focus = cmd.replace(/^handoff\s*/i, "").trim();
        _proxyWaiting = true;
        startSpinner("writing handoff");
        safeSend({ type: "handoff", focus: focus || undefined });
        return;
      }

      if (isSessionsCommand(cmd)) {
        printSessions();
        promptUser();
        return;
      }

      if (isResumeCommand(cmd)) {
        const id = cmd.replace(/^resume\s+/i, "").trim();
        _proxyWaiting = true;
        startSpinner("resuming session");
        safeSend({ type: "resume_session", id });
        return;
      }

      if (isModelCommand(cmd)) {
        const parts = cmd.trim().split(/\s+/);
        if (parts.length < 3) {
          process.stdout.write(`\n${GRAY}  usage: model <provider> <name>${R}\n  e.g. model ollama llama3.1\n       model anthropic claude-haiku-4-5-20251001\n\n`);
          promptUser();
          return;
        }
        const [, prov, ...rest] = parts;
        safeSend({ type: "switch_model", provider: prov, model: rest.join(" ") });
        promptUser();
        return;
      }

      if (/^forget\s+\S+/.test(cmd)) {
        const id = cmd.replace(/^forget\s+/, "").trim();
        pendingDelete = id;
        safeSend({ type: "delete_memory", id });
        return;
      }

      if (isAttachCommand(cmd)) {
        const filePath = cmd.replace(/^attach\s+/i, "").trim();
        const att = readAttachment(filePath);
        if (att.error) {
          process.stdout.write(`\n${RED}  ✖ ${att.error}${R}\n\n`);
        } else {
          pendingAttachments.push(att);
          process.stdout.write(`\n${GREEN}  📎 queued: ${att.name} (${att.sizeKb} KB) — will be sent with your next message${R}\n\n`);
        }
        promptUser();
        return;
      }

      if (isDiscussCommand(cmd)) {
        const arg = cmd.trim().split(/\s+/)[1]?.toLowerCase();
        if (arg === "on")  roundtableMode = true;
        else if (arg === "off") roundtableMode = false;
        else roundtableMode = !roundtableMode;
        const label = roundtableMode ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  discuss mode: ${label}${R}${roundtableMode ? `\n${DIM}  Next messages will use two-agent deliberation.${R}` : ""}\n\n`);
        promptUser();
        return;
      }

      _proxyWaiting = true;
      startSpinner();
      const chatPayload = { type: "chat", text: cmd };
      if (pendingAttachments.length > 0) {
        chatPayload.attachments = pendingAttachments.map(a => ({ name: a.name, data: a.data, type: a.type }));
        pendingAttachments = [];
      }
      if (roundtableMode) chatPayload.roundtable = true;
      safeSend(chatPayload);
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — STANDALONE
// ══════════════════════════════════════════════════════════════════════════════

const SUMMARIZE_INTENT_RE = /\b(summarize|summarise|summarization|summary|recap)\b.*\b(our|this|the)?\s*(conversation|chat|discussion|session|history|we('ve| have) (discussed|talked|covered))\b|\bsummarize\s+(it|this|everything|all)\b|\b(tl;?dr|tldr)\b/i;

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

  const { runAgentLoop, handleRememberIntent, fetchMemories, buildGreeting, OLLAMA_NO_TOOLS, provider, callTool } = agent;

  // Session management
  initSessions(ROOT);
  const sessionId = createSession({ model: provider.model, provider: provider.name, source: "terminal" });
  _sessionId = sessionId;
  // Per-session scratch workspace for skill-generated artifacts — same model as
  // the web path: tools write here and it's pruned with the session. Injected
  // into the chat turn's system prompt and threaded via runWithPaths so the
  // in-process generate_xlsx tool resolves it.
  const scratchDir = sessionScratchDir(sessionId);
  const workspaceDirective =
    `## Session workspace\n` +
    `This conversation has a private scratch workspace at:\n\`${scratchDir}\`\n\n` +
    `Write **generated artifacts** here — generator scripts (e.g. pptx/xlsx builder .js), ` +
    `intermediate files, and final output files (pptx, xlsx, etc.). Create the directory if it ` +
    `does not exist. Do NOT write into \`skills/*/scratch/\`. Scripts run as ES modules ` +
    `(the project is \`type: module\`): use \`import x from 'pkg'\`, not \`require()\`. Files here are retained with the ` +
    `session and cleaned up automatically when it expires, so the user can download results meanwhile.\n\n` +
    `For everything else you can work freely: read and edit files anywhere within your allowed ` +
    `folders (the project directory by default, plus any folders the user added in Settings). ` +
    `The scratch workspace is only for generated output — it is not the only place you can write.`;

  initHeader("standalone", `${provider.name} (${provider.model})`, showReasoning);

  const rl       = createInterface({ input: process.stdin, output: process.stdout });
  const messages = [];
  _sessionMessages = messages;
  let pendingAttachmentBlocks = [];  // content blocks queued via `attach`, sent with next message

  let abortController = null;
  let titleSet        = false;

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning });
  }

  function buildHistoryText(msgs) {
    return msgs
      .filter(m =>
        m.role !== "tool" &&
        !(Array.isArray(m.content) && m.content[0]?.type === "tool_result")
      )
      .map(m => {
        const role = m.role === "user" ? "User" : "Assistant";
        const text = Array.isArray(m.content)
          ? m.content.filter(b => b.type === "text").map(b => b.text).join(" ").trim()
          : String(m.content || "").trim();
        return text ? `${role}: ${text}` : null;
      })
      .filter(Boolean)
      .join("\n\n");
  }

  async function handleSummarize() {
    if (messages.length < 3) {
      process.stdout.write(`\n${GRAY}  Not enough history to summarize.${R}\n\n`);
      promptUser();
      return;
    }

    startSpinner("summarizing");

    const history = buildHistoryText(messages);
    const summaryMessages = [{
      role: "user",
      content: `Summarize the following conversation in 3-5 concise bullet points. Capture key topics, decisions, and any open questions. Skip pleasantries.\n\nConversation:\n${history}`,
    }];

    // Use a no-op done-callback so the summary renders but doesn't re-prompt mid-function
    const summaryEmitter = makeCliEmitter(() => {}, { stopSpinner, startSpinner }, { showReasoning });

    let summary = "";
    try {
      summary = await runAgentLoop(summaryMessages, summaryEmitter, { noTools: true });
    } catch (e) {
      stopSpinner();
      process.stdout.write(`\n${RED}  summarize failed: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    try { appendSummary(sessionId, { content: summary, messages }); } catch { /* non-fatal */ }

    // Compress in-memory history to just the summary
    const firstMsg = messages[0];
    messages.length = 0;
    messages.push(firstMsg);
    messages.push({ role: "assistant", content: `[Conversation summary]\n${summary}` });

    // Save to memory store
    let saved = false;
    try {
      const title = `Conversation — ${new Date().toLocaleDateString("en-GB", {
        day: "2-digit", month: "short", year: "numeric",
      })}`;
      await callTool("remember", {
        type: "project", title, content: summary,
        tags: ["conversation-summary"], importance: 3,
      });
      saved = true;
    } catch { /* non-fatal */ }

    process.stdout.write(`\n${GREEN}  ✓ Summarized${saved ? " and saved to memory" : ""}.${R}\n\n`);
    promptUser();
  }

  async function handleHandoff(focus) {
    if (messages.length < 2) {
      process.stdout.write(`\n${YELLOW}  ⚠ not enough conversation to hand off yet.${R}\n\n`);
      promptUser();
      return;
    }

    startSpinner("writing handoff");

    const focusLine = (focus && focus.trim())
      ? focus.trim()
      : "Continue the current task from where this session left off.";

    const history = buildHistoryText(messages);
    const handoffPrompt = [
      "Produce a handoff document for a fresh agent to continue this work.",
      `Next session focus: ${focusLine}`,
      "",
      "Follow exactly this structure (omit empty sections, do not pad):",
      "",
      "# Handoff — <one-line title>",
      "**Created:** <ISO timestamp>",
      "**Next session focus:** <one sentence>",
      "",
      "## Active task",
      "## State of play",
      "## Key decisions made this session",
      "## Open questions",
      "## Artifacts",
      "## Suggested skills for the next agent",
      "## Gotchas",
      "",
      "Rules: link by absolute path/URL, do not duplicate artifacts. Redact secrets.",
      "Be terse. No narration. No recap after the document.",
      "",
      "Conversation transcript:",
      history,
    ].join("\n");

    const handoffEmitter = makeCliEmitter(() => {}, { stopSpinner, startSpinner }, { showReasoning });

    let doc = "";
    try {
      doc = await runAgentLoop([{ role: "user", content: handoffPrompt }], handoffEmitter, { noTools: true });
    } catch (e) {
      stopSpinner();
      process.stdout.write(`\n${RED}  handoff failed: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    const HANDOFFS_DIR = resolve(ROOT, "var/handoffs");
    const iso  = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = focusLine.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
    const filePath = resolve(HANDOFFS_DIR, `aperio-handoff-${iso}-${slug}.md`);

    try {
      mkdirSync(HANDOFFS_DIR, { recursive: true });
      writeFileSync(filePath, doc, "utf-8");
    } catch (e) {
      process.stdout.write(`\n${RED}  failed to write handoff: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    const firstMsg = messages[0];
    messages.length = 0;
    if (firstMsg) messages.push(firstMsg);
    messages.push({ role: "assistant", content: `[Handoff brief — rotated from prior context]\n\n${doc}\n\n[End handoff]` });

    process.stdout.write(`\n${GREEN}  ✓ handoff written:${R} ${filePath}\n\n`);
    promptUser();
  }

  function normalizeMessages(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!Array.isArray(m.content)) continue;
      const text = m.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (text) {
        msgs[i] = { role: m.role, content: text };
      } else {
        msgs.splice(i, 1);
      }
    }
  }

  async function handleResume(id) {
    const session = getSession(id);
    if (!session) {
      process.stdout.write(`\n${RED}  session not found: ${id}${R}\n\n`);
      promptUser();
      return;
    }

    process.stdout.write(`\n${GRAY}  ⟳ resuming "${session.title ?? "Untitled"}"…${R}\n`);
    messages.length = 0;
    titleSet = true;
    messages.push({ role: "user", content: buildResumeContext(session) });
    startSpinner();

    try {
      await runWithPaths(DEFAULT_READ_PATHS, DEFAULT_WRITE_PATHS, scratchDir, () =>
        runAgentLoop(messages, makeEmitter(), { noTools: true, extraSystem: RESUME_SYSTEM_INSTRUCTIONS })
      );
    } catch (e) {
      stopSpinner();
      if (e.name !== "AbortError")
        process.stdout.write(`\n${RED}  resume error: ${e.message}${R}\n\n`);
      promptUser();
    }
  }

  function promptUser() {
    // Reset abort state at the start of each user turn
    abortController  = null;
    _standaloneAbort = null;
    printQ();
    rl.once("line", async line => {
      const cmd = line.trim();
      if (!cmd) { promptUser(); return; }

      if (cmd === "exit") {
        try { finaliseSession(sessionId, messages); } catch { /* non-fatal */ }
        _sessionId = null;
        _sessionMessages = null;
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

      if (cmd === "summarize") {
        await handleSummarize();
        return;
      }

      if (isHandoffCommand(cmd)) {
        const focus = cmd.replace(/^handoff\s*/i, "").trim();
        await handleHandoff(focus || undefined);
        return;
      }

      if (isSessionsCommand(cmd)) {
        printSessions();
        promptUser();
        return;
      }

      if (isResumeCommand(cmd)) {
        const id = cmd.replace(/^resume\s+/i, "").trim();
        await handleResume(id);
        return;
      }

      if (isModelCommand(cmd)) {
        const parts = cmd.trim().split(/\s+/);
        if (parts.length < 3) {
          process.stdout.write(`\n${GRAY}  usage: model <provider> <name>${R}\n  e.g. model ollama llama3.1\n       model anthropic claude-haiku-4-5-20251001\n\n`);
          promptUser();
          return;
        }
        const [, prov, ...rest] = parts;
        const prevProvider = agent.provider.name;
        try {
          agent.setProvider({ name: prov, model: rest.join(" ") });
          if (prevProvider !== agent.provider.name) normalizeMessages(messages);
          updateHeaderModel(`${agent.provider.name} (${agent.provider.model})`);
          process.stdout.write(`\n${GREEN}  ✓ switched to ${agent.provider.name} / ${agent.provider.model}${R}\n\n`);
        } catch (e) {
          process.stdout.write(`\n${RED}  model switch failed: ${e.message}${R}\n\n`);
        }
        promptUser();
        return;
      }

      if (/^forget\s+\S+/.test(cmd)) {
        const id = cmd.replace(/^forget\s+/, "").trim();
        try {
          await callTool("forget", { id });
          process.stdout.write(`\n${GREEN}  ✓ memory deleted${R}\n\n`);
        } catch (e) {
          process.stdout.write(`\n${RED}  delete failed: ${e.message}${R}\n\n`);
        }
        promptUser();
        return;
      }

      if (isAttachCommand(cmd)) {
        const filePath = cmd.replace(/^attach\s+/i, "").trim();
        const att = readAttachment(filePath);
        if (att.error) {
          process.stdout.write(`\n${RED}  ✖ ${att.error}${R}\n\n`);
          promptUser();
          return;
        }
        startSpinner("reading attachment");
        try {
          const { contentBlocks } = await processAttachments([att], ROOT);
          pendingAttachmentBlocks.push(...contentBlocks);
          stopSpinner();
          process.stdout.write(`\n${GREEN}  📎 queued: ${att.name} (${att.sizeKb} KB) — will be sent with your next message${R}\n\n`);
        } catch (e) {
          stopSpinner();
          process.stdout.write(`\n${RED}  ✖ attach failed: ${e.message}${R}\n\n`);
        }
        promptUser();
        return;
      }

      // Regular chat message
      if (!titleSet && cmd) {
        setSessionTitle(sessionId, cmd);
        titleSet = true;
      }

      // Prepend any queued attachment blocks to this message's content
      const userContent = pendingAttachmentBlocks.length > 0
        ? [...pendingAttachmentBlocks, { type: "text", text: cmd }]
        : cmd;
      pendingAttachmentBlocks = [];

      messages.push({ role: "user", content: userContent });
      startSpinner();

      if (OLLAMA_NO_TOOLS && isRememberIntent(cmd)) {
        await handleRememberIntent(cmd, makeEmitter());
        promptUser();
        return;
      }

      // Route natural-language summarize intents through handleSummarize
      if (SUMMARIZE_INTENT_RE.test(cmd)) {
        await handleSummarize();
        return;
      }

      try {
        await runWithPaths(DEFAULT_READ_PATHS, DEFAULT_WRITE_PATHS, scratchDir, () =>
          runAgentLoop(
            messages, makeEmitter(), { extraSystem: workspaceDirective },
            () => abortController,
            (c) => { abortController = c; _standaloneAbort = c; }
          )
        );
      } catch (e) {
        stopSpinner();
        abortController  = null;
        _standaloneAbort = null;
        if (e.name === "AbortError") {
          process.stdout.write(`\n${GRAY}  ↩ generation stopped${R}\n\n`);
        } else {
          process.stdout.write(`\n${RED}  error: ${e.message}${R}\n\n`);
        }
        promptUser();
      }
    });
  }

  startSpinner("waking up");
  const { prompt: greetingPrompt } = await buildGreeting();
  messages.push({ role: "user", content: greetingPrompt });
  // buildGreeting persists the preloaded memories on the agent (sessionMemCtx), so
  // they ride along in every turn's system prompt — no per-call injection needed.
  const greetOpts = { noTools: true };
  try   { await runAgentLoop(messages, makeEmitter(), greetOpts); }
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