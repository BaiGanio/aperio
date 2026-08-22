// public/scripts/streaming/handler.js
// Shared streaming helpers + the authoritative WebSocket event router.
//
// Every server message type is handled by exactly one function, registered by a
// domain file under streaming/events/. Registration is the contract: a duplicate
// type is a load-time error, and an unmapped type is an explicit, silent ignore
// (older/newer servers may emit types this client does not render). Keep the map
// as the single dispatch point so protocol coverage stays testable.

function dropPhaseBreadcrumb(text) {
  const line = document.createElement("div");
  line.className = "action-phase done";
  line.innerHTML =
    `<span class="action-phase-mark"></span>` +
    `<span class="action-phase-label">${escapeHtml(text)}</span>`;
  const live = document.getElementById("thinking");
  if (live) messagesEl.insertBefore(line, live);
  else messagesEl.appendChild(line);
}

// Keep the live indicator as the last element so it reads as "what's happening
// now" beneath the completed steps.
function moveLiveIndicatorToBottom() {
  const live = document.getElementById("thinking");
  if (live && live !== messagesEl.lastElementChild) messagesEl.appendChild(live);
}

// Record a phase transition. Leaves a breadcrumb when a "thinking" phase gives
// way to tools or the answer, unless that thinking was already surfaced as a
// reasoning bubble.
function enterPhase(kind) {
  if (kind === "thinking") _phaseHadReasoning = false;
  if (_lastPhase === "thinking" && kind !== "thinking" && !_phaseHadReasoning && _modelThinks) {
    dropPhaseBreadcrumb(t("status_thinking"));
  }
  // "reading result…" is shown only on the live pill while the model digests a
  // tool result; it must NOT leave a breadcrumb — once the model is done reading
  // and moves on, the label disappears with the live pill rather than littering
  // the transcript with stale "reading result…" lines.
  _lastPhase = kind;
}

function estimateTokens(text) {
  if (!text || !text.trim()) return 0;
  return Math.max(1, Math.ceil(text.trim().length / 4));
}

// "unsloth/Qwen3.6-27B-GGUF:Q4_K_M" → "Qwen3.6-27B" — a status-label-sized
// model name (org, quant tag, and -GGUF suffix carry no meaning for the user).
function shortModelName(id) {
  const repo = String(id || "").split(":")[0];
  return (repo.includes("/") ? repo.slice(repo.indexOf("/") + 1) : repo).replace(/-GGUF$/i, "");
}

// A user message's attachments are not free: images cost vision tokens and
// files are injected as extracted text. Estimate that cost so the per-message
// token chip reflects the real upload, not just the typed prompt.
function estimateAttachmentTokens(att) {
  if (!att) return 0;
  if (att.type && att.type.startsWith("image/")) return _imageTokenCost;

  // Restored-session files carry a server-computed token figure (the client has
  // no file data to recompute from).
  if (typeof att.tokens === "number") return att.tokens;

  // Live upload: for text/code files the raw bytes ARE the model's text, so
  // decode and apply the same char/4 heuristic used for chat text.
  const dataUrl = att.dataUrl || (att.data ? `data:;base64,${att.data}` : null);
  if (!dataUrl) return 0;
  try {
    const base64 = dataUrl.split(",")[1] || "";
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    return estimateTokens(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return 0;
  }
}

function setUserTokenEstimate(n) { pendingUserTokenEstimate = n; }

// Ambient coupling (issue #185 §A): drive the starfield's energy off the agent
// lifecycle so the background visibly works when the agent does — thinking
// stirs it, tool runs push harder, streaming settles it, idle calms it down.
// ambient.js eases toward the target, so step changes render as smooth swells.
function setAmbientLevel(level) {
  window.Aperio?.ambient?.setLevel?.(level);
}

// ── Event router ─────────────────────────────────────────────────────────────

const _streamEventHandlers = Object.create(null);

/**
 * Register the single handler for one or more server message types.
 * @param {string|string[]} types
 * @param {(msg: object) => void} fn
 */
function onStreamEvent(types, fn) {
  for (const type of Array.isArray(types) ? types : [types]) {
    if (_streamEventHandlers[type]) {
      throw new Error(`streaming: duplicate handler registered for "${type}"`);
    }
    _streamEventHandlers[type] = fn;
  }
}

function handleMessage(msg) {
  const handler = _streamEventHandlers[msg?.type];
  // Unmapped types are ignored on purpose: a server may emit events this build
  // does not render, and a stray message must never break the live turn.
  if (!handler) return;
  return handler(msg);
}

window.Aperio = window.Aperio || {};
window.Aperio.streamRouter = {
  on: onStreamEvent,
  dispatch: handleMessage,
  has: (type) => Boolean(_streamEventHandlers[type]),
  types: () => Object.keys(_streamEventHandlers).sort(),
};
