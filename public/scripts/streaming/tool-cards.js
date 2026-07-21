// ── Tool activity cards ─────────────────────────────────────────────────────
function _renderToolCard(msg) {
  // The tool card is the authoritative live phase while a tool runs. Remove
  // the generic whole-turn indicator without unlocking the composer; keeping
  // both produced two clocks for the same operation (e.g. describe_image plus
  // "Assembling…") and made a single wait look like duplicate work.
  document.getElementById("thinking")?.remove();
  stopWhimsy();
  const card = document.createElement("div");
  card.className = "tool-card pending";
  // Short args sit inline beside the tool name; long ones (e.g. a full shell
  // command) drop to their own wrapping line below the head so the whole
  // command stays readable instead of being clipped to one line.
  const arg = msg.arg || "";
  const inlineArg = arg && arg.length <= 48
    ? `<span class="tool-card-arg">${escapeHtml(arg)}</span>` : "";
  const blockArg = arg && arg.length > 48
    ? `<div class="tool-card-arg-block">${escapeHtml(arg)}</div>` : "";
  card.innerHTML =
    `<div class="tool-card-head">` +
      `<span class="tool-card-dot"></span>` +
      `<span class="tool-card-name">${escapeHtml(msg.name)}</span>` +
      inlineArg +
      `<span class="tool-card-time"></span>` +
    `</div>` +
    blockArg +
    `<div class="tool-card-result">${t("tool_card_running")}</div>`;
  _toolCards.set(msg.seq, card);
  // Live stopwatch: tick the elapsed time in real time so a slow tool (e.g. a
  // long test run) never looks frozen. The interval is cleared on resolve, or
  // defensively on stream_end if the tool never reports back.
  const timeEl = card.querySelector(".tool-card-time");
  const startedAt = Date.now();
  timeEl.textContent = formatLiveDuration(0);
  card._timerId = setInterval(() => {
    timeEl.textContent = formatLiveDuration(Date.now() - startedAt);
  }, 100);
  messagesEl.appendChild(card);
  // The card now owns the tool's identity (name + args + result). The live
  // "thinking" pill stays the generic "Using {name}…" so it complements the
  // card instead of cloning its `name · arg` head right below it.
  moveLiveIndicatorToBottom();
  scrollToBottom();
}

// Human-readable tool duration: raw ms is meaningless to a user ("12013ms").
// Sub-second stays in ms; seconds get one decimal; a minute or more reads "1m 5s".
function formatToolDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// Live-counter format: unlike the resolved duration it never shows raw ms, so
// the ticking stopwatch reads as clean tenths of a second ("0.0s" → "12.3s")
// instead of a flickering "734ms". Rolls to "1m 5s" past a minute.
function formatLiveDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

// Drive the live timer on whichever "#thinking" pill currently exists. Started
// once per user turn (in send) and kept running across the inter-tool
// stream_end/start cycles so the "reading result…" digest gap is timed too;
// stopped only when the turn truly ends (final answer / error / stop).
function startLiveTimer() {
  stopLiveTimer();
  requestStartTime = Date.now();
  _liveTimerId = setInterval(() => {
    const el = document.querySelector("#thinking .thinking-time");
    if (el && requestStartTime) el.textContent = formatLiveDuration(Date.now() - requestStartTime);
  }, 100);
}
function stopLiveTimer() {
  clearInterval(_liveTimerId);
  _liveTimerId = null;
}

// Settle the live turn timer into a persistent breadcrumb ("done · 54.3s")
// instead of letting the wall-clock that ticked next to the busy words vanish
// with the pill. Does NOT consume requestStartTime — subsequent streams in
// the same turn still see the full wall-clock for their speed/timing badges.
// requestStartTime is naturally overwritten by the next startLiveTimer() call.
function settleTurnTimer() {
  stopLiveTimer();
  if (!requestStartTime) return;
  const total = Date.now() - requestStartTime;
  const line = document.createElement("div");
  line.className = "action-phase done";
  line.innerHTML =
    `<span class="action-phase-mark"></span>` +
    `<span class="action-phase-label">${escapeHtml(t("msg_reasoning_done"))}</span>` +
    `<span class="thinking-time">${escapeHtml(formatLiveDuration(total))}</span>`;
  messagesEl.appendChild(line);
}

function _resolveToolCard(msg) {
  const card = _toolCards.get(msg.seq);
  if (!card) return;
  _toolCards.delete(msg.seq);
  if (card._timerId) { clearInterval(card._timerId); card._timerId = null; }
  card.classList.remove("pending");
  card.classList.add(msg.ok ? "ok" : "error");
  const time = card.querySelector(".tool-card-time");
  if (time && typeof msg.ms === "number") time.textContent = formatToolDuration(msg.ms);
  const result = card.querySelector(".tool-card-result");
  if (result) {
    const summaryText = `↳ ${msg.summary || (msg.ok ? "done" : "error")}`;
    // web_search ships its hits as `details` — render them as an expandable list
    // (titles link out) so "N results" is inspectable instead of an opaque count.
    if (Array.isArray(msg.details) && msg.details.length) {
      result.textContent = "";
      const det = document.createElement("details");
      det.className = "tool-card-results";
      const sum = document.createElement("summary");
      sum.textContent = summaryText;
      det.appendChild(sum);
      for (const r of msg.details) {
        const item = document.createElement("div");
        item.className = "tool-card-result-item";
        const a = document.createElement("a");
        a.href = r.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        a.textContent = r.title || r.url;
        item.appendChild(a);
        const link = document.createElement("div");
        link.className = "tool-card-result-url";
        link.textContent = r.url;
        item.appendChild(link);
        if (r.snippet) {
          const sn = document.createElement("div");
          sn.className = "tool-card-result-snippet";
          sn.textContent = r.snippet;
          item.appendChild(sn);
        }
        det.appendChild(item);
      }
      result.appendChild(det);
    } else if (Array.isArray(msg.memories) && msg.memories.length) {
      // recall ships its hits as `memories` — render them inline under the
      // "↳ N memories" summary as a clean, scrollable list. Each row collapses
      // to its title + match %, and expands to the memory's content + tags.
      // This replaces the standalone recall pill.
      result.textContent = "";
      const det = document.createElement("details");
      det.className = "tool-card-results recall-results";
      const sum = document.createElement("summary");
      sum.textContent = summaryText;
      det.appendChild(sum);
      const list = document.createElement("div");
      list.className = "recall-mem-list";
      for (const m of msg.memories) {
        const item = document.createElement("details");
        item.className = "recall-memory";
        item.innerHTML =
          `<summary>` +
            `<span class="recall-memory-title">${escapeHtml(m.title)}</span>` +
            (m.similarity !== null && m.similarity !== undefined ? `<span class="recall-score">${m.similarity}%</span>` : "") +
          `</summary>` +
          `<div class="recall-memory-body">` +
            (m.content ? `<div class="recall-memory-content">${escapeHtml(m.content)}</div>` : "") +
            (m.tags ? `<div class="recall-memory-tags">${escapeHtml(m.tags)}</div>` : "") +
          `</div>`;
        list.appendChild(item);
      }
      det.appendChild(list);
      result.appendChild(det);
    } else if (msg.detail) {
      // A clipped result (e.g. a long error) ships its full text as `detail`.
      // Mirror the web_search list: the one-line summary stays visible and
      // clicking it expands to the complete message instead of a dangling "…".
      result.textContent = "";
      const det = document.createElement("details");
      det.className = "tool-card-results tool-card-detail";
      const sum = document.createElement("summary");
      sum.textContent = summaryText;
      det.appendChild(sum);
      const body = document.createElement("div");
      body.className = "tool-card-detail-body";
      body.textContent = msg.detail;
      det.appendChild(body);
      result.appendChild(det);
    } else {
      result.textContent = summaryText;
    }
  }
  // The tool is done — don't leave the live pill stuck on the present-tense
  // "Using {name}…" sitting below a finished card (reads as if the tool is
  // still running, and went silent for minutes on slow models). Flip it to the
  // model's next phase: digesting the result before it answers.
  // Restore the whole-turn phase only after the tool's own timer has settled.
  // startLiveTimer remains active, so the restored clock preserves total turn
  // time while never competing with the tool stopwatch.
  if (!document.getElementById("thinking")) addThinking(false);
  const label = document.querySelector("#thinking .thinking-label");
  if (label) label.textContent = t("tool_reading_result");
  // Mark the reading phase so enterPhase() leaves a persistent breadcrumb when
  // the answer (or next step) takes over, rather than the line just disappearing.
  _lastPhase = "reading";
  moveLiveIndicatorToBottom();
  scrollToBottom();
}
