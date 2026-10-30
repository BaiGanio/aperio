// lib/terminal/proxy.js
// MODE 1 — PROXY: a thin WebSocket client to a running Aperio server.

import { WebSocket } from "ws";
import { createInterface } from "readline";
import { createRequire } from "module";
import { dirname, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
import {
  R, BOLD, DIM, GRAY, GREEN, RED, YELLOW,
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
import { attachmentMaxCount } from "../helpers/attachmentLimits.js";
import {
  buildDecisionMessage, createPendingDecisions, isDecisionCommand, planDecision,
  renderConfirmPending, renderInterrupts, renderInterruptDecided, renderPendingList,
} from "./confirm.js";
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

/**
 * Run the thin WebSocket client against a server on `port`.
 *
 * `deps` is the test seam, matching runStandalone's: `stdin`/`stdout` are the
 * readline streams and where this module prints. It lets the real router and
 * command dispatcher be driven against a stub server, so the confirmation and
 * interrupt flows (#539, P1) are exercised over an actual socket without
 * booting Aperio or touching a database.
 *
 * @param {number} port
 * @param {boolean} initialReasoning
 * @param {object} [deps]
 */
export async function runProxy(port, initialReasoning, deps = {}) {
  const stdin  = deps.stdin  ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  /** Everything this module prints. ui.js and chat-utils.js still write to
   *  process.stdout directly — threading `out` through them is its own step. */
  const out = (text) => stdout.write(text);

  let showReasoning = initialReasoning;
  let showStats     = false;
  let showExamples  = readCliPrefs().examples;
  let lang          = resolveLang();
  const rl = createInterface({ input: stdin, output: stdout, prompt: QUESTION_PROMPT, completer: slashCompleter });

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

  // Round-table capability, as the server reports it in every `provider`
  // message. #539's P1: `/discuss on` used to flip a local boolean and announce
  // success even when the server could not run the configured pair — it then
  // silently served a normal chat turn. The terminal now refuses with the
  // server's own reason instead of lying.
  let roundtableAvailable = false;
  let roundtableReason    = null;

  // What is awaiting a decision. Lives out here, not in the emitter: a fresh
  // emitter is built for every prompt, and a pending write must outlive the
  // turn that proposed it (and a reconnect, which replays `interrupts`).
  const pending = createPendingDecisions();

  // Confirmation banners are buffered rather than printed on arrival. They land
  // mid-turn while the spinner is running, and the connect-time `interrupts`
  // replay lands during "waking up", so writing them straight out would garble
  // the spinner line. Flushed by promptUser(), which also puts them directly
  // above the input line where the user is about to answer.
  let decisionNotice = "";

  function onDecisionEvent(msg) {
    if (msg.type === "action_confirm_pending") {
      pending.setConfirm(msg);
      decisionNotice += renderConfirmPending(pending.list()[0]);
      return;
    }
    if (msg.type === "interrupts") {
      pending.setInterrupts(msg.interrupts);
      const entries = pending.list();
      const durable = entries.filter(e => e.kind === "interrupt");
      // The live proposal, if any, is item 1 and was already rendered on its
      // own event — number the durable rows after it, never from 1 again.
      decisionNotice += renderInterrupts(durable, entries.length - durable.length);
      return;
    }
    decisionNotice += renderInterruptDecided(msg);
  }

  function makeEmitter() {
    return makeCliEmitter(
      promptUser,
      { stopSpinner, startSpinner, onDecisionEvent },
      { showReasoning, showStats, out },
    );
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
        out(`\n${DIM}  [connected to Aperio v${version}]${R}\n`);
        startSpinner("waking up");
      }
      ws.send(JSON.stringify({ type: "init", lang }));
    });

    ws.on("close", () => {
      if (_intentionalClose) { out(RESET_SCROLL); process.exit(0); return; }
      stopSpinner();
      state.proxyWaiting = false;
      out(`\n${GRAY}  ⟳ disconnected — reconnecting…${R}\n`);
      _reconnectTimer = setTimeout(connect, 1500);
    });

    ws.on("error", () => {});

    ws.on("message", data => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "provider") {
        updateHeaderModel(`${msg.name} (${msg.model})`);
        roundtableAvailable = msg.roundtableAvailable === true;
        roundtableReason    = msg.roundtableReason ?? null;
        // A /model switch can take round table away mid-session. Drop the mode
        // rather than keep claiming it for turns the server will not honour.
        if (!roundtableAvailable && roundtableMode) {
          roundtableMode = false;
          out(`\n${GRAY}  discuss mode: ${R}${RED}off${R}${GRAY} — ${roundtableReason || "round table is unavailable on this provider"}${R}\n`);
        }
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
        out(`\n${GREEN}  ✓ memory deleted${R}\n\n`);
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

  /**
   * Shut the client down without leaving the event loop spinning.
   *
   * The `close` handler re-dials after 1.5s, by design: a proxy session must
   * survive a server restart. That makes an un-closed client immortal, so
   * anything that starts one and does not exit the process (a test, an embedder)
   * needs this. Listeners come off first, exactly as the /restart path does, so
   * the close handler's process.exit(0) does not fire.
   */
  function close() {
    _intentionalClose = true;
    state.proxySafeSend = null;
    clearTimeout(_reconnectTimer);
    if (ws) {
      try { ws.removeAllListeners(); ws.close(); } catch { /* already gone */ }
    }
    stopSpinner();
    try { rl.close(); } catch { /* already closed */ }
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

  // Queue one attachment: bounded read, count check, then re-prompt. The count
  // is checked here as a courtesy so the user learns the budget before a read;
  // processAttachments on the server is the authority (S2.10).
  async function queueAttachment(filePath) {
    const max = attachmentMaxCount();
    if (pendingAttachments.length >= max) {
      // Deliberately does NOT name /detach: that command is parked (S2.8a), and
      // a refusal that points at a command the user does not have is worse than
      // one that does not.
      out(`\n${RED}  ✖ already holding ${max} attachments (the limit) — send your message to clear the queue${R}\n\n`);
      promptUser();
      return;
    }
    try {
      const att = await readAttachment(filePath);
      if (att.error) {
        out(`\n${RED}  ✖ ${att.error}${R}\n\n`);
      } else {
        pendingAttachments.push(att);
        out(`\n${GREEN}  📎 queued: ${att.name} (${att.sizeKb} KB) — will be sent with your next message${R}\n\n`);
      }
    } catch (e) {
      out(`\n${RED}  ✖ could not read ${filePath}: ${e.message}${R}\n\n`);
    }
    promptUser();
  }

  function promptUser() {
    state.proxyWaiting = false;
    currentEmitter = makeEmitter();
    if (decisionNotice) {
      out(decisionNotice);
      decisionNotice = "";
    }
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
        out(RESET_SCROLL);
        out(`${GRAY}  bye${R}\n`);
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
        out(`\n${GRAY}  reasoning: ${label}${R}\n\n`);
        promptUser();
        return;
      }

      if (isHelpCommand(cmd)) {
        const target = parseHelpTarget(cmd);
        if (target) printHelpFor(target, { proxy: true, lang });
        else        printHelp({ proxy: true, showExamples, lang, version });
        promptUser();
        return;
      }

      if (isExamplesCommand(cmd)) {
        showExamples = !showExamples;
        writeCliPrefs({ ...readCliPrefs(), examples: showExamples });
        const label = showExamples ? `${GREEN}on${R}` : `${RED}off${R}`;
        out(`\n${GRAY}  examples: ${label}${R}\n\n`);
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
        out(`\n${GRAY}  stats: ${label}${R}\n\n`);
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
          out(`\n${GRAY}  usage: /model <provider> <name>${R}\n  e.g. /model llamacpp Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M\n       /model anthropic claude-haiku-4-5-20251001\n\n`);
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

      if (isDecisionCommand(cmd)) {
        const plan = planDecision(pending, cmd);
        if (plan.action === "list") {
          out(renderPendingList(pending.list()));
          promptUser();
          return;
        }
        if (plan.action === "error") {
          out(`\n${RED}  \u2716 ${plan.message}${R}\n\n`);
          promptUser();
          return;
        }
        const { entry, decision } = plan;
        pending.remove(entry);

        const message = buildDecisionMessage(plan);
        if (!message) {
          // Rejecting a live proposal is local — see buildDecisionMessage.
          out(`\n${GRAY}  \u2715 rejected \u2014 ${entry.tool} did not run${R}\n\n`);
          promptUser();
          return;
        }

        state.proxyWaiting = true;
        startSpinner(decision === "reject" ? "rejecting" : "applying");
        safeSend(message);
        return;
      }

      if (isAttachCommand(cmd)) {
        // `readAttachment` is async (S2.10), but this line handler is not, and
        // making it async would change the control flow of every other branch
        // in this dispatcher. The await is isolated in queueAttachment instead,
        // which owns its own output and re-prompt.
        queueAttachment(cmd.replace(/^attach\s+/i, "").trim());
        return;
      }

      if (isDiscussCommand(cmd)) {
        const arg = cmd.trim().split(/\s+/)[1]?.toLowerCase();
        const want = arg === "on" ? true : arg === "off" ? false : !roundtableMode;
        // Capability-aware (#539, acceptance criterion 3): the server announces
        // roundtableAvailable + the reason it is not, so an unavailable pair is
        // refused with that reason rather than reported as enabled.
        if (want && !roundtableAvailable) {
          out(
            `\n${YELLOW}  \u26a0 round table is unavailable:${R} ${GRAY}${roundtableReason || "the server has no second agent configured"}${R}\n` +
            `${DIM}  Configure a verifier model in Settings \u2192 Provider & Models, then try again.${R}\n\n`
          );
          promptUser();
          return;
        }
        roundtableMode = want;
        const label = roundtableMode ? `${GREEN}on${R}` : `${RED}off${R}`;
        out(`\n${GRAY}  discuss mode: ${label}${R}${roundtableMode ? `\n${DIM}  Next messages will use two-agent deliberation.${R}` : ""}\n\n`);
        promptUser();
        return;
      }

      if (raw.startsWith("/")) {
        const name = cmd.split(/\s+/)[0] || "";
        out(`\n${GRAY}  unknown command: ${R}${BOLD}/${name}${R}${GRAY} — type ${R}${BOLD}/help${R}${GRAY} for the full list${R}\n\n`);
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

  return { close };
}
