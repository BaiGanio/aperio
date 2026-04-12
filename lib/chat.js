#!/usr/bin/env node
/**
 * scripts/chat.js — Aperio terminal chat
 *
 * Auto-detects whether an Aperio server is already running.
 *   PROXY      → server found on SERVER_PORT → thin WebSocket client
 *   STANDALONE → no server → boots agent directly via lib/agent.js
 *
 * Features:
 *   • Sticky header (always visible at top)
 *   • Staged spinner: thinking → preparing answer → this may take a moment
 *   • Model picker on startup (ollama): keep current, pick installed, or pull new
 *   • Ollama auto-start + port-conflict recovery
 *   • Double Ctrl+C to exit
 *   • WebSocket auto-reconnect in proxy mode
 *
 * Set DEBUG=1 to see raw stderr from sub-processes.
 */

import { WebSocket }                    from "ws";
import { createInterface }              from "readline";
import { fileURLToPath }                from "url";
import { dirname, resolve }             from "path";
import { createRequire }                from "module";
import { spawn, execSync }              from "child_process";
import net                              from "net";
import { existsSync }                   from "fs";
import dotenv                           from "dotenv";
import { createAgent, makeCliEmitter }  from "./agent.js";
import { isDockerAvailable }            from "../db/index.js";

// ─── Suppress subprocess stderr noise ────────────────────────────────────────
if (!process.env.DEBUG) {
  process.stderr.write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') encoding(); // encoding arg is optional callback
    else if (typeof callback === 'function') callback();
    return true;
  };
}

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
const envPath = existsSync(resolve(ROOT, ".env")) 
  ? resolve(ROOT, ".env") 
  : resolve(ROOT, ".env.example");

dotenv.config({ path: envPath });

const { version } = require(resolve(ROOT, "package.json"));

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_PORT = Number.parseInt(process.env.SERVER_PORT || "31337", 10);
const OLLAMA_PORT = Number.parseInt(process.env.OLLAMA_PORT || "11434", 10);
// ─── ANSI ─────────────────────────────────────────────────────────────────────
const R      = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";
const CYAN   = "\x1b[36m";
const GRAY   = "\x1b[90m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";

// Move cursor to absolute row/col (1-based)
const moveTo = (row, col = 1) => `\x1b[${row};${col}H`;
// Save / restore cursor position
const SAVE_CURSOR    = "\x1b[s";
const RESTORE_CURSOR = "\x1b[u";
// Erase to end of line
const ERASE_EOL      = "\x1b[K";
// Hide / show cursor during redraws
const HIDE_CURSOR    = "\x1b[?25l";
const SHOW_CURSOR    = "\x1b[?25h";
// Scroll region: reserve top N lines so content never overwrites header
const setScrollRegion = (top, bottom) => `\x1b[${top};${bottom}r`;
// Reset scroll region to full screen
const RESET_SCROLL   = "\x1b[r";

// ─── Header state (mutable, redrawn on every update) ─────────────────────────
const HEADER_LINES = 4; // rows reserved at top (banner uses 4 lines max)
let _headerMode    = "";
let _headerModel   = "";
let _headerDockerOn  = isDockerAvailable();
let _headerDB = isDockerAvailable() ? 'postgres' : 'lancedb';  // infer default DB from docker availability
let _headerReasoning = false;
let _headerStatus  = ""; // dynamic right-side status word (e.g. "thinking")

function setScrollArea() {
  const rows = process.stdout.rows || 40;
  // Rows 1..HEADER_LINES are the sticky header; content scrolls below.
  process.stdout.write(setScrollRegion(HEADER_LINES + 1, rows));
  // Move cursor to just below header so normal output starts there
  process.stdout.write(moveTo(HEADER_LINES + 1));
}

function redrawHeader() {
  const cols    = process.stdout.columns || 80;
  const sep     = "─".repeat(cols - 2);
  const rStatus = _headerStatus
    ? `${GRAY}${DIM}${_headerStatus}${R}`
    : "";

  // Build the two visible lines
  const line1 = `  ${BOLD}${CYAN}Aperio mode:${R}  ${GRAY}${_headerMode}${R}  •  ${_headerModel}${R}  •  Docker: ${CYAN}${_headerDockerOn ? 'on': 'off'}${R}  •  DB: ${CYAN}${_headerDB}${R}`;
  const line2 = `${GRAY}  ${sep}${R}`;
  const line3Parts = [`${GRAY}  commands: | exit | clear | memories | reasoning${R}`];
  if (_headerReasoning) line3Parts.push(`   ${GRAY}reasoning: ${GREEN}on${R}`);
  const line3 = line3Parts.join("");
  const line4 = rStatus ? `  ${rStatus}` : "";

  process.stdout.write(
    HIDE_CURSOR +
    SAVE_CURSOR +
    moveTo(1) + line1 + ERASE_EOL + "\n" +
    line2      + ERASE_EOL + "\n" +
    line3      + ERASE_EOL + "\n" +
    line4      + ERASE_EOL +
    RESTORE_CURSOR +
    SHOW_CURSOR
  );
}

function initHeader(mode, model, showReasoning) {
  _headerMode      = mode;
  _headerModel     = model;
  _headerReasoning = showReasoning;
  _headerStatus    = "";

  // Clear screen, set scroll area, draw header
  process.stdout.write("\x1b[2J"); // clear entire screen
  process.stdout.write(moveTo(1)); // home
  setScrollArea();
  redrawHeader();
  // Cursor is now below the header — normal output goes here
  process.stdout.write("\n");
}

function setHeaderStatus(text) {
  _headerStatus = text;
  redrawHeader();
}

function updateHeaderModel(model) {
  _headerModel = model.trim();;
  redrawHeader();
}

function updateHeaderReasoning(val) {
  _headerReasoning = val;
  redrawHeader();
}

// ─── Staged spinner ───────────────────────────────────────────────────────────
// Shows progressive status labels as time passes, so the user always knows
// what's happening during long inference delays.
//
//   0 s  → label[0]  "thinking"
//   3 s  → label[1]  "preparing answer"
//   7 s  → label[2]  "this may take a moment"
//  12 s  → label[3]  "still working…"

const SPINNER_FRAMES  = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const SPINNER_STAGES  = [
  { after: 0,     label: "thinking"               },
  { after: 3000,  label: "preparing answer"        },
  { after: 7000,  label: "this may take a moment"  },
  { after: 12000, label: "still working…"          },
];

let _spinnerTimer  = null;
let _spinnerStart  = 0;
let _spinnerFrame  = 0;
let _spinnerLabel  = "";

function startSpinner(label) {
  // If a custom label is passed in (e.g. "waking up") use it as a fixed label,
  // otherwise use the staged progression.
  const fixed = label && label !== "thinking" ? label : null;

  stopSpinner();
  _spinnerStart = Date.now();
  _spinnerFrame = 0;
  _spinnerLabel = fixed || SPINNER_STAGES[0].label;

  function tick() {
    const elapsed = Date.now() - _spinnerStart;
    if (!fixed) {
      // Advance to the highest stage we've passed
      let stageLabel = SPINNER_STAGES[0].label;
      for (const s of SPINNER_STAGES) {
        if (elapsed >= s.after) stageLabel = s.label;
      }
      _spinnerLabel = stageLabel;
    }
    const frame = SPINNER_FRAMES[_spinnerFrame % SPINNER_FRAMES.length];
    _spinnerFrame++;
    // Write spinner on the current line (below header — inside scroll region)
    process.stdout.write(`\r${GRAY}${frame} ${_spinnerLabel}${R}   `);
    // Also show current stage in header status bar
    setHeaderStatus(_spinnerLabel);
  }

  tick();
  _spinnerTimer = setInterval(tick, 80);
}

function stopSpinner() {
  if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
  process.stdout.write(`\r${" ".repeat(50)}\r`);
  setHeaderStatus(""); // clear status from header too
}

// ─── Readline helper ──────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(res => rl.question(question, res));
}

function printQ() {
  process.stdout.write(`${YELLOW}${BOLD}You:${R} `);
}

// ─── Port / process helpers ───────────────────────────────────────────────────
function isPortOpen(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(600);
    sock.once("connect", () => { sock.destroy(); resolve(true);  });
    sock.once("error",   () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

function pidsOnPort(port) {
  try {
    const out = execSync("lsof", ["-ti", `tcp:${port}`], { 
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]  // replaces 2>/dev/null
    });
    return [...out.matchAll(/pid=(\d+)/g)].map(m => Number.parseInt(m[1]));
  } catch {}
  try {
    const out = execFileSync("ss", ["-tlnp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
    .split("\n")
    .filter(line => line.includes(`:${port} `))
    .join("\n");
    return out.trim().split("\n").map(Number).filter(Boolean);
  } catch {}
  return [];
}

function killPids(pids) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

// ─── Ollama helpers ───────────────────────────────────────────────────────────
const OLLAMA_BASE = () => process.env.OLLAMA_BASE_URL || `http://localhost:${OLLAMA_PORT}`;

async function ollamaHealthy() {
  try {
    const r = await fetch(`${OLLAMA_BASE()}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** Return list of locally installed ollama model names. */
async function listOllamaModels() {
  try {
    const r    = await fetch(`${OLLAMA_BASE()}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    return (data.models || []).map(m => m.name);
  } catch { return []; }
}

/**
 * Ensure `ollama serve` is running and healthy.
 * Handles: already up / port free / port busy-but-stale.
 */
async function ensureOllama() {
  if (await ollamaHealthy()) return true;

  if (await isPortOpen(OLLAMA_PORT)) {
    const pids   = pidsOnPort(OLLAMA_PORT);
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
    if (await ollamaHealthy()) {
      process.stdout.write(`${GREEN}  ✓ ollama ready${R}\n\n`);
      return true;
    }
  }
  process.stdout.write(`${RED}  ✖ ollama did not become ready in time.${R}\n\n`);
  return false;
}

// ─── Model picker ─────────────────────────────────────────────────────────────
/**
 * Interactive startup model selection (ollama only).
 *
 * Shows:
 *   [0] Keep current:  <model>
 *   [1] <installed model 1>
 *   [2] <installed model 2>
 *   …
 *   [n] Pull a different model…
 *
 * Returns the chosen model name, or the current one if unchanged.
 */
async function pickOllamaModel(currentModel) {
  const installed = await listOllamaModels();

  process.stdout.write(`\n${BOLD}  Select model${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(40)}${R}\n`);

  // Option 0: keep current
  process.stdout.write(`  ${DIM}[0]${R}  ${CYAN}${currentModel}${R}  ${GRAY}(current)${R}\n`);

  // Options 1..n: other installed models
  const others = installed.filter(m => m !== currentModel);
  others.forEach((m, i) => {
    process.stdout.write(`  ${DIM}[${i + 1}]${R}  ${m}\n`);
  });

  // Last option: pull something new
  const pullIdx = others.length + 1;
  process.stdout.write(`  ${DIM}[${pullIdx}]${R}  ${GRAY}Pull a different model…${R}\n`);
  process.stdout.write(`${GRAY}  ${"─".repeat(40)}${R}\n`);

  const tmpRl  = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res =>
    tmpRl.question(`${GRAY}  Choice [0]: ${R}`, res)
  );
  tmpRl.close();

  const choice = Number.parseInt(answer.trim() || "0", 10);

  // Keep current
  if (Number.isNaN(choice) || choice === 0) {
    process.stdout.write(`\n`);
    return currentModel;
  }

  // Choose another installed model
  if (choice >= 1 && choice < pullIdx) {
    const chosen = others[choice - 1];
    process.stdout.write(`\n`);
    return chosen;
  }

  // Pull a new model
  if (choice === pullIdx) {
    const pullRl  = createInterface({ input: process.stdin, output: process.stdout });
    const rawName = await new Promise(res =>
      pullRl.question(`${GRAY}  Model name to pull (e.g. llama3.2): ${R}`, res)
    );
    pullRl.close();
    const modelName = rawName.trim();
    if (!modelName) { process.stdout.write(`\n`); return currentModel; }

    process.stdout.write(`\n${GRAY}  Pulling ${modelName}…${R}\n`);
    await new Promise((resolve, reject) => {
      const child = spawn("ollama", ["pull", modelName], { stdio: "inherit" });
      child.on("close", code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      child.on("error", reject);
    }).catch(err => {
      process.stdout.write(`${RED}  Pull failed: ${err.message}${R}\n`);
      return currentModel; // fall back silently
    });

    process.stdout.write(`${GREEN}  ✓ ${modelName} ready${R}\n\n`);
    return modelName;
  }

  return currentModel;
}

// ─── Server probe ─────────────────────────────────────────────────────────────
async function probeServer(port) {
  return new Promise(resolve => {
    const ws    = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 1500);
    ws.on("open",  () => { clearTimeout(timer); ws.close(); resolve(true); });
    ws.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

// ─── Memory display ───────────────────────────────────────────────────────────
function printMemories(memories) {
  if (!memories?.length) { console.log(`${GRAY}  no memories yet${R}\n`); return; }
  console.log(`\n${CYAN}${BOLD}  memories (${memories.length})${R}`);
  for (const m of memories) {
    const filled = Math.min(5, m.importance || 3);
    const stars  = "★".repeat(filled) + "☆".repeat(5 - filled);
    const tags   = m.tags?.length ? `  ${GRAY}[${m.tags.join(", ")}]${R}` : "";
    console.log(`\n  ${BOLD}${m.title}${R}${tags}  ${GRAY}${stars}${R}`);
    console.log(`  ${GRAY}${m.content}${R}`);
  }
  console.log();
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
    // Restore full scroll region before exit so the terminal isn't broken
    process.stdout.write(RESET_SCROLL);
    process.stdout.write(`${GRAY}  bye${R}\n`);
    process.exit(0);
  }
});

// Restore scroll region if process exits for any reason
process.on("exit", () => { process.stdout.write(RESET_SCROLL); });

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — PROXY  (server already running, we connect as a thin client)
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
        // Redraw header then clear body
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
        promptUser(); return;
      }

      startSpinner(); // staged spinner — no fixed label
      safeSend({ type: "chat", text: cmd });
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — STANDALONE  (no server, boot everything here)
// ══════════════════════════════════════════════════════════════════════════════
async function runStandalone(initialReasoning) {
  let showReasoning = initialReasoning;

  const isOllama = (process.env.AI_PROVIDER || "").toLowerCase() === "ollama";

  // ── Ollama: ensure running, then offer model picker ────────────────────────
  if (isOllama) {
    const ready = await ensureOllama();
    if (!ready) process.exit(1);

    // Model picker — show even if ollama was already healthy
    const currentModel = process.env.OLLAMA_MODEL || "llama3.1";
    const chosenModel  = await pickOllamaModel(currentModel);
    if (chosenModel !== currentModel) {
      process.env.OLLAMA_MODEL = chosenModel;
    }
  }

  // ── Boot agent ─────────────────────────────────────────────────────────────
  let agent;
  try {
    agent = await createAgent({ root: ROOT, version, clientName: "aperio-chat-cli" });
  } catch (e) {
    process.stdout.write(`${RED}  failed to start agent: ${e.message}${R}\n`);
    process.exit(1);
  }

  const {
    runAgentLoop, handleRememberIntent, fetchMemories,
    buildGreeting, OLLAMA_NO_TOOLS, provider,
  } = agent;

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
        promptUser(); return;
      }

      if (cmd === "reasoning") {
        showReasoning = !showReasoning;
        updateHeaderReasoning(showReasoning);
        const label = showReasoning ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  reasoning: ${label}${R}\n\n`);
        promptUser(); return;
      }

      messages.push({ role: "user", content: cmd });
      startSpinner(); // staged — no fixed label

      if (OLLAMA_NO_TOOLS && /^remember\s+that\b/i.test(cmd)) {
        await handleRememberIntent(cmd, makeEmitter());
        promptUser(); return;
      }

      try   { await runAgentLoop(messages, makeEmitter()); }
      catch (e) { stopSpinner(); process.stdout.write(`\n${RED}  error: ${e.message}${R}\n\n`); promptUser(); }
    });
  }

  // Greeting turn
  startSpinner("waking up");
  messages.push({ role: "user", content: await buildGreeting() });
  try   { await runAgentLoop(messages, makeEmitter(), { noTools: true }); }
  catch (e) { stopSpinner(); process.stdout.write(`\n${RED}  startup error: ${e.message}${R}\n\n`); promptUser(); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Entry point
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  const modelName  = (process.env.OLLAMA_MODEL || "").toLowerCase();
  const mightThink = ["deepseek-r1", "qwen3", "qwq"].some(m => modelName.includes(m))
    || "false";

  let showReasoning = false;
  if (mightThink) {
    const setupRl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await ask(setupRl, `${GRAY}show reasoning? (y/N) ${R}`);
    setupRl.close();
    showReasoning = ans.trim().toLowerCase() === "y";
  }

  const serverRunning = await probeServer(SERVER_PORT);
  if (serverRunning) {
    await runProxy(SERVER_PORT, showReasoning);
  } else {
    await runStandalone(showReasoning);
  }
})();