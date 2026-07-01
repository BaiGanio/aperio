/**
 * lib/terminal/commands.js — pure command predicates & small utilities for the
 * terminal chat client.
 *
 * Extracted from lib/terminal.js (Gap 4, predicate split). These functions are
 * side-effect-free, individually unit-tested, and re-exported from
 * lib/terminal.js for backward-compatible import paths.
 */

/**
 * Determines if a command string is empty
 */
export function isEmptyCommand(cmd) {
  return !cmd.trim();
}

/**
 * Determines if a command is the 'exit' command
 */
export function isExitCommand(cmd) {
  return cmd.trim() === "exit";
}

/**
 * Determines if a command is the 'clear' command
 */
export function isClearCommand(cmd) {
  return cmd.trim() === "clear";
}

/**
 * Determines if a command is the 'memories' command
 */
export function isMemoriesCommand(cmd) {
  return cmd.trim() === "memories";
}

/**
 * Determines if a command is the 'self' command — oversight read of the agent's
 * own walled-off memory store.
 */
export function isSelfCommand(cmd) {
  return cmd.trim() === "self";
}

/**
 * Determines if a command is the 'reasoning' command
 */
export function isReasoningCommand(cmd) {
  return cmd.trim() === "reasoning";
}

/**
 * Determines if a command is a "remember that" intent
 */
export function isRememberIntent(cmd) {
  return /^remember\s+that\b/i.test(cmd);
}

/**
 * Checks if provider is ollama (case-insensitive)
 */
export function isOllamaProvider(providerName) {
  return (providerName || "").toLowerCase() === "ollama";
}

/**
 * Toggles reasoning visibility
 */
export function toggleReasoning(currentState) {
  return !currentState;
}

/**
 * Constructs WebSocket URL from port
 */
export function buildWebSocketUrl(port) {
  return `ws://localhost:${port}`;
}

/**
 * Validates port number
 */
export function isValidPort(port) {
  return typeof port === "number" && port > 0 && port < 65536;
}

/**
 * Gets default model name
 */
export function getDefaultModel() {
  return "llama3.1";
}

/**
 * Normalizes model name to lowercase
 */
export function normalizeModelName(name) {
  return name.toLowerCase();
}

/**
 * Validates model name is not empty
 */
export function isValidModelName(name) {
  return name.trim().length > 0;
}

/**
 * Formats ANSI colored text
 */
export function formatColoredText(text, colorCode, resetCode = "\x1b[0m") {
  return `${colorCode}${text}${resetCode}`;
}

/**
 * Creates a message object for the queue
 */
export function createMessage(role, content) {
  return { role, content };
}

/**
 * Adds a message to queue and returns new queue
 */
export function addMessageToQueue(messages, role, content) {
  return [...messages, createMessage(role, content)];
}

/**
 * Parses JSON message safely
 */
export function parseMessage(data) {
  try {
    return JSON.parse(data.toString());
  } catch (e) {
    return null;
  }
}

/**
 * Checks if WebSocket is open
 */
export function isWebSocketOpen(ws) {
  return !!(ws && ws.readyState === 1);
}

/**
 * Gets reconnection delay in milliseconds
 */
export function getReconnectionDelay() {
  return 1500;
}

/**
 * Handles SIGINT counter logic
 */
export function handleSigint(currentCount) {
  return currentCount + 1;
}

/**
 * Checks if double-tap exit threshold is met (requires 2+ presses)
 */
export function shouldExitOnSigint(count) {
  return count >= 2;
}

/**
 * Checks if command is a special command (not regular chat). Mirrors the
 * terminal dispatch: control commands are slash-prefixed (/help, /sessions …),
 * while empty input and the natural-language "remember that …" intent are
 * handled without a slash. A bare control word (e.g. "help") is regular chat.
 */
export function isSpecialCommand(cmd) {
  const trimmed = cmd.trim();
  if (isEmptyCommand(cmd) || isRememberIntent(trimmed)) return true;
  if (!trimmed.startsWith("/")) return false;
  const c = trimmed.slice(1).trim();
  return (
    isExitCommand(c) ||
    isClearCommand(c) ||
    isMemoriesCommand(c) ||
    isSelfCommand(c) ||
    isReasoningCommand(c) ||
    isSummarizeCommand(c) ||
    isForgetCommand(c) ||
    isHandoffCommand(c) ||
    isSessionsCommand(c) ||
    isResumeCommand(c) ||
    isModelCommand(c) ||
    isAttachCommand(c) ||
    isDiscussCommand(c) ||
    isHelpCommand(c) ||
    isExamplesCommand(c) ||
    isLangCommand(c) ||
    isRestartCommand(c) ||
    isStatsCommand(c) ||
    isStatusCommand(c) ||
    isConfigCommand(c)
  );
}

/**
 * Creates an empty message queue
 */
export function createMessageQueue() {
  return [];
}

/**
 * Gets queue length
 */
export function getQueueLength(messages) {
  return messages.length;
}

/**
 * Gets message from queue by index
 */
export function getMessageFromQueue(messages, index) {
  return messages[index] || null;
}

/**
 * Checks if command is the 'summarize' command
 */
export function isSummarizeCommand(cmd) {
  return cmd.trim() === "summarize";
}

/**
 * Checks if command is a forget command with an id (e.g. "forget abc-123")
 */
export function isForgetCommand(cmd) {
  return /^forget\s+\S+/.test(cmd.trim());
}

/**
 * Checks if command is a handoff command (e.g. "handoff" or "handoff <focus>")
 */
export function isHandoffCommand(cmd) {
  return /^handoff(\s|$)/i.test(cmd.trim());
}

/**
 * Checks if command is the 'sessions' command
 */
export function isSessionsCommand(cmd) {
  return cmd.trim() === "sessions";
}

/**
 * Checks if command is a model-switch command (e.g. "model ollama llama3.1")
 */
export function isModelCommand(cmd) {
  return /^model(\s|$)/i.test(cmd.trim());
}

/**
 * Checks if command is an attach command (e.g. "attach <path>")
 */
export function isAttachCommand(cmd) {
  return /^attach\s+\S+/.test(cmd.trim());
}

/**
 * Checks if command is a discuss command (e.g. "discuss on" / "discuss off")
 */
export function isDiscussCommand(cmd) {
  return /^discuss(\s+(on|off))?$/i.test(cmd.trim());
}

/**
 * Checks if command is a resume command (e.g. "resume <id>")
 */
export function isResumeCommand(cmd) {
  return /^resume\s+\S+/.test(cmd.trim());
}

/**
 * Command names that have focused `help <command>` docs (#178). Single source of
 * truth, kept here in the pure module; lib/terminal.js's HELP_DETAILS must cover
 * exactly these keys (enforced by a unit test). Restricting to known names keeps
 * plain chat like "help me plan my week" from being mistaken for a help request.
 */
export const HELP_TARGETS = new Set([
  "attach", "summarize", "remember", "memories", "forget",
  "sessions", "resume", "handoff", "discuss", "examples",
  "lang", "restart", "reasoning", "stats", "status", "config",
]);

/**
 * Checks if command asks for help — bare ("help" / "?") or focused on a known
 * command ("help attach"). "help me …" and "help bogus" are not help: an unknown
 * trailing token falls through to normal chat.
 */
export function isHelpCommand(cmd) {
  const t = cmd.trim();
  if (/^(help|\?)$/i.test(t)) return true;
  const m = t.match(/^(?:help|\?)\s+(\S+)$/i);
  return !!(m && HELP_TARGETS.has(m[1].toLowerCase()));
}

/**
 * Extracts the target of a focused help request ("help attach" → "attach"), or
 * null for bare help or an unknown target. Used to pick per-command docs vs. the
 * full guide (#178).
 */
export function parseHelpTarget(cmd) {
  const m = cmd.trim().match(/^(?:help|\?)\s+(\S+)$/i);
  const t = m && m[1].toLowerCase();
  return t && HELP_TARGETS.has(t) ? t : null;
}

/**
 * Checks if command toggles the runnable `try:` examples in help (#178)
 */
export function isExamplesCommand(cmd) {
  return cmd.trim().toLowerCase() === "examples";
}

/**
 * Checks if command sets or shows the interface language — bare "lang" (show
 * current) or "lang <code>" (switch). #178 Phase 4.
 */
export function isLangCommand(cmd) {
  return /^lang(\s+\S+)?$/i.test(cmd.trim());
}

/**
 * Extracts the requested language code ("lang de" → "de"), or null for bare
 * "lang". Validity is checked by the caller against the known locale list.
 */
export function parseLang(cmd) {
  const m = cmd.trim().match(/^lang\s+(\S+)$/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Checks if command restarts Aperio: "restart" (new session) or
 * "restart --hard" (full process re-exec). #178 follow-up.
 */
export function isRestartCommand(cmd) {
  return /^restart(\s+--hard)?$/i.test(cmd.trim());
}

/**
 * True only for "restart --hard" (full process re-exec).
 */
export function isHardRestart(cmd) {
  return /^restart\s+--hard$/i.test(cmd.trim());
}

/**
 * Checks if command toggles the per-answer stats footer
 */
export function isStatsCommand(cmd) {
  return cmd.trim().toLowerCase() === "stats";
}

/**
 * Checks if command asks for the technical status line
 */
export function isStatusCommand(cmd) {
  return cmd.trim().toLowerCase() === "status";
}

/**
 * Checks if command asks for the config diagnostic (effective values + sources).
 */
export function isConfigCommand(cmd) {
  return cmd.trim().toLowerCase() === "config";
}
