#!/usr/bin/env node
/**
 * lib/terminal.js — Aperio terminal chat (entry point)
 *
 * Auto-detects whether an Aperio server is already running.
 *   PROXY      → server found on SERVER_PORT → thin WebSocket client (./terminal/proxy.js)
 *   STANDALONE → no server → boots agent directly via lib/agent.js (./terminal/standalone.js)
 *
 * Pure utilities live in chat-utils.js / terminal/commands.js / terminal/strings.js
 * so they can be unit-tested and covered by c8 independently of this entry-point.
 * The mode-specific run loops live in terminal/proxy.js and terminal/standalone.js;
 * shared printers in terminal/ui.js; shared mutable interrupt/session state in
 * terminal/state.js; Esc/SIGINT/restart plumbing in terminal/signals.js.
 *
 * Voice / TTS is intentionally Web-UI-only (see public/scripts/tts.js). The
 * terminal has no audio output by design — #175 gap 3.
 *
 * Set DEBUG=1 to see raw stderr from sub-processes.
 */

// MUST be first: populates process.env from .env before any module below reads
// it at load time (db/sqlite.js captures SQLITE_PATH / EMBEDDING_DIMS on import).
import "./load-env.js";

import { WebSocket } from "ws";
import { createInterface } from "readline";
import { fileURLToPath, pathToFileURL } from "url";
import { realpathSync } from "fs";
import { isDockerAvailable } from "../db/index.js";
import { R, GRAY, initDockerState, ask, detectMightThink, makeStderrShim, parseServerPort, probeServer } from "./utils/chat-utils.js";
import { runProxy } from "./terminal/proxy.js";
import { runStandalone } from "./terminal/standalone.js";
import { registerSignalHandlers } from "./terminal/signals.js";

// ─── Suppress subprocess stderr noise ────────────────────────────────────────
if (!process.env.DEBUG) {
  process.stderr.write = makeStderrShim();
}

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_PORT = parseServerPort(process.env);

// ─── Seed docker state into chat-utils module-level vars ─────────────────────
const _dockerOn = isDockerAvailable();
initDockerState(_dockerOn);

// ─── Command predicates & pure utilities (Gap 4) ────────────────────────────
// Re-exported so existing `lib/terminal.js` import paths (incl. tests) keep working.
export {
  isEmptyCommand,
  isExitCommand,
  isClearCommand,
  isMemoriesCommand,
  isSelfCommand,
  isReasoningCommand,
  isRememberIntent,
  isLlamaCppProvider,
  toggleReasoning,
  buildWebSocketUrl,
  isValidPort,
  getDefaultModel,
  normalizeModelName,
  isValidModelName,
  formatColoredText,
  createMessage,
  addMessageToQueue,
  parseMessage,
  isWebSocketOpen,
  getReconnectionDelay,
  handleSigint,
  shouldExitOnSigint,
  isSpecialCommand,
  createMessageQueue,
  getQueueLength,
  getMessageFromQueue,
  isSummarizeCommand,
  isForgetCommand,
  isHandoffCommand,
  isSessionsCommand,
  isModelCommand,
  isAttachCommand,
  buildAttachedUserContent,
  isDiscussCommand,
  isResumeCommand,
  isHelpCommand,
  parseHelpTarget,
  HELP_TARGETS,
  isExamplesCommand,
  isLangCommand,
  parseLang,
  isRestartCommand,
  isHardRestart,
  isStatsCommand,
  isStatusCommand,
  isConfigCommand,
} from "./terminal/commands.js";

export {
  printWelcome,
  printHelp,
  printHelpFor,
  HELP_DETAILS,
  resolveLang,
  printStatus,
  printSessions,
  printConfig,
} from "./terminal/ui.js";

export { readAttachment } from "./terminal/attachments.js";

// ─── Signal handling (Esc-to-stop, double-tap Ctrl+C, Tab-completion) ────────
registerSignalHandlers();

// ══════════════════════════════════════════════════════════════════════════════
//  Entry point
// ══════════════════════════════════════════════════════════════════════════════
// Only boot the app when this file is the launched entry point. The NODE_ENV
// check stays as belt-and-suspenders, but the import.meta check is what keeps a
// bare `node --test <file>` (no NODE_ENV) from booting the whole CLI on import.
const isMainModule = import.meta.url === pathToFileURL(realpathSync(process.argv[1] || "")).href;
if (isMainModule && process.env.NODE_ENV !== "test") {
  (async () => {
    // llamacpp.md Phase 6: refuse to boot on a pre-migration .env rather than
    // silently remapping it.
    const { checkOllamaMigrationOrExit } = await import("./helpers/ollamaMigrationShim.js");
    if (checkOllamaMigrationOrExit()) return;

    const modelName = (process.env.LLAMACPP_MODEL || "").toLowerCase();
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
