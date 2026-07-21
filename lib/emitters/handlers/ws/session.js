// lib/emitters/handlers/ws/session.js
// branch_conversation / resume_session: both switch the connection's active
// session thread. Neither owns `sessionId`/`titleSet`/`providerSessionSourceId`
// directly — each returns the new values and wsHandler.js applies them to its
// own connection-scoped locals, so there is exactly one place that owns
// per-connection state.

import logger from "../../../helpers/logger.js";
import {
  createSession, setSessionTitle, finaliseSession, getSession, buildResumeContext,
  RESUME_SYSTEM_INSTRUCTIONS,
} from "../../../helpers/sessions.js";

export async function handleBranchConversation({
  messages, sessionId, msgAttachments, sessionHadAttachments, provider, send, sessionLogger,
}) {
  if (messages.length < 2) {
    send("session_branched", { ok: false, reason: "Not enough conversation to branch yet." });
    return null;
  }

  // Finalise current session so it's saved with its current title.
  finaliseSession(sessionId, messages, msgAttachments, sessionHadAttachments);

  // Create a child session.
  const parentTitle = getSession(sessionId)?.title ?? "Untitled";
  const childId = createSession({
    model: provider().model,
    provider: provider().name,
    source: "web",
    parentId: sessionId,
  });

  // Build a compact context from the parent.
  const parent = getSession(sessionId);
  const context = parent ? buildResumeContext(parent) : `Continued from: ${parentTitle}`;

  // Switch to the child session.
  const oldSessionId = sessionId;
  messages.length = 0;

  // Inject the parent context as a system note.
  messages.push({
    role: "user",
    content: `[Branched from: ${parentTitle}]\n\n${context}\n\n[End branch context — continue exploring the tangent below]`,
  });

  setSessionTitle(childId, `↳ ${parentTitle}`);

  send("session_branched", {
    ok: true,
    id: childId,
    parentId: oldSessionId,
    title: `↳ ${parentTitle}`,
  });

  logger.info(`[ws] conversation branched: ${oldSessionId} → ${childId}`);

  return { sessionId: childId, titleSet: true, providerSessionSourceId: null };
}

export async function handleResumeSession(id, {
  messages, currentLang, runAgentLoop, emitter, send, sessionLogger, getAbort, setAbort,
}) {
  const session = getSession(id);
  if (!session) {
    send("error", { text: "Session not found." });
    return null;
  }

  // Reset in-memory state for the fresh resume
  messages.length = 0;

  send("thinking");

  // Inject only the compact context — NOT the full transcript
  messages.push({ role: "user", content: buildResumeContext(session) });

  await runAgentLoop(
    messages, emitter,
    { noTools: true, lang: currentLang, extraSystem: RESUME_SYSTEM_INSTRUCTIONS },
    getAbort,
    setAbort,
  );
  setAbort(null);

  send("session_resumed", { id, title: session.title });

  // titleSet stays true (don't overwrite title from the resume message);
  // the provider thread pointer follows the resumed session's history.
  return { titleSet: true, providerSessionSourceId: id };
}
