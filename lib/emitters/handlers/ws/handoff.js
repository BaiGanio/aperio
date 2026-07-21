// lib/emitters/handlers/ws/handoff.js
// `handoff` message: generate a handoff document (per the `handoff` skill) and
// write it to var/handoffs/ so a fresh agent can pick the work up cold.

import { join } from "path";
import logger from "../../../helpers/logger.js";
import { ensureSecureDir, writeSecureFile } from "../../../helpers/secureFile.js";
import { redactSecrets } from "../../../helpers/redactSecrets.js";
import { appendSummary } from "../../../helpers/sessions.js";
import { buildHistoryText } from "./helpers.js";

const HANDOFFS_DIR = join(process.cwd(), "var/handoffs");

export async function handleHandoff(focus, { messages, sessionId, currentLang, runAgentLoop, emitter, sessionLogger, send }) {
  if (messages.length < 2) {
    send("handoff_written", { ok: false, reason: "Not enough conversation to hand off yet." });
    return;
  }

  send("thinking");

  const focusLine = (focus && typeof focus === "string" && focus.trim())
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

  let doc = "";
  try {
    doc = await runAgentLoop(
      [{ role: "user", content: handoffPrompt }],
      emitter,
      { noTools: true, lang: currentLang },
      () => null, () => {},
    );
  } catch (err) {
    sessionLogger.error("handleHandoff runAgentLoop error", { err: err.message, stack: err.stack });
    logger.error("[ws] handleHandoff error:", err);
    send("handoff_written", { ok: false, reason: err.message });
    return;
  }

  // Write under <project>/var/handoffs/ — matches the var/sessions, var/logs pattern.
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = focusLine.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "session";
  const path = join(HANDOFFS_DIR, `aperio-handoff-${iso}-${slug}.md`);

  try {
    // DATA-01: scrub secrets and write 0600 (the handoff doc is a shareable brief).
    ensureSecureDir(HANDOFFS_DIR);
    writeSecureFile(path, redactSecrets(doc));
  } catch (err) {
    sessionLogger.error("handleHandoff writeFile error", { err: err.message, path });
    send("handoff_written", { ok: false, reason: `Failed to write handoff: ${err.message}` });
    return;
  }

  // Record the handoff as a session summary BEFORE the rotation wipes
  // messages[]. Two reasons, mirroring handleSummarize: it preserves the
  // rotated-away history as resumable context (buildResumeContext reads the
  // latest summary), and it marks the session as substantial so finalisation
  // on socket close keeps it — without this, a handed-off session whose
  // compressed messages[] falls under the trivial threshold would be
  // deleted (the same data-loss the wasSummarized guard fixes for summaries).
  try { appendSummary(sessionId, { content: doc, messages }); } catch { /* non-fatal */ }

  // ── In-session rotation ─────────────────────────────────────────────────
  // The whole point of a handoff is to escape the dumb zone. Replace the
  // bloated in-memory history with the handoff doc itself, so the current
  // agent picks up cold with a small, dense brief — same idea as
  // handleSummarize, but anchored on the handoff document.
  const firstMsg = messages[0];
  messages.length = 0;
  if (firstMsg) messages.push(firstMsg);
  messages.push({
    role: "assistant",
    content: `[Handoff brief — rotated from prior context]\n\n${doc}\n\n[End handoff]`,
  });

  logger.info(`[ws] handoff written + context rotated: ${path}`);
  send("handoff_written", { ok: true, path, rotated: true });
}
