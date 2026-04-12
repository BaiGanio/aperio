/**
 * lib/chat-utils.js
 *
 * Pure, side-effect-free utilities extracted from chat.js.
 * Everything here is exported so it can be unit-tested directly and
 * covered by c8 without any mocking of the entry-point IIFE.
 *
 * chat.js imports from here instead of defining these inline.
 */

import net from "net";

// ─── Config (passed in from chat.js so tests can supply their own) ────────────
// chat.js calls: import { OLLAMA_PORT, ... } from "./chat-utils.js"
// and passes OLLAMA_PORT into the functions that need it.
export function parseServerPort(env = process.env) {
  return Number.parseInt(env.SERVER_PORT || "31337", 10);
}
export function parseOllamaPort(env = process.env) {
  return Number.parseInt(env.OLLAMA_PORT || "11434", 10);
}

// ─── ANSI ─────────────────────────────────────────────────────────────────────
export const R            = "\x1b[0m";
export const BOLD         = "\x1b[1m";
export const DIM          = "\x1b[2m";
export const CYAN         = "\x1b[36m";
export const GRAY         = "\x1b[90m";
export const GREEN        = "\x1b[32m";
export const YELLOW       = "\x1b[33m";
export const RED          = "\x1b[31m";
export const SAVE_CURSOR    = "\x1b[s";
export const RESTORE_CURSOR = "\x1b[u";
export const ERASE_EOL      = "\x1b[K";
export const HIDE_CURSOR    = "\x1b[?25l";
export const SHOW_CURSOR    = "\x1b[?25h";
export const RESET_SCROLL   = "\x1b[r";
export const HEADER_LINES   = 4;

export const moveTo          = (row, col = 1) => `\x1b[${row};${col}H`;
export const setScrollRegion = (top, bottom)  => `\x1b[${top};${bottom}r`;

// ─── Header state ─────────────────────────────────────────────────────────────
// Mutable module-level state, exactly as in the original chat.js.
// Tests that need isolation should use makeHeaderState() instead.
let _headerMode      = "";
let _headerModel     = "";
let _headerDockerOn  = false; // set by chat.js after isDockerAvailable()
let _headerDB        = "lancedb";
let _headerReasoning = false;
let _headerStatus    = "";

/** Allow chat.js to seed docker state after resolving isDockerAvailable(). */
export function initDockerState(dockerOn) {
  _headerDockerOn = dockerOn;
  _headerDB       = dockerOn ? "postgres" : "lancedb";
}

export function setScrollArea() {
  const rows = process.stdout.rows || 40;
  process.stdout.write(setScrollRegion(HEADER_LINES + 1, rows));
  process.stdout.write(moveTo(HEADER_LINES + 1));
}

export function redrawHeader() {
  const cols    = process.stdout.columns || 80;
  const sep     = "─".repeat(cols - 2);
  const rStatus = _headerStatus ? `${GRAY}${DIM}${_headerStatus}${R}` : "";

  const line1 = `  ${BOLD}${CYAN}Aperio mode:${R}  ${GRAY}${_headerMode}${R}  •  ${_headerModel}${R}  •  Docker: ${CYAN}${_headerDockerOn ? "on" : "off"}${R}  •  DB: ${CYAN}${_headerDB}${R}`;
  const line2 = `${GRAY}  ${sep}${R}`;
  const line3Parts = [`${GRAY}  commands: | exit | clear | memories | reasoning${R}`];
  if (_headerReasoning) line3Parts.push(`   ${GRAY}reasoning: ${GREEN}on${R}`);
  const line3 = line3Parts.join("");
  const line4 = rStatus ? `  ${rStatus}` : "";

  process.stdout.write(
    HIDE_CURSOR + SAVE_CURSOR +
    moveTo(1) + line1 + ERASE_EOL + "\n" +
    line2      + ERASE_EOL + "\n" +
    line3      + ERASE_EOL + "\n" +
    line4      + ERASE_EOL +
    RESTORE_CURSOR + SHOW_CURSOR
  );
}

export function initHeader(mode, model, showReasoning) {
  _headerMode      = mode;
  _headerModel     = model;
  _headerReasoning = showReasoning;
  _headerStatus    = "";
  process.stdout.write("\x1b[2J");
  process.stdout.write(moveTo(1));
  setScrollArea();
  redrawHeader();
  process.stdout.write("\n");
}

export function setHeaderStatus(text) {
  _headerStatus = text;
  redrawHeader();
}

export function updateHeaderModel(model) {
  _headerModel = model.trim();
  redrawHeader();
}

export function updateHeaderReasoning(val) {
  _headerReasoning = val;
  redrawHeader();
}

// ─── Spinner ──────────────────────────────────────────────────────────────────
export const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
export const SPINNER_STAGES = [
  { after: 0,     label: "thinking"              },
  { after: 3000,  label: "preparing answer"       },
  { after: 7000,  label: "this may take a moment" },
  { after: 12000, label: "still working…"         },
];

let _spinnerTimer = null;
let _spinnerStart = 0;
let _spinnerFrame = 0;
let _spinnerLabel = "";

export function resolveSpinnerStage(elapsed) {
  let label = SPINNER_STAGES[0].label;
  for (const s of SPINNER_STAGES) {
    if (elapsed >= s.after) label = s.label;
  }
  return label;
}

export function startSpinner(label) {
  const fixed = label && label !== "thinking" ? label : null;
  stopSpinner();
  _spinnerStart = Date.now();
  _spinnerFrame = 0;
  _spinnerLabel = fixed || SPINNER_STAGES[0].label;

  function tick() {
    const elapsed = Date.now() - _spinnerStart;
    if (!fixed) _spinnerLabel = resolveSpinnerStage(elapsed);
    const frame = SPINNER_FRAMES[_spinnerFrame % SPINNER_FRAMES.length];
    _spinnerFrame++;
    process.stdout.write(`\r${GRAY}${frame} ${_spinnerLabel}${R}   `);
    setHeaderStatus(_spinnerLabel);
  }

  tick();
  _spinnerTimer = setInterval(tick, 80);
}

export function stopSpinner() {
  if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
  process.stdout.write(`\r${" ".repeat(50)}\r`);
  setHeaderStatus("");
}

// ─── Readline helpers ─────────────────────────────────────────────────────────
export function ask(rl, question) {
  return new Promise(res => rl.question(question, res));
}

export function printQ() {
  process.stdout.write(`${YELLOW}${BOLD}You:${R} `);
}

// ─── Port / process helpers ───────────────────────────────────────────────────
export function isPortOpen(port, host = "127.0.0.1") {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(600);
    sock.once("connect", () => { sock.destroy(); resolve(true);  });
    sock.once("error",   () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

export function pidsOnPort(port, execSync, execFileSync) {
  try {
    const out = execSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...out.matchAll(/pid=(\d+)/g)].map(m => Number.parseInt(m[1]));
  } catch {}
  try {
    const out = execFileSync("ss", ["-tlnp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(line => line.includes(`:${port} `))
      .join("\n");
    return out.trim().split("\n").map(Number).filter(Boolean);
  } catch {}
  return [];
}

export function killPids(pids) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}

// ─── Ollama helpers ───────────────────────────────────────────────────────────
export function ollamaBase(ollamaPort) {
  return process.env.OLLAMA_BASE_URL || `http://localhost:${ollamaPort}`;
}

export async function ollamaHealthy(ollamaPort) {
  try {
    const r = await fetch(`${ollamaBase(ollamaPort)}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

export async function listOllamaModels(ollamaPort) {
  try {
    const r    = await fetch(`${ollamaBase(ollamaPort)}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const data = await r.json();
    return (data.models || []).map(m => m.name);
  } catch { return []; }
}

// ─── Model picker — pure choice resolution (no I/O) ──────────────────────────
/**
 * Given the user's raw answer string, the current model, and the list of
 * other installed models, return { action, model } with no side-effects.
 *
 * action: "keep" | "switch" | "pull"
 */
export function resolveModelChoice(answer, currentModel, others) {
  const pullIdx = others.length + 1;
  const choice  = Number.parseInt(answer.trim() || "0", 10);
  if (Number.isNaN(choice) || choice === 0) return { action: "keep",   model: currentModel };
  if (choice >= 1 && choice < pullIdx)      return { action: "switch", model: others[choice - 1] };
  if (choice === pullIdx)                   return { action: "pull",   model: null };
  return { action: "keep", model: currentModel };
}

// ─── Server probe ─────────────────────────────────────────────────────────────
export async function probeServer(port, WebSocket) {
  return new Promise(resolve => {
    const ws    = new WebSocket(`ws://localhost:${port}`);
    const timer = setTimeout(() => { ws.terminate(); resolve(false); }, 1500);
    ws.on("open",  () => { clearTimeout(timer); ws.close(); resolve(true);  });
    ws.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

// ─── Memory display ───────────────────────────────────────────────────────────
export function printMemories(memories) {
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

// ─── Reasoning model detection ────────────────────────────────────────────────
export function detectMightThink(modelName) {
  return ["deepseek-r1", "qwen3", "qwq"].some(m => modelName.toLowerCase().includes(m));
}

// ─── stderr suppression shim ──────────────────────────────────────────────────
export function makeStderrShim() {
  return (chunk, encoding, callback) => {
    if (typeof encoding === "function") encoding();
    else if (typeof callback === "function") callback();
    return true;
  };
}