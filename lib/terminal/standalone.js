// lib/terminal/standalone.js
// MODE 2 — STANDALONE: boots the agent directly (no running server).

import { createInterface } from "readline";
import { createRequire } from "module";
import { dirname, resolve } from "path";
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
import { createAgent } from "../agent.js";
import { ensureLlamaCpp } from "../helpers/startLlamaCpp.js";
import { makeCliEmitter } from "../emitters/cliEmitter.js";
import {
  init as initSessions, createSession, setSessionTitle, appendSummary,
  finaliseSession, sessionScratchDir, getSession, buildResumeContext,
  RESUME_SYSTEM_INSTRUCTIONS,
} from "../helpers/sessions.js";
import { runWithPaths, DEFAULT_READ_PATHS, DEFAULT_WRITE_PATHS } from "../routes/paths.js";
import { processAttachments } from "../handlers/attachments/index.js";
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
import { restartProcess, slashCompleter } from "./signals.js";
import { state } from "./state.js";

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

export async function runStandalone(initialReasoning) {
  let showReasoning = initialReasoning;
  let showStats     = false;
  let showExamples  = readCliPrefs().examples;
  let lang          = resolveLang();

  // Apply DB-stored config to process.env BEFORE picking a model or building the
  // agent, so standalone resolves config exactly like the server (issue #182,
  // Issue B). Without this the CLI used .env-only while the web UI used DB
  // values — same install, different effective config. Also populates the
  // provenance snapshot the /config command and ctx-clamp warning read.
  try {
    const { getStore } = await import("../../db/index.js");
    const { applyConfigToEnv } = await import("../config-resolver.js");
    const { applyLiteDefaults } = await import("../config.js");
    applyLiteDefaults(0);   // lite: pin DB_BACKEND before the store auto-detects
    await applyConfigToEnv(await getStore());
    applyLiteDefaults(1);   // lite last-resort defaults for vars still unset
  } catch (e) {
    process.stdout.write(`${GRAY}  (config: using .env/defaults — ${e.message})${R}\n`);
  }

  const isLlamaCpp = isLlamaCppProvider(process.env.AI_PROVIDER);

  if (isLlamaCpp) {
    process.stdout.write(`${GRAY}  Starting llama.cpp engine…${R}\n`);
    try {
      await ensureLlamaCpp();
      process.stdout.write(`${GREEN}  ✓ llama.cpp ready${R}\n\n`);
    } catch (e) {
      process.stdout.write(`\n${RED}  ✖ Could not start llama.cpp: ${e.message}${R}\n\n`);
      process.exit(1);
    }
  }

  let agent;
  try {
    agent = await createAgent({ root: ROOT, version, clientName: "aperio-chat-cli" });
  } catch (e) {
    process.stdout.write(`${RED}  failed to start agent: ${e.message}${R}\n`);
    process.exit(1);
  }

  const { runAgentLoop: baseRunAgentLoop, handleRememberIntent, fetchMemories, buildGreeting, NO_TOOLS, provider, callTool } = agent;

  // Session management. Per-session scratch workspace for skill-generated
  // artifacts — same model as the web path: tools write here and it's pruned
  // with the session, injected into the chat turn's system prompt and threaded
  // via runWithPaths. These are `let` so an in-process `restart` can roll over
  // to a brand-new session without re-booting the process.
  initSessions(ROOT);
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

  const rl       = createInterface({ input: process.stdin, output: process.stdout, prompt: QUESTION_PROMPT, completer: slashCompleter });
  const messages = [];
  state.sessionMessages = messages;
  let pendingAttachmentBlocks = [];  // content blocks queued via `attach`, sent with next message

  let abortController = null;
  let titleSet        = false;

  function makeEmitter() {
    return makeCliEmitter(promptUser, { stopSpinner, startSpinner }, { showReasoning, showStats });
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
      // DATA-01: handoffs may quote secrets/personal context — scrub and lock down.
      ensureSecureDir(HANDOFFS_DIR);
      writeSecureFile(filePath, redactSecrets(doc));
    } catch (e) {
      process.stdout.write(`\n${RED}  failed to write handoff: ${e.message}${R}\n\n`);
      promptUser();
      return;
    }

    // Record the handoff as a session summary BEFORE the rotation wipes
    // messages[] — same as the /summarize path. Preserves the rotated-away
    // history as resumable context and marks the session substantial, so
    // finalisation doesn't later delete a handed-off session whose compressed
    // messages[] fell under the trivial threshold.
    try { appendSummary(sessionId, { content: doc, messages }); } catch { /* non-fatal */ }

    const firstMsg = messages[0];
    messages.length = 0;
    if (firstMsg) messages.push(firstMsg);
    messages.push({ role: "assistant", content: `[Handoff brief — rotated from prior context]\n\n${doc}\n\n[End handoff]` });

    process.stdout.write(`\n${GREEN}  ✓ handoff written:${R} ${filePath}\n\n`);
    promptUser();
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
    providerSessionSourceId = id;
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
    state.standaloneAbort = null;
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
        try { finaliseSession(sessionId, messages); } catch { /* non-fatal */ }
        state.sessionId = null;
        state.sessionMessages = null;
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
        try   { const { parsed } = await fetchMemories(); console.log(); printMemories(parsed); }
        catch { console.log(`${GRAY}  no memories${R}\n`); }
        promptUser();
        return;
      }

      if (isSelfCommand(cmd)) {
        // The agent's own walled-off notes. callTool routes through self_recall,
        // which is local-only — on a cloud provider it returns the 🔒 notice.
        try   { const text = await callTool("self_recall", { limit: 200 }); console.log(`\n${typeof text === "string" ? text : ""}\n`); }
        catch { console.log(`${GRAY}  no self-memories${R}\n`); }
        promptUser();
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
        if (target) printHelpFor(target, { proxy: false, lang });
        else        printHelp({ proxy: false, showExamples, lang });
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
        updateHeaderLang(lang);  // reflected by `status` and the next screen redraw
        promptUser();
        return;
      }

      if (isRestartCommand(cmd)) {
        if (isHardRestart(cmd)) {
          restartProcess({
            rl,
            beforeSpawn: () => { try { finaliseSession(sessionId, messages); } catch { /* */ } state.sessionId = null; },
          });
          return;
        }
        // Soft: save the current session, then start a fresh one in-process.
        try { finaliseSession(sessionId, messages); } catch { /* non-fatal */ }
        if (abortController) { try { abortController.abort(); } catch { /* */ } abortController = null; }
        messages.length = 0;
        pendingAttachmentBlocks = [];
        titleSet = false;
        startNewSession();
        clearScreen();
        await greet();
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
          process.stdout.write(`\n${GRAY}  usage: /model <provider> <name>${R}\n  e.g. /model llamacpp Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M\n       /model anthropic claude-haiku-4-5-20251001\n\n`);
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

      if (isForgetCommand(cmd)) {
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
          const { contentBlocks } = await processAttachments([att], ROOT, {
            storageDir: join(scratchDir, "attachments"),
            urlBase: `/scratch/${sessionId}/attachments`,
          });
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

      if (isDiscussCommand(cmd)) {
        process.stdout.write(
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
        process.stdout.write(`\n${GRAY}  unknown command: ${R}${BOLD}/${name}${R}${GRAY} — type ${R}${BOLD}/help${R}${GRAY} for the full list${R}\n\n`);
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
        await runWithPaths(DEFAULT_READ_PATHS, DEFAULT_WRITE_PATHS, scratchDir, () =>
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
          process.stdout.write(`\n${GRAY}  ↩ generation stopped${R}\n\n`);
        } else {
          process.stdout.write(`\n${RED}  error: ${e.message}${R}\n\n`);
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
      process.stdout.write(`\n${RED}  startup error: ${e.message}${R}\n\n`);
      promptUser();
    }
  }

  await greet();
}
