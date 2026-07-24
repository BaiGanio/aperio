// lib/terminal/signals.js
// Shared signal handling for both terminal modes: Esc-to-stop, double-tap
// Ctrl+C to quit, the readline Tab-completer, and the in-process restart
// spawn. Reads/writes the mutable state in state.js, which proxy.js and
// standalone.js also touch.

import { emitKeypressEvents } from "readline";
import { spawn } from "child_process";
import { R, GRAY, RESET_SCROLL, stopSpinner } from "../utils/chat-utils.js";
import { finaliseSession } from "../helpers/sessions.js";
import { state } from "./state.js";

// Canonical slash commands — drive Tab-completion and the "unknown command"
// hint. Common ones first so Tab-cycle surfaces them earliest. "remember that …"
// is intentionally absent: it stays a natural-language intent, not a slash command.
export const SLASH_COMMANDS = [
  "/help", "/sessions", "/resume", "/attach", "/summarize", "/memories",
  "/self", "/forget", "/handoff", "/model", "/discuss", "/examples", "/lang",
  "/restart", "/reasoning", "/stats", "/status", "/config", "/clear", "/exit",
];

// readline completer (Tab): when the line starts with "/", offer matching
// commands; otherwise stay out of the way. Returns [matches, line] per Node's
// completer contract.
export function slashCompleter(line) {
  if (!line.startsWith("/")) return [[], line];
  const hits = SLASH_COMMANDS.filter((c) => c.startsWith(line.toLowerCase()));
  return [hits.length ? hits : SLASH_COMMANDS, line];
}

// Abort an in-flight response (standalone AbortController or proxy "stop").
// Returns true if something was actually stopped. Shared by Ctrl+C and Esc.
export function stopGeneration() {
  if (state.standaloneAbort) {
    state.standaloneAbort.abort();
    state.standaloneAbort = null;
    return true; // catch block in promptUser will re-prompt
  }
  if (state.proxyWaiting && state.proxySafeSend) {
    state.proxyWaiting = false;
    state.proxySafeSend({ type: "stop" });
    stopSpinner();
    return true; // stream_end from server will re-prompt via emitter
  }
  return false;
}

// `restart --hard` / proxy `restart`: relaunch the CLI. Node has no execvp, so
// we spawn a replacement that inherits the terminal and keep this process alive
// only to forward the child's exit code (so the shell job stays in foreground).
// A fresh process always boots a new session and reloads .env/config.
// `beforeSpawn` does mode-specific teardown (finalise session / close socket).
export function restartProcess({ rl, beforeSpawn } = {}) {
  try { beforeSpawn?.(); } catch { /* best effort */ }
  try { stopSpinner(); } catch { /* */ }
  process.stdout.write(`\n${GRAY}  restarting Aperio…${R}\n`);
  process.stdout.write(RESET_SCROLL);
  try { rl?.close(); } catch { /* */ }
  try { process.stdin.pause(); } catch { /* */ }
  const child = spawn(process.argv[0], process.argv.slice(1), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => process.exit(1));
}

// Wires the Esc-to-stop keypress handler and the double-tap-Ctrl+C-to-quit
// SIGINT handler. Called once at module load from the lib/terminal.js entry.
export function registerSignalHandlers() {
  // ─── Esc — interrupt the current response (no-op when idle) ───────────────
  // Users coming from the chat UI expect Esc to stop generation; Ctrl+C carries
  // the "quit the program" association and is kept for that (double-tap below).
  // Guarded on isTTY: raw-mode keypress only applies to a real terminal, and
  // registering the listener on a non-TTY stdin (e.g. the test runner) would
  // resume the stream and keep the process from exiting.
  if (process.stdin.isTTY) {
    try {
      emitKeypressEvents(process.stdin);
      process.stdin.on("keypress", (_str, key) => {
        if (key?.name === "escape" && !key.ctrl && !key.meta && !key.shift) {
          if (stopGeneration()) process.stdout.write(`\n${GRAY}  ⊘ stopped${R}\n`);
        }
      });
    } catch { /* keypress unavailable — Ctrl+C still works */ }
  }

  // ─── Graceful Ctrl+C — abort generation first, then double-tap to exit ───────
  let sigintCount = 0;
  process.on("SIGINT", () => {
    // Abort any in-flight response first (re-prompt handled by the caller)
    if (stopGeneration()) return;
    // Double-tap to exit
    sigintCount++;
    if (sigintCount === 1) {
      stopSpinner();
      process.stdout.write(`\n${GRAY}  Press Ctrl+C again to quit.${R}\n\n`);
      setTimeout(() => { sigintCount = 0; }, 2000);
    } else {
      if (state.sessionId && state.sessionMessages) {
        // Ctrl+C quit interrupts the session — keep it (if the user engaged),
        // don't judge it trivial and delete in-progress work. See finaliseSession.
        try { finaliseSession(state.sessionId, state.sessionMessages, null, false, { onShutdown: true }); } catch { /* non-fatal */ }
        state.sessionId = null;
        state.sessionMessages = null;
      }
      process.stdout.write(RESET_SCROLL);
      process.stdout.write(`${GRAY}  bye${R}\n`);
      process.exit(0);
    }
  });
  process.on("exit", () => { process.stdout.write(RESET_SCROLL); });
}
