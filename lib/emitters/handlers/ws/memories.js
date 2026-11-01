// lib/emitters/handlers/ws/memories.js
// Read-only memory/interrupt broadcast helpers and the delete_memory handler.
// Each takes an explicit `deps` bag rather than closing over connection state.

import logger from "../../../helpers/logger.js";
import { serializeInterrupt } from "../../../routes/api-interrupts.js";

/** Push current memories to the sidebar via store.listAll() so the pinned
 *  field and full memory list are always fresh without text-parsing overhead. */
export async function sendMemories({ store, send, sessionLogger }) {
  try {
    const rows = await store.listAll();
    const memories = rows.map(m => ({
      id:         m.id,
      type:       m.type,
      title:      m.title,
      content:    m.content,
      tags:       m.tags ?? [],
      importance: m.importance ?? 3,
      createdAt:  m.created_at instanceof Date ? m.created_at.toISOString() : (m.created_at ?? null),
      pinned:     m.pinned ?? false,
    }));
    send("memories", { memories });
  } catch (err) {
    sessionLogger.error("sendMemories error", { err: err.message });
    logger.error(`[ws] Failed to fetch memories: ${err.message}`);
  }
}

/** Oversight read of the agent's own walled-off store. Goes straight to
 *  store.listSelf() — NOT through the local-only handler gate — because this
 *  is the *user* auditing the store, not a model reading it. So it works
 *  regardless of the active provider. */
export async function sendSelfMemories({ store, send, sessionLogger }) {
  try {
    const rows = await store.listSelf(200);
    const memories = rows.map(m => ({
      id:         m.id,
      title:      m.title,
      content:    m.content,
      tags:       m.tags ?? [],
      importance: m.importance ?? 3,
      createdAt:  m.created_at instanceof Date ? m.created_at.toISOString() : (m.created_at ?? null),
    }));
    send("self_memories", { memories });
  } catch (err) {
    sessionLogger.error("sendSelfMemories error", { err: err.message });
    logger.error(`[ws] Failed to fetch self-memories: ${err.message}`);
  }
}

export async function sendPendingInterrupts({ store, send }) {
  if (!store?.listAgentInterrupts) return;
  const rows = await store.listAgentInterrupts({ status: "pending", limit: 100 });
  send("interrupts", { interrupts: rows.map(serializeInterrupt) });
}

export async function handleDeleteMemory(id, { callTool, send, sessionLogger }) {
  try {
    await callTool("forget", { id });
    send("deleted", { id });
  } catch (err) {
    sessionLogger.error("handleDeleteMemory error", { id, err: err.message });
    logger.error("[ws] handleDeleteMemory error:", err);
    send("error", { text: `Delete failed: ${err.message}` });
  }
}
