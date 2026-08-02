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
  clearDocSessionCache, docSessionId,
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

  // Invalidate this connection's doc_batch dedup cache BEFORE acknowledging:
  // the switch wipes messages[] (the parent context note replaces them), so
  // anything the model "already read" on this socket is no longer reachable —
  // a client that answers the ack with an immediate chat must never race a
  // doc_batch call ahead of the invalidation and get a stale "already read"
  // pointer (llamacpp-multiturn-latency.md Step 3 review, round 10, P2).
  // Optional-chained: a stub/injected agent (e2e's injectAgent fixture) has
  // no clearDocSessionCache at all.
  await clearDocSessionCache?.(docSessionId);

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
  clearDocSessionCache, docSessionId, sessionId, msgAttachments, sessionHadAttachments,
}) {
  const session = getSession(id);
  if (!session) {
    send("error", { text: "Session not found." });
    return null;
  }

  // Snapshot the connection's pre-resume messages so a failed resume can be
  // rolled back (see the catch below), and so the eventual finalise of the
  // session being LEFT (further down) sees its real content even though
  // `messages` itself gets wiped and reused for the resume target next
  // (round 12, P2 — finalising eagerly here, before resume is confirmed to
  // succeed, could delete/overwrite this session while the switch itself
  // never completes).
  const priorMessages = messages.slice();

  // Reset in-memory state for the fresh resume
  messages.length = 0;

  // Invalidate this connection's doc_batch dedup cache BEFORE any model work
  // or the ack: the resume replaces messages[] with compact context, so a
  // document read before the reset is no longer model-visible — a doc_batch
  // on the immediately-following chat must not hit a stale "already read"
  // pointer. Awaiting here completes the MCP round trip before the ack goes
  // out, so the client can never race the invalidation (llamacpp-multiturn-
  // latency.md Step 3 review, round 10, P2). Optional-chained: a stub agent
  // (e2e's injectAgent fixture) has no clearDocSessionCache.
  await clearDocSessionCache?.(docSessionId);

  send("thinking");

  // Inject only the compact context — NOT the full transcript
  messages.push({ role: "user", content: buildResumeContext(session) });

  // isolatedProviderSession: true — the connection's providerSessionSourceId
  // hasn't switched to `id` yet (that happens in wsHandler.js after this call
  // returns), and the wrapped runAgentLoop injects aperioSessionId from that
  // still-stale value. Without this, a Codex-backed resume would continue
  // whatever thread was previously active on the connection instead of
  // starting fresh for the resumed session.
  try {
    await runAgentLoop(
      messages, emitter,
      { noTools: true, lang: currentLang, extraSystem: RESUME_SYSTEM_INSTRUCTIONS, isolatedProviderSession: true },
      getAbort,
      setAbort,
    );
  } catch (err) {
    // Resume failed after `messages` was already wiped for the target session.
    // The caller never applies `result` (it's never returned), so `sessionId`
    // stays the OLD id on this socket — restore `messages` to match it, or
    // the connection would be left with the old id but the new session's
    // compact resume context as its "conversation" (round 12, P2).
    messages.length = 0;
    messages.push(...priorMessages);
    throw err;
  } finally {
    setAbort(null);
  }

  // Finalise the session this connection is leaving (usually its TEMPORARY
  // session from connection open) only now that resume has actually
  // succeeded: finalising it before the bootstrap runAgentLoop above could
  // delete/overwrite it even when the switch itself never completes (round
  // 12, P2). Uses the snapshot, not `messages` (already repurposed for the
  // resumed session above) — a real pre-resume conversation is persisted as
  // its own session, and an empty temp session — every socket creates one,
  // and this switch abandons it — is deleted together with its llama log,
  // instead of every resume leaking an empty session file and unfinished log
  // state (llamacpp-multiturn-latency.md Step 3 review, round 11, P2; mirrors
  // handleBranchConversation's finalise-first-relative-to-its-own-switch
  // order). Skipped for an unchanged-id resume (resuming the session already
  // active on this socket): the file must survive for getSession above, and
  // close-time finaliseSession already handles it.
  if (sessionId !== id) {
    finaliseSession(sessionId, priorMessages, msgAttachments, sessionHadAttachments);
  }

  send("session_resumed", { id, title: session.title });

  // titleSet stays true (don't overwrite title from the resume message);
  // the provider thread pointer follows the resumed session's history.
  // sessionId must follow too — it is the persisted-conversation identity
  // used for appendSummary/finaliseSession/sessionLogger/etc (wsHandler.js).
  // It is deliberately NOT this connection's doc_batch dedup namespace (see
  // wsHandler.js's `docSessionId`, a separate id fixed for the connection's
  // lifetime) — two sockets resuming the SAME persisted session would
  // otherwise share one dedup cache keyed by this id, even though each
  // socket's `messages` (and therefore what its own model has actually seen)
  // is independent (llamacpp-multiturn-latency.md Step 3, round 6, P1).
  return { sessionId: id, titleSet: true, providerSessionSourceId: id };
}
