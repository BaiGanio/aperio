import net from "net";
import { LANG_NAMES } from "../agent/language.js";

// ─── Config (passed in from chat.js so tests can supply their own) ────────────
// chat.js calls: import { OLLAMA_PORT, ... } from "./chat-utils.js"
// and passes OLLAMA_PORT into the functions that need it.
export function parseServerPort(env = process.env) {
  return Number.parseInt(env.SERVER_PORT || env.PORT || "31337", 10);
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

let _headerMode      = "";
let _headerModel     = "";
let _headerDockerOn  = false; // set by chat.js after isDockerAvailable()
let _headerDB        = "sqlite";
let _headerReasoning = false;
let _headerStatus    = "";
let _headerLang      = "en";

/** Allow chat.js to seed docker state after resolving isDockerAvailable(). */
export function initDockerState(dockerOn) {
  _headerDockerOn = dockerOn;
  _headerDB       = dockerOn ? "postgres" : "sqlite";
}

// The header is a one-time banner printed inline at the current cursor — NOT a
// pinned bar. An earlier version reserved the top rows with a DECSTBM scroll
// region so the header stayed put, but terminals discard lines that scroll off
// the top of a scroll region instead of saving them to scrollback — so the
// start of any long answer became unrecoverable. Printing inline lets the whole
// conversation, banner included, live in native scrollback (scroll + copy work).
export function redrawHeader() {
  const cols  = process.stdout.columns || 80;
  const sep   = "─".repeat(cols - 2);
  // Live state: "ready" when idle. While working, the spinner shows the active
  // label inline (its own \r line), so the banner doesn't need to track it.
  const state = _headerStatus ? `${YELLOW}${_headerStatus}${R}` : `${GREEN}ready${R}`;

  const line1 = `  ${BOLD}${CYAN}✦ Aperio${R}  ${GRAY}•${R}  ${_headerModel}${R}  ${GRAY}•${R}  ${state}`;
  const line2 = `${GRAY}  ${sep}${R}`;
  const line3Parts = [`${GRAY}  type ${R}${BOLD}help${R}${GRAY} for what I can do  ·  ${R}${BOLD}exit${R}${GRAY} to leave${R}`];
  if (_headerReasoning) line3Parts.push(`   ${GRAY}reasoning ${GREEN}on${R}`);
  const line3 = line3Parts.join("");
  // Navbar: the at-a-glance system strip — mode, docker, storage, language. Dim so
  // it reassures without competing with the friendly line above.
  const langName = LANG_NAMES[_headerLang] || "English";
  const line4 = `${GRAY}${DIM}  ${_headerMode}  ·  Docker ${_headerDockerOn ? "on" : "off"}  ·  ${_headerDB}  ·  ${langName}${R}`;

  process.stdout.write(`${line1}\n${line2}\n${line3}\n${line4}\n`);
}

/** Current header state, for the on-demand `status` command. */
export function getHeaderInfo() {
  return { mode: _headerMode, model: _headerModel, dockerOn: _headerDockerOn, db: _headerDB, lang: _headerLang };
}

export function initHeader(mode, model, showReasoning, lang = "en") {
  _headerMode      = mode;
  _headerModel     = model;
  _headerReasoning = showReasoning;
  _headerStatus    = "";
  _headerLang      = lang;
  process.stdout.write("\x1b[2J");
  process.stdout.write(moveTo(1));
  redrawHeader();
  process.stdout.write("\n");
}

// The header banner is printed once and scrolls away with the conversation, so
// these setters only update tracked state (read back by getHeaderInfo() and the
// `status` command). They intentionally do NOT repaint — there's no pinned bar
// to repaint, and the spinner already surfaces live working state inline.
export function setHeaderStatus(text) {
  _headerStatus = text;
}

export function updateHeaderModel(model) {
  _headerModel = model.trim();
}

export function updateHeaderLang(lang) {
  _headerLang = lang;
}

export function updateHeaderReasoning(val) {
  _headerReasoning = val;
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

// The input prompt. Shared so readline can be told its prompt is exactly this
// (createInterface({ prompt: QUESTION_PROMPT })) — otherwise readline keeps its
// default "> " and repaints it over "You:" on backspace / line refresh.
export const QUESTION_PROMPT = `${YELLOW}${BOLD}You:${R} `;

export function printQ() {
  process.stdout.write(QUESTION_PROMPT);
}

// `clear` / soft-restart: wipe the screen and redraw the banner. The navbar lives
// in the banner — printed once at the top — and is deliberately NOT reprinted
// between messages, so the conversation flows uninterrupted into native scrollback.
export function clearScreen() {
  process.stdout.write("\x1b[2J");
  process.stdout.write(moveTo(1));
  redrawHeader();
  process.stdout.write("\n");
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