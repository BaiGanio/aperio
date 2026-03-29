#!/usr/bin/env node
/**
 * scripts/chat.js — Aperio terminal chat
 *
 * Auto-detects whether an Aperio server is already running.
 *   PROXY      → server found on SERVER_PORT → thin WebSocket client
 *   STANDALONE → no server → boots agent directly via lib/agent.js
 *
 * Output style:
 *   You: <your message>       ← what you type
 *   A: <streamed answer>    ← the response
 *
 * Commands (type at any You: prompt):
 *   exit · clear · memories · reasoning
 *
 * package.json:
 *   "chat:local": "AI_PROVIDER=ollama PORT=31338 node scripts/chat.js"
 *   "start:lite": "AI_PROVIDER=ollama PORT=31337 DB_BACKEND=lancedb CHECK_RAM=false node server.js"
 *
 * Set DEBUG=1 to see raw stderr from sub-processes.
 */

import { WebSocket }        from "ws";
import { createInterface }  from "readline";
import { fileURLToPath }    from "url";
import { dirname, resolve } from "path";
import { createRequire }    from "module";
import dotenv               from "dotenv";
import { createAgent, makeCliEmitter } from "./agent.js";

// ─── Suppress subprocess stderr noise ────────────────────────────────────────
if (!process.env.DEBUG) {
  process.stderr.write = () => true;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, "..");
dotenv.config({ path: resolve(ROOT, ".env") });

const require = createRequire(import.meta.url);
const { version } = require(resolve(ROOT, "package.json"));

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_PORT = parseInt(process.env.SERVER_PORT || "31337", 10);

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const R      = "\x1b[0m";
const BOLD   = "\x1b[1m";
const CYAN   = "\x1b[36m";
const GRAY   = "\x1b[90m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";

// ─── Spinner ──────────────────────────────────────────────────────────────────
let _spinnerTimer = null;
function startSpinner(label = "thinking") {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  process.stdout.write(`\r${GRAY}${frames[i]} ${label}${R}   `);
  _spinnerTimer = setInterval(() => {
    i = (i + 1) % frames.length;
    process.stdout.write(`\r${GRAY}${frames[i]} ${label}${R}   `);
  }, 80);
}
function stopSpinner() {
  if (_spinnerTimer) { clearInterval(_spinnerTimer); _spinnerTimer = null; }
  process.stdout.write(`\r${" ".repeat(40)}\r`);
}

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner(mode, model, showReasoning) {
  console.clear();
  console.log(`${BOLD}${CYAN}  Aperio${R}  ${GRAY}${mode}  •  ${model}${R}`);
  console.log(`${GRAY}  ${"─".repeat(46)}${R}`);
  console.log(`${GRAY}  commands: exit  clear  memories  reasoning${R}`);
  if (showReasoning) console.log(`${GRAY}  reasoning: ${GREEN}on${R}`);
  console.log();
}

// ─── Readline ─────────────────────────────────────────────────────────────────
function ask(rl, question) {
  return new Promise(res => rl.question(question, res));
}

// "You: " label printed before user types
function printQ() {
  process.stdout.write(`${YELLOW}${BOLD}You:${R} `);
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

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 1 — PROXY  (server already running, we connect as a thin client)
// ══════════════════════════════════════════════════════════════════════════════
async function runProxy(port, initialReasoning) {
  let showReasoning = initialReasoning;

  const ws = new WebSocket(`ws://localhost:${port}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  let model = "server";
  printBanner(`proxy :${port}`, model, showReasoning);

  // Start the greeting spinner — will be cleared by first emitter.send()
  startSpinner("waking up");

  let pendingMemories = false;

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning });
  }

  // We need one emitter instance that survives across turns in proxy mode
  // (it's stateless now so we can recreate per turn — use a wrapper)
  let currentEmitter = makeEmitter();

  ws.on("message", data => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "provider") {
      model = `${msg.name} (${msg.model})`;
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

  ws.on("close", () => {
    stopSpinner();
    console.log(`\n${GRAY}  disconnected${R}\n`);
    process.exit(0);
  });

  // Kick off server greeting
  ws.send(JSON.stringify({ type: "init" }));

  function promptUser() {
    // Rebuild emitter so showReasoning is current
    currentEmitter = makeEmitter();
    printQ();

    rl.once("line", line => {
      const cmd = line.trim();
      if (!cmd)            { promptUser(); return; }
      if (cmd === "exit")  { console.log(`${GRAY}  bye${R}`); process.exit(0); }
      if (cmd === "clear") { console.clear(); promptUser(); return; }

      if (cmd === "memories") {
        pendingMemories = true;
        ws.send(JSON.stringify({ type: "get_memories" }));
        return;
      }

      if (cmd === "reasoning") {
        showReasoning = !showReasoning;
        console.log(`\n${GRAY}  reasoning: ${showReasoning ? GREEN + "on" : RED + "off"}${R}\n`);
        promptUser(); return;
      }

      startSpinner("thinking");
      ws.send(JSON.stringify({ type: "chat", text: cmd }));
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MODE 2 — STANDALONE  (no server, boot everything here)
// ══════════════════════════════════════════════════════════════════════════════
async function runStandalone(initialReasoning) {
  let showReasoning = initialReasoning;

  // Boot agent (stderr suppressed above)
  let agent;
  try {
    agent = await createAgent({ root: ROOT, version, clientName: "aperio-chat-cli" });
  } catch (e) {
    // stderr is suppressed so we must print the actual error ourselves
    process.stdout.write(`${RED}  failed to start agent: ${e.message}${R}\n`);
    process.exit(1);
  }

  const {
    runAgentLoop, handleRememberIntent, fetchMemories,
    buildGreeting, OLLAMA_NO_TOOLS, provider,
  } = agent;

  printBanner("standalone", `${provider.name} (${provider.model})`, showReasoning);

  const rl       = createInterface({ input: process.stdin, output: process.stdout });
  const messages = [];

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning });
  }

  function promptUser() {
    printQ();

    rl.once("line", async line => {
      const cmd = line.trim();
      if (!cmd)            { promptUser(); return; }
      if (cmd === "exit")  { console.log(`${GRAY}  bye${R}`); process.exit(0); }
      if (cmd === "clear") { console.clear(); promptUser(); return; }

      if (cmd === "memories") {
        try   { const { parsed } = await fetchMemories(); console.log(); printMemories(parsed); }
        catch { console.log(`${GRAY}  no memories${R}\n`); }
        promptUser(); return;
      }

      if (cmd === "reasoning") {
        showReasoning = !showReasoning;
        console.log(`\n${GRAY}  reasoning: ${showReasoning ? GREEN + "on" : RED + "off"}${R}\n`);
        promptUser(); return;
      }

      messages.push({ role: "user", content: cmd });
      startSpinner("thinking");

      // Intercept "remember that …" for no-tools models (deepseek-r1 etc.)
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
  // Ask about reasoning only if the loaded model is a thinking model,
  // or if SHOW_REASONING=true is set explicitly.
  const modelName  = (process.env.OLLAMA_MODEL || "").toLowerCase();
  const mightThink = ["deepseek-r1", "qwen3", "qwq"].some(m => modelName.includes(m))
    || process.env.SHOW_REASONING === "true";

  let showReasoning = false;
  if (mightThink) {
    const setupRl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await ask(setupRl, `${GRAY}show reasoning? (y/N) ${R}`);
    setupRl.close();
    showReasoning = ans.trim().toLowerCase() === "y";
  }

  // Probe for a running server
  const serverRunning = await probeServer(SERVER_PORT);
  if (serverRunning) {
    await runProxy(SERVER_PORT, showReasoning);
  } else {
    await runStandalone(showReasoning);
  }
})();