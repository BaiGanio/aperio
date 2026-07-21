// lib/emitters/handlers/ws/summarize.js
// `summarize` (manual + auto-triggered) and `discuss_start`: both compress or
// preview-compress the conversation via a side (non-chat-bubble) model call.

import logger from "../../../helpers/logger.js";
import { appendSummary } from "../../../helpers/sessions.js";
import { generateEmbedding } from "../../../helpers/embeddings.js";
import { buildHistoryText } from "./helpers.js";
import { sendMemories } from "./memories.js";

export async function handleSummarize({ auto = false } = {}, {
  messages, ragStore, runAgentLoop, currentLang, sessionId, providerSessionSourceId,
  provider, resetProviderSession, callTool, emitter, makeSinkEmitter, send, sessionLogger,
  store,
} = {}) {
  if (messages.length < 3) {
    send("context_summarized", { ok: false, reason: "Not enough history to summarize." });
    return;
  }

  // In auto mode the answer was just delivered — don't restart the spinner.
  if (!auto) send("thinking");

  const history = buildHistoryText(messages);

  // Index the full transcript into RAG before it gets compressed.
  // Runs concurrently with summary generation to minimise latency.
  const ragIndexPromise = ragStore.index(messages, generateEmbedding).catch(err =>
    logger.warn("[ws] ragStore.index failed:", err.message)
  );

  const summaryMessages = [{
    role: "user",
    content: `Summarize the following conversation in 3-5 concise bullet points. Capture key topics, decisions, and any open questions. Skip pleasantries.\n\nConversation:\n${history}`,
  }];

  // Auto-summary must stay silent: stream the summary through a sink emitter
  // so it never renders as an assistant bubble. The user already received
  // their answer and only sees the context_summarized banner. A leaked
  // summary bubble reads like a broken third-person reply and carries no
  // suggestion chips, making the model look like it stopped responding.
  const summaryEmitter = auto ? makeSinkEmitter().emitter : emitter;

  let summary = "";
  try {
    summary = await runAgentLoop(
      summaryMessages, summaryEmitter,
      { noTools: true, lang: currentLang, isolatedProviderSession: provider().name === "codex" },
      () => null, () => {},
    );
  } catch (err) {
    sessionLogger.error("handleSummarize runAgentLoop error", { err: err.message, stack: err.stack });
    logger.error("[ws] handleSummarize error:", err);
    send("context_summarized", { ok: false, reason: err.message });
    return;
  }

  // Ensure RAG indexing finishes before we wipe the messages array
  await ragIndexPromise;

  // Checkpoint the full transcript + summary into the session file BEFORE wiping
  try { appendSummary(sessionId, { content: summary, messages }); } catch { /* non-fatal */ }

  // Compress the in-memory history to just the summary block
  const firstMsg = messages[0];
  messages.length = 0;
  messages.push(firstMsg);
  messages.push({ role: "assistant", content: `[Conversation summary]\n${summary}` });
  if (provider().name === "codex") {
    resetProviderSession?.(providerSessionSourceId, "codex");
  }

  // Persist to the memory store so it survives reconnects and is recallable
  let saved = false;
  try {
    const title = `Conversation — ${new Date().toLocaleDateString("en-GB", {
      day: "2-digit", month: "short", year: "numeric",
    })}`;
    await callTool("remember", {
      type: "project",
      title,
      content: summary,
      tags: ["conversation-summary"],
      importance: 3        });
    saved = true;
  } catch (err) {
    // Non-fatal — history is compressed in RAM even if persistence fails
    sessionLogger.error("handleSummarize callTool(remember) error", { err: err.message });
    logger.warn("[ws] handleSummarize: failed to persist summary to memory:", err.message);
  }

  send("context_summarized", { ok: true, saved });
  await sendMemories({ store, send, sessionLogger });
}

// The Discuss button was armed: produce a short framing summary of the
// conversation so far and offer it to the user as the prompt for the two
// round-table agents. Unlike handleSummarize, this never compresses or wipes
// history — it only generates text for the confirmation card. Returns
// { ok, summary } — wsHandler.js stores the result as `lastDiscussSummary`.
export async function handleDiscussStart({
  messages, runAgentLoop, currentLang, makeSinkEmitter, send, sessionLogger,
}) {
  // Nothing meaningful to summarize yet — let the client just arm the toggle.
  if (messages.length < 3) {
    send("discuss_summary", { ok: false });
    return { ok: false, summary: null };
  }

  const history = buildHistoryText(messages);
  const summaryMessages = [{
    role: "user",
    content: `Summarize the conversation below into a single tight paragraph (3-4 sentences) that frames the topic for two other AI agents who will debate it. State what is being discussed and what needs resolving. No bullet points, no pleasantries.\n\nConversation:\n${history}`,
  }];

  // Stream through a sink emitter so this never renders as a chat bubble —
  // the client shows it in a dedicated confirmation card instead.
  let summary = "";
  try {
    summary = await runAgentLoop(
      summaryMessages, makeSinkEmitter().emitter,
      { noTools: true, lang: currentLang },
      () => null, () => {},
    );
  } catch (err) {
    sessionLogger.error("handleDiscussStart runAgentLoop error", { err: err.message, stack: err.stack });
    logger.error("[ws] handleDiscussStart error:", err);
    send("discuss_summary", { ok: false });
    return { ok: false, summary: null };
  }

  summary = String(summary || "").trim();
  if (!summary) { send("discuss_summary", { ok: false }); return { ok: false, summary: null }; }
  send("discuss_summary", { ok: true, text: summary });
  return { ok: true, summary };
}
