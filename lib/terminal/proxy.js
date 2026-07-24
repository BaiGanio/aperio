// lib/terminal/proxy.js
// MODE 1 — PROXY: a thin WebSocket client to a running Aperio server.

import { WebSocket } from "ws";
import { createInterface } from "readline";
import { createRequire } from "module";
import { dirname, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import {
  R, BOLD, DIM, GRAY, GREEN, RED,
  RESET_SCROLL,
  clearScreen,
  initHeader, updateHeaderModel, updateHeaderReasoning,
  startSpinner, stopSpinner,
  ask, printQ, QUESTION_PROMPT,
  printMemories,
} from "../utils/chat-utils.js";
import { makeCliEmitter } from "../emitters/cliEmitter.js";
import { readCliPrefs, writeCliPrefs } from "../helpers/cliPrefs.js";
import {
  isExitCommand, isClearCommand, isMemoriesCommand, isSelfCommand,
  isReasoningCommand, isHelpCommand, parseHelpTarget, isExamplesCommand,
  isLangCommand, isRestartCommand, isStatsCommand, isStatusCommand,
  isConfigCommand, isSummarizeCommand, isHandoffCommand, isSessionsCommand,
  isResumeCommand, isModelCommand, isForgetCommand, isAttachCommand,
  isDiscussCommand,
} from "./commands.js";
import { printWelcome, printHelp, printHelpFor, printStatus, printConfig, printSessions, resolveLang, handleLangCommand } from "./ui.js";
import { readAttachment } from "./attachments.js";
import { restartProcess, slashCompleter } from "./signals.js";
import { state } from "./state.js";

const require = createRequire(import.meta.url);
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "../..");
const { version } = require(resolvePath(ROOT, "package.json"));

/**
 * Map an AI_PROVIDER value to the env-var name that stores its model override.
 * Extracted for testability.
 * @param {string} provider
 * @returns {string}
 */
export function proxyModelVar(provider) {
  const p = (provider || "").toLowerCase();
  if (p === "llamacpp") return "LLAMACPP_MODEL";
  if (p === "deepseek") return "DEEPSEEK_MODEL";
  if (p === "gemini")   return "GEMINI_MODEL";
  if (p === "codex")    return "CODEX_MODEL";
  return "ANTHROPIC_MODEL";
}

export async function runProxy(port, initialReasoning) {
  let showReasoning = initialReasoning;
  let showStats     = false;
  let showExamples  = readCliPrefs().examples;
  let lang          = resolveLang();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: QUESTION_PROMPT, completer: slashCompleter });

  let ws;
  let _intentionalClose    = false;
  let _reconnectTimer      = null;
  let pendingMemories      = false;
  let pendingSelf          = false;
  let pendingDelete        = null;
  let pendingAttachments   = [];   // queued via `attach <path>`, sent with next message
  let roundtableMode       = false;
  let _connectedPrinted    = false;  // one-time "[connected]" line on first open
  let currentEmitter;

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning, showStats });
  }

  // Register for SIGINT stop — function declaration is hoisted within runProxy
  state.proxySafeSend = safeSend;

  function connect() {
    ws = new WebSocket(`ws://localhost:${port}`);

    ws.on("open", () => {
      clearTimeout(_reconnectTimer);
      // Confirm the link once — quiet on reconnects (those print their own
      // ⟳ disconnected/reconnecting lines). Pauses the "waking up" spinner so
      // the line lands cleanly, then resumes it while the server greets us.
      if (!_connectedPrinted) {
        _connectedPrinted = true;
        stopSpinner();
        process.stdout.write(`\n${DIM}  [connected to Aperio v${version}]${R}\n`);
        startSpinner("waking up");
      }
      ws.send(JSON.stringify({ type: "init", lang }));
    });

    ws.on("close", () => {
      if (_intentionalClose) { process.stdout.write(RESET_SCROLL); process.exit(0); return; }
      stopSpinner();
      state.proxyWaiting = false;
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
      if (msg.type === "self_memories" && pendingSelf) {
        pendingSelf = false;
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
        state.proxyWaiting = false;
      }
      currentEmitter.send(msg);
    });
  }

  const pmv = proxyModelVar(process.env.AI_PROVIDER);
  initHeader(`proxy :${port}`, `${process.env.AI_PROVIDER} (${process.env[pmv]})`, showReasoning, lang);
  printWelcome({ showExamples, lang });
  startSpinner("waking up");
  currentEmitter = makeEmitter();
  connect();

  function safeSend(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function promptUser() {
    state.proxyWaiting = false;
    currentEmitter = makeEmitter();
    printQ();

    rl.once("line", line => {
      const raw = line.trim();
      if (!raw) { promptUser(); return; }
      // Control commands are slash-prefixed (/help, /sessions, …); strip the "/"
      // and route through the bare-word predicates. Non-slash input is normal
      // chat sent to the server untouched.
      const cmd = raw.startsWith("/") ? raw.slice(1).trim() : "";

      if (isExitCommand(cmd)) {
        _intentionalClose = true;
        state.proxySafeSend = null;
        process.stdout.write(RESET_SCROLL);
        console.log(`${GRAY}  bye${R}`);
        process.exit(0);
      }

      if (isClearCommand(cmd)) {
        clearScreen();
        promptUser();
        return;
      }

      if (isMemoriesCommand(cmd)) {
        pendingMemories = true;
        safeSend({ type: "get_memories" });
        return;
      }

      if (isSelfCommand(cmd)) {
        pendingSelf = true;
        safeSend({ type: "get_self_memories" });
        return;
      }

      if (isReasoningCommand(cmd)) {
        showReasoning = !showReasoning;
        updateHeaderReasoning(showReasoning);
        const label = showReasoning ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  reasoning: ${label}${R}\n\n`);
        promptUser();
        return;
      }

      if (isHelpCommand(cmd)) {
        const target = parseHelpTarget(cmd);
        if (target) printHelpFor(target, { proxy: true, lang });
        else        printHelp({ proxy: true, showExamples, lang });
        promptUser();
        return;
      }

      if (isExamplesCommand(cmd)) {
        showExamples = !showExamples;
        writeCliPrefs({ ...readCliPrefs(), examples: showExamples });
        const label = showExamples ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  examples: ${label}${R}\n\n`);
        promptUser();
        return;
      }

      if (isLangCommand(cmd)) {
        lang = handleLangCommand(cmd, lang);
        safeSend({ type: "set_lang", lang });  // tell the server to reply in this language
        promptUser();
        return;
      }

      if (isRestartCommand(cmd)) {
        // Proxy is a thin client; the server owns the session and has no reset
        // message, so both `restart` and `restart --hard` relaunch the process
        // (a fresh connection always starts a new server-side session).
        restartProcess({
          rl,
          beforeSpawn: () => {
            _intentionalClose = true;
            state.proxySafeSend = null;
            clearTimeout(_reconnectTimer);
            if (ws) { try { ws.removeAllListeners(); ws.close(); } catch { /* */ } }
          },
        });
        return;
      }

      if (isStatsCommand(cmd)) {
        showStats = !showStats;
        const label = showStats ? `${GREEN}on${R}` : `${RED}off${R}`;
        process.stdout.write(`\n${GRAY}  stats: ${label}${R}\n\n`);
        promptUser();
        return;
      }

      if (isStatusCommand(cmd)) {
        printStatus({ reasoning: showReasoning, stats: showStats, examples: showExamples, lang });
        promptUser();
        return;
      }

      if (isConfigCommand(cmd)) {
        printConfig({ port }).then(() => promptUser());
        return;
      }

      if (isSummarizeCommand(cmd)) {
        state.proxyWaiting = true;
        startSpinner("summarizing");
        safeSend({ type: "summarize" });
        return;
      }

      if (isHandoffCommand(cmd)) {
        const focus = cmd.replace(/^handoff\s*/i, "").trim();
        state.proxyWaiting = true;
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
        state.proxyWaiting = true;
        startSpinner("resuming session");
        safeSend({ type: "resume_session", id });
        return;
      }

      if (isModelCommand(cmd)) {
        const parts = cmd.trim().split(/\s+/);
        if (parts.length < 3) {
          process.stdout.write(`\n${GRAY}  usage: /model <provider> <name>${R}\n  e.g. /model llamacpp Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M\n       /model anthropic claude-haiku-4-5-20251001\n\n`);
          promptUser();
          return;
        }
        const [, prov, ...rest] = parts;
        safeSend({ type: "switch_model", provider: prov, model: rest.join(" ") });
        promptUser();
        return;
      }

      if (isForgetCommand(cmd)) {
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

      if (raw.startsWith("/")) {
        const name = cmd.split(/\s+/)[0] || "";
        process.stdout.write(`\n${GRAY}  unknown command: ${R}${BOLD}/${name}${R}${GRAY} — type ${R}${BOLD}/help${R}${GRAY} for the full list${R}\n\n`);
        promptUser();
        return;
      }

      state.proxyWaiting = true;
      startSpinner();
      const chatPayload = { type: "chat", text: raw };
      if (pendingAttachments.length > 0) {
        chatPayload.attachments = pendingAttachments.map(a => ({ name: a.name, data: a.data, type: a.type }));
        pendingAttachments = [];
      }
      if (roundtableMode) chatPayload.roundtable = true;
      safeSend(chatPayload);
    });
  }
}
