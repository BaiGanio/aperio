function _renderDeleteConfirmButton(token, filePath) {
  const filename = filePath ? filePath.split("/").pop() : "file";
  const wrap = document.createElement("div");
  wrap.className = "delete-confirm-wrap";
  wrap.innerHTML = `
    <div class="delete-confirm-header">Delete <code>${filename}</code>?</div>
    <div class="delete-confirm-meta">
      Confirmation token: <code class="delete-confirm-token">${token}</code>
      <span class="delete-confirm-hint">— click the button to confirm this deletion</span>
    </div>
  `;

  const btn = document.createElement("button");
  btn.className = "delete-confirm-btn";
  btn.innerHTML = '<i class="bi bi-trash"></i> Confirm deletion';
  btn.onclick = () => {
    wrap.remove();
    chatInput.value = token;
    send();
  };

  wrap.appendChild(btn);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// Generic confirm-before-write button (GitHub issue create/update, etc.). The
// action is already resolved and stashed server-side under the token, so the
// click sends a `confirm_action` message and the SERVER executes it directly —
// no model round-trip. The result streams back as a normal assistant message.
function _interruptLabel(interrupt) {
  if (!interrupt) return "Confirm action";
  const args = interrupt.arguments || {};
  if (interrupt.tool === "db_execute") return `Run ${String(args.statementClass || "SQL").toUpperCase()} on ${args.connection || "database"}`;
  if (interrupt.tool === "delete_file") return `Delete ${(args.path || "").split("/").pop() || args.path || "file"}`;
  if (interrupt.tool === "write_file") return `${args.existedAtProposal ? "Overwrite" : "Create"} ${(args.path || "").split("/").pop() || "file"}`;
  if (interrupt.tool === "append_file") return `Append to ${(args.path || "").split("/").pop() || "file"}`;
  if (interrupt.tool === "edit_file") return `Edit ${(args.path || "").split("/").pop() || "file"}`;
  return interrupt.tool || "Confirm action";
}

function _interruptSummary(interrupt) {
  const args = interrupt?.arguments || {};
  if (interrupt?.tool === "db_execute") {
    return [`Connection: ${args.connection || "?"}`, `Statement: ${String(args.statementClass || "?").toUpperCase()}`, args.sql || ""].filter(Boolean).join("\n");
  }
  if (args.path) return `Target: ${args.path}`;
  return "";
}

function _sendInterruptDecision(payload) {
  safeSend(JSON.stringify({ type: "interrupt_decision", ...payload }));
}

function _renderPendingInterrupts(interrupts) {
  const pendingIds = new Set(interrupts.map(i => i.id));
  document.querySelectorAll(".action-confirm-wrap[data-restored='1']").forEach(el => {
    if (!pendingIds.has(el.dataset.interruptId)) el.remove();
  });
  for (const interrupt of interrupts) {
    if (!interrupt?.id || document.querySelector(`.action-confirm-wrap[data-interrupt-id="${CSS.escape(interrupt.id)}"]`)) continue;
    _renderActionConfirmButton(interrupt.id, _interruptLabel(interrupt), _interruptSummary(interrupt), interrupt.tool, { interrupt, restored: true });
  }
}

function _renderActionConfirmButton(token, label, summary, tool, options = {}) {
  const wrap = document.createElement("div");
  wrap.className = "action-confirm-wrap";
  wrap.dataset.interruptId = token;
  if (options.restored) wrap.dataset.restored = "1";

  const head = document.createElement("div");
  head.className = "action-confirm-header";
  head.textContent = label || "Confirm action";
  wrap.appendChild(head);

  if (summary) {
    const meta = document.createElement("div");
    meta.className = "action-confirm-summary";
    meta.textContent = summary;
    wrap.appendChild(meta);
  }

  // Two confirmation systems share this button. Store-backed interrupts (passed
  // via options.interrupt) are committed with an `interrupt_decision` message and
  // support edit/reject/respond. In-tool token confirms (github/db/delete propose
  // flows, token like `iss_…`) are NOT interrupt rows — they live in the tool's own
  // pending-actions map and must be committed with a `confirm_action` message, which
  // the server re-runs through the tool. Sending interrupt_decision for those fails
  // with "interrupt not found".
  const interrupt = options.interrupt;
  const isInterrupt = !!interrupt;

  const btn = document.createElement("button");
  btn.className = "action-confirm-btn";
  btn.innerHTML = '<i class="bi bi-check2-circle"></i> Confirm';
  btn.onclick = () => {
    btn.disabled = true;
    wrap.remove();
    if (isInterrupt) _sendInterruptDecision({ id: token, decision: "approve" });
    else safeSend(JSON.stringify({ type: "confirm_action", token, tool }));
  };

  const canEdit = interrupt?.allowedDecisions?.includes("edit");
  const edit = document.createElement("button");
  edit.className = "action-confirm-btn action-confirm-cancel";
  edit.innerHTML = '<i class="bi bi-pencil"></i> Edit';
  edit.style.display = canEdit ? "" : "none";
  edit.onclick = async () => {
    const current = interrupt?.arguments || {};
    const raw = await window.askInputModal({
      title: "Edit action arguments",
      message: "Update the JSON arguments before sending this action.",
      value: JSON.stringify(current, null, 2),
      submitLabel: "Apply",
      validate: (value) => {
        try { JSON.parse(value); return ""; }
        catch (err) { return `Invalid JSON: ${err.message}`; }
      },
    });
    if (raw == null) return;
    try {
      const editedArguments = JSON.parse(raw);
      wrap.remove();
      _sendInterruptDecision({ id: token, decision: "edit", editedArguments });
    } catch (err) {
      addMessage("ai", `⚠️ Invalid JSON: ${err.message}`);
    }
  };

  const reject = document.createElement("button");
  reject.className = "action-confirm-btn action-confirm-cancel";
  reject.innerHTML = '<i class="bi bi-x-circle"></i> Reject';
  reject.style.display = isInterrupt ? "" : "none";
  reject.onclick = async () => {
    const response = (await window.askInputModal({
      title: "Reject action",
      message: "Optionally explain why this action was rejected.",
      submitLabel: "Reject",
    })) || "";
    wrap.remove();
    _sendInterruptDecision({ id: token, decision: "reject", response });
  };

  const respond = document.createElement("button");
  respond.className = "action-confirm-btn action-confirm-cancel";
  respond.innerHTML = '<i class="bi bi-chat-left-text"></i> Respond';
  respond.style.display = isInterrupt ? "" : "none";
  respond.onclick = async () => {
    const response = await window.askInputModal({
      title: "Respond to agent",
      message: "Record a response without executing the action.",
      submitLabel: "Respond",
    });
    if (response == null) return;
    wrap.remove();
    _sendInterruptDecision({ id: token, decision: "respond", response });
  };

  // Let the user back out without performing the action.
  const cancel = document.createElement("button");
  cancel.className = "action-confirm-btn action-confirm-cancel";
  cancel.textContent = "Cancel";
  cancel.onclick = () => wrap.remove();

  const row = document.createElement("div");
  row.className = "action-confirm-row";
  row.appendChild(btn);
  row.appendChild(edit);
  row.appendChild(reject);
  row.appendChild(respond);
  row.appendChild(cancel);
  wrap.appendChild(row);

  messagesEl.appendChild(wrap);
  scrollToBottom();
}
