// public/scripts/streaming/events/tools.js
// Tool activity cards and the confirmation/interrupt flow that gates
// destructive or otherwise consequential tool calls.

onStreamEvent("tool_start", (msg) => {
  _renderToolCard(msg);
});

onStreamEvent("tool_result", (msg) => {
  _resolveToolCard(msg);
});

onStreamEvent("delete_confirm_pending", (msg) => {
  _renderDeleteConfirmButton(msg.token, msg.path);
});

onStreamEvent("action_confirm_pending", (msg) => {
  _renderActionConfirmButton(msg.token, msg.label, msg.summary, msg.tool);
});

onStreamEvent("interrupts", (msg) => {
  _renderPendingInterrupts(msg.interrupts || []);
});

onStreamEvent("interrupt_decided", (msg) => {
  document.querySelector(`.action-confirm-wrap[data-interrupt-id="${CSS.escape(msg.interrupt?.id || "")}"]`)?.remove();
});
