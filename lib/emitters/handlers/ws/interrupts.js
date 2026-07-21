// lib/emitters/handlers/ws/interrupts.js
// confirm_action / interrupt_decision: execute a previously-stashed
// tool-confirmation token straight through the interrupt store — no model
// round-trip — and push the result into the shared transcript.

import logger from "../../../helpers/logger.js";
import { decideAndMaybeExecute } from "../../../routes/api-interrupts.js";
import { getUserPaths } from "../../../routes/paths.js";
import { sendPendingInterrupts } from "./memories.js";

export const CONFIRMABLE_TOOLS = new Set([
  "create_github_issue", "update_github_issue", "delete_file",
  "write_file", "edit_file", "append_file", "db_execute", "index_folder",
]);

export async function handleConfirmAction(data, { store, callTool, messages, send, sessionLogger }) {
  const { token, tool } = data;
  if (!CONFIRMABLE_TOOLS.has(tool) || typeof token !== "string" || !/^(?:iss|del|wr|db|idx)_[a-z0-9]+$/.test(token)) {
    send("error", { text: "Invalid confirmation request." });
    return;
  }
  try {
    send("thinking");
    const { status, body } = await decideAndMaybeExecute({
      store,
      id: token,
      body: { decision: "approve" },
    });
    let text;
    if (status === 404 && typeof callTool === "function") {
      const result = await callTool(tool, { confirmation_token: token });
      text = typeof result === "string"
        ? result
        : (Array.isArray(result) ? result.find(b => b.type === "text")?.text ?? "Done." : "Done.");
    } else {
      if (status >= 400) throw new Error(body?.error || "Confirmation failed");
      text = body?.result || "Done.";
    }
    if (tool === "index_folder") send("paths_updated", { paths: getUserPaths() });
    messages.push({ role: "assistant", content: text });
    await sendPendingInterrupts({ store, send });
    send("stream_end", { text });
  } catch (err) {
    sessionLogger.error("handleConfirmAction error", { tool, err: err.message });
    logger.error("[ws] handleConfirmAction error:", err);
    send("error", { text: `Confirmation failed: ${err.message}` });
  }
}

export async function handleInterruptDecision(data, { store, messages, send, sessionLogger }) {
  const id = data.id ?? data.token;
  const decision = data.decision;
  if (typeof id !== "string" || !["approve", "edit", "reject", "respond"].includes(decision)) {
    send("error", { text: "Invalid interrupt decision." });
    return;
  }
  try {
    if (decision === "approve" || decision === "edit") send("thinking");
    const { status, body } = await decideAndMaybeExecute({
      store,
      id,
      body: {
        decision,
        editedArguments: data.editedArguments,
        response: data.response,
      },
    });
    if (status >= 400) throw new Error(body?.error || "Interrupt decision failed");
    await sendPendingInterrupts({ store, send });
    const text = body?.result || (
      decision === "reject"
        ? "Action rejected. Nothing was executed."
        : decision === "respond"
          ? "Response recorded. Nothing was executed."
          : "Done."
    );
    messages.push({ role: "assistant", content: text });
    send("interrupt_decided", { interrupt: body.interrupt, result: body.result, decision });
    send("stream_end", { text });
  } catch (err) {
    sessionLogger.error("handleInterruptDecision error", { id, decision, err: err.message });
    logger.error("[ws] handleInterruptDecision error:", err);
    send("error", { text: `Interrupt decision failed: ${err.message}` });
  }
}
