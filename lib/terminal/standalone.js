// lib/terminal/standalone.js
// MODE 2 — STANDALONE: boots the agent directly (no running server).

import { createInterface } from "readline";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import {
  R, BOLD, GRAY, GREEN, RED, YELLOW,
  RESET_SCROLL,
  clearScreen,
  initHeader, updateHeaderModel, updateHeaderLang, updateHeaderReasoning,
  startSpinner, stopSpinner,
  printQ, QUESTION_PROMPT,
  printMemories,
} from "../utils/chat-utils.js";
import { ensureSecureDir, writeSecureFile } from "../helpers/secureFile.js";
import { redactSecrets } from "../helpers/redactSecrets.js";
import { ensureLlamaCpp } from "../helpers/startLlamaCpp.js";
import { makeCliEmitter } from "../emitters/cliEmitter.js";
import {
  init as initSessions, createSession, setSessionTitle, appendSummary,
  finaliseSession, sessionScratchDir, getSession, buildResumeContext,
  RESUME_SYSTEM_INSTRUCTIONS,
} from "../helpers/sessions.js";
import { readCliPrefs, writeCliPrefs } from "../helpers/cliPrefs.js";
import {
  isExitCommand, isClearCommand, isMemoriesCommand, isSelfCommand,
  isReasoningCommand, isRememberIntent, isLlamaCppProvider, isHelpCommand,
  parseHelpTarget, isExamplesCommand, isLangCommand, isRestartCommand,
  isHardRestart, isStatsCommand, isStatusCommand, isConfigCommand,
  isSummarizeCommand, isForgetCommand, isHandoffCommand, isSessionsCommand,
  isModelCommand, isAttachCommand, buildAttachedUserContent, isDiscussCommand,
  isResumeCommand,
} from "./commands.js";
import { printWelcome, printHelp, printHelpFor, printStatus, printConfig, printSessions, resolveLang, handleLangCommand } from "./ui.js";
import { readAttachment, buildWorkspaceDirective } from "./attachments.js";
import {
  createPendingDecisions, isDecisionCommand, planDecision,
  renderConfirmPending, renderInterrupts, renderInterruptDecided, renderPendingList,
} from "./confirm.js";
import { restartProcess, slashCompleter } from "./signals.js";
import { state } from "./state.js";
import { hydrateTerminalRuntime } from "./runtime.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { version } = require(resolve(ROOT, "package.json"));

const SUMMARIZE_INTENT_RE = /\b(summarize|summarise|summarization|summary|recap)\b.*\b(our|this|the)?\s*(conversation|chat|discussion|session|history|we('ve| have) (discussed|talked|covered))\b|\bsummarize\s+(it|this|everything|all)\b|\b(tl;?dr|tldr)\b/i;

// ── Standalone helper functions (extracted for testability) ──────────────────

/**
 * Build a plain-text conversation transcript from an array of messages.
 * Filters out tool turn messages and flattens multi-part content to text.
 * @param {object[]} msgs
 * @returns {string}
 */
export function buildHistoryText(msgs) {
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

/**
 * Normalize message content arrays to plain text strings in place.
 * Removes messages that end up with empty content. Mutates the array.
 * @param {object[]} msgs
 */
export function normalizeMessages(msgs) {
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

/**
 * Boot the agent in-process and run the terminal loop.
 *
 * `deps` is the test seam (#539 / T2.6). Everything the loop reaches the outside
 * world through can be handed in, so the loop itself can be driven without a
 * provider, a database, a model, or the developer's own var/ directory:
 *
 *   stdin, stdout       the readline streams, and where this module prints
 *   root                anchors var/sessions, var/scratch, var/handoffs
 *   createAgent         the agent factory; supplying it also skips the engine
 *                       boot, since an injected agent is already ready
 *   hydrateRuntime      config + allowed-folders hydration
 *   processAttachments  attachment ingestion
 *
 * ⚠ IMPORT-ORDER CONTRACT (see the dynamic imports below): the injected
 * variants replace the dynamic imports, they do not move them. A static
 * top-level import of any of these modules freezes process.env values at
 * import time and defeats the Settings UI. Read those comments before
 * touching this function's imports.
 *
 * @param {boolean} initialReasoning
 * @param {object} [deps]
 */
export async function runStandalone(initialReasoning, deps = {}) {
  const stdin  = deps.stdin  ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const root   = deps.root   ?? ROOT;
  /** Everything this module prints. ui.js and chat-utils.js still write to
   *  process.stdout directly — threading `out` through them is its own step. */
  const out = (text) => stdout.write(text);

  let showReasoning = initialReasoning;
  let showStats     = false;
  let showExamples  = readCliPrefs().examples;
  let lang          = resolveLang();

  // Config + allowed-folders hydration. Lives in ./runtime.js because it must
  // run before ANY module that reads process.env into a module-level constant
  // is imported — see the import-order contract there.
  const { runWithPaths, getAllowlist } = await (deps.hydrateRuntime ?? hydrateTerminalRuntime)({
    log: (msg) => out(`${GRAY}  (${msg})${R}\n`),
  });

  // Deferred for that same reason, one step removed: lib/handlers/attachments
  // statically imports lib/routes/paths.js, so importing it at the top of this
  // file re-froze DEFAULT_PATHS no matter how paths.js itself was imported.
  const processAttachments = deps.processAttachments
    ?? (await import("../handlers/attachments/index.js")).processAttachments;

  // Dynamic, not a static top-level import (P2 review finding): lib/agent.js
  // re-exports lib/agent/index.js, which imports tool-profiles.js — and that
  // module reads process.env.APERIO_TOOL_PIN_TURNS into a module-level
  // constant AT IMPORT TIME. A static `import { createAgent } from
  // "../agent.js"` at the top of this file would have resolved and evaluated
  // that constant before runStandalone() even started, let alone before the
  // applyConfigToEnv() call above — silently freezing it at whatever
  // .env/default value was present pre-hydration and making a Settings-UI
  // override of APERIO_TOOL_PIN_TURNS permanently ineffective in standalone
  // mode. server.js/hydrateRuntime.js already avoid this class of bug
  // entirely by deferring every agent-graph import behind a dynamic
  // `await import(...)` after config hydration; this mirrors that pattern.
  const createAgent = deps.createAgent ?? (await import("../agent.js")).createAgent;

  // An injected agent is already running; booting a second llama.cpp beside it
  // would be a stray process with nothing to serve.
  const isLlamaCpp = !deps.createAgent && isLlamaCppProvider(process.env.AI_PROVIDER);

  if (isLlamaCpp) {
    out(`${GRAY}  Starting llama.cpp engine…${R}\n`);
    try {
      await ensureLlamaCpp();
      out(`${GREEN}  ✓ llama.cpp ready${R}\n\n`);
    } catch (e) {
      out(`\n${RED}  ✖ Could not start llama.cpp: ${e.message}${R}\n\n`);
      process.exit(1);
    }
  }

  let agent;
  try {
    agent = await createAgent({ root, version, clientName: "aperio-chat-cli" });
  } catch (e) {
    out(`${RED}  failed to start agent: ${e.message}${R}\n`);
    process.exit(1);
  }

  const { runAgentLoop: baseRunAgentLoop, handleRememberIntent, fetchMemories, buildGreeting, NO_TOOLS, provider, callTool } = agent;

  // Session management. Per-session scratch workspace for skill-generated
  // artifacts — same model as the web path: tools write here and it's pruned
  // with the session, injected into the chat turn's system prompt and threaded
  // via runWithPaths. These are `let` so an in-process `restart` can roll over
  // to a brand-new session without re-booting the process.
  initSessions(root);
  let sessionId, scratchDir, workspaceDirective;
  let providerSessionSourceId = null;
  function startNewSession() {
    sessionId = createSession({ model: provider.model, provider: provider.name, source: "terminal" });
    providerSessionSourceId = sessionId;
    state.sessionId = sessionId;
    scratchDir = sessionScratchDir(sessionId);
    workspaceDirective = buildWorkspaceDirective(scratchDir);
  }
  startNewSession();
  const runAgentLoop = (messages, emitter, opts = {}, getAbort, setAbort) =>
    baseRunAgentLoop(
      messages,
      emitter,
      provider.name === "codex"
        ? { ...opts, aperioSessionId: providerSessionSourceId }
        : opts,
      getAbort,
      setAbort,
    );

  initHeader("standalone", `${provider.name} (${provider.model})`, showReasoning, lang);

  const rl       = createInterface({ input: stdin, output: stdout, prompt: QUESTION_PROMPT, completer: slashCompleter });
  const messages = [];
  state.sessionMessages = messages;
  // True once messages[0] is the synthetic resume-context note (handleResume
  // below) rather than the user's real first turn — mirrors wsHandler.js's
  // per-connection flag of the same name. A fresh session's messages[0] is
  // always real: nothing seeds a greeting into `messages` here either.
  state.firstMessageSynthetic = false;
  let pendingAttachmentBlocks = [];  // content blocks queued via `attach`, sent with next message

  let abortController = null;
  let titleSet        = false;

  // What is awaiting a decision (#539, P1). Outside makeEmitter() on purpose: a
  // fresh emitter is built for every turn, and a pending write must outlive the
  // turn that proposed it.
  const pending = createPendingDecisions();

  // Buffered, not printed on arrival: the event lands mid-turn with the spinner
  // running, so writing straight out would garble the spinner line. promptUser()
  // flushes it directly above the input line.
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
      decisionNotice += renderInterrupts(durable, entries.length - durable.length);
      return;
    }
    decisionNotice += renderInterruptDecided(msg);
  }

  /**
   * Carry out a decision in-process. No server, so no `confirm_action` message:
   * the token is redeemed by calling the tool with it, which is exactly what the
   * WS handler falls back to when the interrupt row is not in the database
   * (handleConfirmAction's 404 branch). Same tool, same validation, no model
   * round-trip and no raw-token workaround.
   *
   * Only approve and reject are offered here. `edit` and `respond` go through
   * the interrupt service, which needs the store that createAgent() does not
   * expose; planDecision refuses them for a confirm entry, so the user is told
   * rather than left guessing.
   */
  async function handleDecision(plan) {
    const { entry, decision } = plan;
    pending.remove(entry);

    // A one-shot token executes nothing until it is redeemed, so dropping it IS
    // the rejection.
    if (decision === "reject") {
      out(`\n${GRAY}  \u2715 rejected \u2014 ${entry.tool} did not run${R}\n\n`);
      promptUser();
      return;
    }

    startSpinner("applying");
    try {
      const result = await callTool(entry.tool, { confirmation_token: entry.token });
      const text = typeof result === "string"
        ? result
        : (Array.isArray(result) ? result.find(b => b.type === "text")?.text ?? "Done." : "Done.");
      stopSpinner();
      // Into the transcript, so the model's next turn knows the action ran.
      messages.push({ role: "assistant", content: text });
      out(`\n${GREEN}  \u2713 ${entry.tool}${R}\n${text}\n\n`);
    } catch (e) {
      stopSpinner();
      out(`\n${RED}  \u2716 ${entry.tool} failed: ${e.message}${R}\n\n`);
    }
    promptUser();
  }

  function makeEmitter() {
    return makeCliEmitter(
      promptUser,
      { stopSpinner, startSpinner, onDecisionEvent },
      { showReasoning, showStats, out },
    );
  }

  async function handleSummarize() {
    if (messages.length < 3) {
      out(`\n${GRAY}  Not enough history to summarize.${R}\n\n`);
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
    const summaryEmitter = makeCliEmitter(() => {}, { stopSpinner, startSpinner }, { showReasoning, out });

    let summary = "";
    try {
      summary = await runAgentLoop(summaryMessages, summaryEmitter, { noTools: true });
    } catch (e) {
      stopSpinner();
      out(`\n${RED}  summarize failed: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    try { appendSummary(sessionId, { content: summary, messages, firstMessageSynthetic: state.firstMessageSynthetic }); } catch { /* non-fatal */ }

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

    out(`\n${GREEN}  ✓ Summarized${saved ? " and saved to memory" : ""}.${R}\n\n`);
    promptUser();
  }

  async function handleHandoff(focus) {
    if (messages.length < 2) {
      out(`\n${YELLOW}  ⚠ not enough conversation to hand off yet.${R}\n\n`);
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

    const handoffEmitter = makeCliEmitter(() => {}, { stopSpinner, startSpinner }, { showReasoning, out });

    let doc = "";
    try {
      doc = await runAgentLoop([{ role: "user", content: handoffPrompt }], handoffEmitter, { noTools: true });
    } catch (e) {
      stopSpinner();
      out(`\n${RED}  handoff failed: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    const HANDOFFS_DIR = resolve(root, "var/handoffs");
    const iso  = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = focusLine.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
    const filePath = resolve(HANDOFFS_DIR, `aperio-handoff-${iso}-${slug}.md`);

    try {
      // DATA-01: handoffs may quote secrets/personal context — scrub and lock down.
      ensureSecureDir(HANDOFFS_DIR);
      writeSecureFile(filePath, redactSecrets(doc));
    } catch (e) {
      out(`\n${RED}  failed to write handoff: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    // Record the handoff as a session summary BEFORE the rotation wipes
    // messages[] — same as the /summarize path. Preserves the rotated-away
    // history as resumable context and marks the session substantial, so
    // finalisation doesn't later delete a handed-off session whose compressed
    // messages[] fell under the trivial threshold.
    try { appendSummary(sessionId, { content: doc, messages, firstMessageSynthetic: state.firstMessageSynthetic }); } catch { /* non-fatal */ }

    const firstMsg = messages[0];
    messages.length = 0;
    if (firstMsg) messages.push(firstMsg);
    messages.push({ role: "assistant", content: `[Handoff brief — rotated from prior context]\n\n${doc}\n\n[End handoff]` });

    out(`\n${GREEN}  ✓ handoff written:${R} ${filePath}\n\n`);
    promptUser();
  }

  async function handleResume(id) {
    const session = getSession(id);
    if (!session) {
      out(`\n${RED}  session not found: ${id}${R}\n\n`);
      promptUser();
      return;
    }

    out(`\n${GRAY}  ⟳ resuming "${session.title ?? "Untitled"}"…${R}\n`);
    // Resume changes the persisted-conversation identity as well as the
    // provider thread. Rebind every session-scoped runtime value before the
    // resumed turn so artifacts, summaries, and close/restart finalisation all
    // target the resumed session rather than the temporary CLI session.
    sessionId = id;
    state.sessionId = id;
    scratchDir = sessionScratchDir(id);
    workspaceDirective = buildWorkspaceDirective(scratchDir);
    messages.length = 0;
    titleSet = true;
    providerSessionSourceId = id;
    messages.push({ role: "user", content: buildResumeContext(session) });
    state.firstMessageSynthetic = true;
    startSpinner();

    try {
      await runWithPaths(getAllowlist(), getAllowlist(), scratchDir, () =>
        runAgentLoop(messages, makeEmitter(), { noTools: true, extraSystem: RESUME_SYSTEM_INSTRUCTIONS })
      );
    } catch (e) {
      stopSpinner();
      if (e.name !== "AbortError")
        out(`\n${RED}  resume error: ${e.message}${R}\n\n`);
      promptUser();
    }
  }

  function promptUser() {
    // Reset abort state at the start of each user turn
    abortController  = null;
    state.standaloneAbort = null;
    if (decisionNotice) {
      out(decisionNotice);
      decisionNotice = "";
    }
    printQ();
    rl.once("line", async line => {
      const raw = line.trim();
      if (!raw) { promptUser(); return; }
      // Control commands are slash-prefixed (/help, /sessions, …); strip the "/"
      // and route through the bare-word predicates. Non-slash input is normal
      // chat, so "summarize this" and "help me plan" reach the model untouched.
      // "remember that …" stays a natural-language intent (no slash needed).
      const cmd = raw.startsWith("/") ? raw.slice(1).trim() : "";

      if (isExitCommand(cmd)) {
        try {
          finaliseSession(sessionId, messages, null, false, { firstMessageSynthetic: state.firstMessageSynthetic });
        } catch { /* non-fatal */ }
        state.sessionId = null;
        state.sessionMessages = null;
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
        try   { const { parsed } = await fetchMemories(); out("\n"); printMemories(parsed); }
        catch { out(`${GRAY}  no memories${R}\n\n`); }
        promptUser();
        return;
      }

      if (isSelfCommand(cmd)) {
        // The agent's own walled-off notes. callTool routes through self_recall,
        // which is local-only — on a cloud provider it returns the 🔒 notice.
        try   { const text = await callTool("self_recall", { limit: 200 }); out(`\n${typeof text === "string" ? text : ""}\n\n`); }
        catch { out(`${GRAY}  no self-memories${R}\n\n`); }
        promptUser();
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
        if (target) printHelpFor(target, { proxy: false, lang });
        else        printHelp({ proxy: false, showExamples, lang, version });
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
        updateHeaderLang(lang);  // reflected by `status` and the next screen redraw
        promptUser();
        return;
      }

      if (isRestartCommand(cmd)) {
        if (isHardRestart(cmd)) {
          restartProcess({
            rl,
            beforeSpawn: () => {
              try {
                finaliseSession(sessionId, messages, null, false, { firstMessageSynthetic: state.firstMessageSynthetic });
              } catch { /* */ }
              state.sessionId = null;
            },
          });
          return;
        }
        // Soft: save the current session, then start a fresh one in-process.
        try {
          finaliseSession(sessionId, messages, null, false, { firstMessageSynthetic: state.firstMessageSynthetic });
        } catch { /* non-fatal */ }
        if (abortController) { try { abortController.abort(); } catch { /* */ } abortController = null; }
        messages.length = 0;
        pendingAttachmentBlocks = [];
        titleSet = false;
        state.firstMessageSynthetic = false;
        startNewSession();
        clearScreen();
        await greet();
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
        await printConfig();
        promptUser();
        return;
      }

      if (isSummarizeCommand(cmd)) {
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
          out(`\n${GRAY}  usage: /model <provider> <name>${R}\n  e.g. /model llamacpp Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M\n       /model anthropic claude-haiku-4-5-20251001\n\n`);
          promptUser();
          return;
        }
        const [, prov, ...rest] = parts;
        const prevProvider = agent.provider.name;
        try {
          agent.setProvider({ name: prov, model: rest.join(" ") });
          if (prevProvider !== agent.provider.name) normalizeMessages(messages);
          updateHeaderModel(`${agent.provider.name} (${agent.provider.model})`);
          out(`\n${GREEN}  ✓ switched to ${agent.provider.name} / ${agent.provider.model}${R}\n\n`);
        } catch (e) {
          out(`\n${RED}  model switch failed: ${e.message}${R}\n\n`);
        }
        promptUser();
        return;
      }

      if (isForgetCommand(cmd)) {
        const id = cmd.replace(/^forget\s+/, "").trim();
        try {
          await callTool("forget", { id });
          out(`\n${GREEN}  ✓ memory deleted${R}\n\n`);
        } catch (e) {
          out(`\n${RED}  delete failed: ${e.message}${R}\n\n`);
        }
        promptUser();
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
        await handleDecision(plan);
        return;
      }

      if (isAttachCommand(cmd)) {
        const filePath = cmd.replace(/^attach\s+/i, "").trim();
        const att = await readAttachment(filePath);
        if (att.error) {
          out(`\n${RED}  ✖ ${att.error}${R}\n\n`);
          promptUser();
          return;
        }
        startSpinner("reading attachment");
        try {
          const { contentBlocks } = await processAttachments([att], root, {
            storageDir: join(scratchDir, "attachments"),
            urlBase: `/scratch/${sessionId}/attachments`,
          });
          pendingAttachmentBlocks.push(...contentBlocks);
          stopSpinner();
          out(`\n${GREEN}  📎 queued: ${att.name} (${att.sizeKb} KB) — will be sent with your next message${R}\n\n`);
        } catch (e) {
          stopSpinner();
          out(`\n${RED}  ✖ attach failed: ${e.message}${R}\n\n`);
        }
        promptUser();
        return;
      }

      if (isDiscussCommand(cmd)) {
        out(
          `\n${YELLOW}  ⚠ Round-table (discuss) needs the Aperio server running.${R}\n` +
          `${GRAY}  It uses two agents deliberating together, which lives on the server.${R}\n` +
          `${DIM}  Start it in another terminal with ${R}${BOLD}npm run start:local${R}${DIM}, then run ${R}${BOLD}npm run chat:local${R}${DIM} again —${R}\n` +
          `${DIM}  it connects automatically and ${R}${BOLD}/discuss on${R}${DIM} will work.${R}\n\n`
        );
        promptUser();
        return;
      }

      if (raw.startsWith("/")) {
        const name = cmd.split(/\s+/)[0] || "";
        out(`\n${GRAY}  unknown command: ${R}${BOLD}/${name}${R}${GRAY} — type ${R}${BOLD}/help${R}${GRAY} for the full list${R}\n\n`);
        promptUser();
        return;
      }

      // Regular chat message
      if (!titleSet && raw) {
        setSessionTitle(sessionId, raw);
        titleSet = true;
      }

      // Append any queued attachment blocks to this message's content. The
      // user's typed text must stay the FIRST block — see
      // buildAttachedUserContent's doc comment.
      const userContent = buildAttachedUserContent(pendingAttachmentBlocks, raw);
      pendingAttachmentBlocks = [];

      messages.push({ role: "user", content: userContent });
      startSpinner();

      if (NO_TOOLS && isRememberIntent(raw)) {
        await handleRememberIntent(raw, makeEmitter());
        promptUser();
        return;
      }

      // Route natural-language summarize intents through handleSummarize
      if (SUMMARIZE_INTENT_RE.test(raw)) {
        await handleSummarize();
        return;
      }

      try {
        await runWithPaths(getAllowlist(), getAllowlist(), scratchDir, () =>
          runAgentLoop(
            messages, makeEmitter(), { extraSystem: workspaceDirective, lang },
            () => abortController,
            (c) => { abortController = c; state.standaloneAbort = c; }
          )
        );
      } catch (e) {
        stopSpinner();
        abortController  = null;
        state.standaloneAbort = null;
        if (e.name === "AbortError") {
          out(`\n${GRAY}  ↩ generation stopped${R}\n\n`);
        } else {
          out(`\n${RED}  error: ${e.message}${R}\n\n`);
        }
        promptUser();
      }
    });
  }

  // Welcome banner + static greeting (prompt-cache hygiene, WS2 — no model call:
  // instant, zero provider cost). Used at boot and again after an in-process
  // `restart`. No background cache warm-up here: unlike the WS path, the CLI is
  // single-request/blocking (readline waits for the previous turn before the next
  // can start), so there is no concurrent "next message could arrive" scenario to
  // warm ahead of.
  async function greet() {
    printWelcome({ showExamples, lang });
    try {
      const { staticGreeting } = await buildGreeting(lang);
      // buildGreeting persists the preloaded memories on the agent (sessionMemCtx),
      // so they ride along in every turn's system prompt — no per-call injection
      // needed here.
      const emitter = makeEmitter();
      emitter.send({ type: "stream_start" });
      emitter.send({ type: "token", text: staticGreeting });
      emitter.send({ type: "stream_end" });
    } catch (e) {
      out(`\n${RED}  startup error: ${e.message}${R}\n\n`);
      promptUser();
    }
  }

  await greet();
}
