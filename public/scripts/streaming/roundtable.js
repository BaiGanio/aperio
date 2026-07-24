function _phaseAction(phase) {
  if (phase === "review")    return t("roundtable_phase_review");
  if (phase === "revise")    return t("roundtable_phase_revise");
  if (phase === "rereview")  return t("roundtable_phase_rereview");
  if (phase === "answer")    return t("roundtable_phase_answer");
  if (phase === "manifesto") return t("roundtable_phase_manifesto");
  return phase || "";
}

function _agentModelLabel(agentId) {
  const a = _roundtableAgents.find(x => x.id === agentId);
  if (!a) return agentId === "verifier" ? "β" : "α";
  if (a.model) return a.model;
  return a.name || agentId;
}

// Round-table working cue. Rendered as a plain dim breadcrumb (same vocabulary
// as the global "thinking…" / tool phase lines) — no pill, border, or coloured
// background — so it reads consistently with every other indicator. Each new
// phase first settles the previous breadcrumb to "done", leaving a visible trail
// and guaranteeing a fresh live cue for every agent turn.
function _renderRoundtablePhaseChip(phase, agentId) {
  removeThinking();                 // clear any stranded global "thinking…" line
  _settleRoundtablePhaseChip();     // freeze the previous step in place

  const chip = document.createElement("div");
  chip.className = "action-phase active roundtable-phase";
  if (agentId) chip.classList.add(`roundtable-phase-${agentId}`);

  const mark = document.createElement("span");
  mark.className = "action-phase-mark live";

  const label = document.createElement("span");
  label.className = "action-phase-label";
  const glyph = agentId === "verifier" ? "β" : "α";
  label.innerHTML =
    `<span class="roundtable-phase-who roundtable-agent-${agentId || "primary"}">${glyph}</span> ` +
    `${escapeHtml(_agentModelLabel(agentId))} · ${escapeHtml(_phaseAction(phase))}` +
    `<span class="rt-ellipsis">…</span>`;

  chip.append(mark, label);
  messagesEl.appendChild(chip);
  _roundtablePhaseChip = chip;
  scrollToBottom();
}

// Freeze the active breadcrumb: drop the live dot + trailing ellipsis so it
// reads as a completed step rather than ongoing work.
function _settleRoundtablePhaseChip() {
  const chip = _roundtablePhaseChip;
  if (!chip) return;
  chip.classList.remove("active");
  chip.classList.add("done");
  chip.querySelector(".action-phase-mark")?.classList.remove("live");
  chip.querySelector(".rt-ellipsis")?.remove();
  _roundtablePhaseChip = null;
}

function _clearRoundtablePhaseChip() {
  _settleRoundtablePhaseChip();
}

function _renderConsensusBubble(msg) {
  _clearRoundtablePhaseChip();
  if (streamingBubble) {
    if (streamingText.trim()) finalizeStreamingBubble(streamingBubble, streamingText, null);
    else streamingBubble.wrap?.remove();
    streamingBubble = null;
    streamingText = "";
  }
  const wrap = document.createElement("div");
  wrap.className = "message ai roundtable-consensus";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "✓";
  avatar.title = t("roundtable_consensus_label");

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  // Plain dim header — "✓ Consensus · α model · β model" — no pills or coloured
  // badges, consistent with the other lightweight indicators.
  const header = document.createElement("div");
  header.className = "roundtable-consensus-header";
  const agents = (msg.agents || _roundtableAgents);
  const agentBits = agents.map(a => {
    const glyph = (a.id === "verifier" ? "β" : "α");
    const label = a.model ? `${a.name} · ${a.model}` : (a.name || a.id || a);
    return `<span class="roundtable-agent-${a.id || a}">${glyph}</span> ${escapeHtml(String(label))}`;
  });
  header.innerHTML =
    `<span class="roundtable-consensus-tag">✓ ${escapeHtml(t("roundtable_consensus_label"))}</span>` +
    (agentBits.length ? ` · ${agentBits.join(" · ")}` : "");
  col.appendChild(header);

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = renderMarkdown(msg.text || "");
  col.appendChild(bubble);

  col.appendChild(_buildDiscussionDownloadRow(() => _buildDiscussionMarkdown(msg, "agreed")));

  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  highlightAll?.();
  scrollToBottom();
}

function _renderNoAgreementCard(msg) {
  _clearRoundtablePhaseChip();
  if (streamingBubble) {
    if (streamingText.trim()) finalizeStreamingBubble(streamingBubble, streamingText, null);
    else streamingBubble.wrap?.remove();
    streamingBubble = null;
    streamingText = "";
  }
  const wrap = document.createElement("div");
  wrap.className = "message ai roundtable-no-consensus-wrap";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "A";
  avatar.title = "Aperio";

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  const card = document.createElement("div");
  card.className = "roundtable-no-consensus";

  const banner = document.createElement("div");
  banner.className = "roundtable-no-consensus-banner";
  banner.textContent = t("roundtable_no_consensus_banner", { n: msg.rounds ?? "" });
  card.appendChild(banner);

  // Each agent's final position as a collapsible section (A open by default),
  // stacked and fully rendered — far easier to read than the old raw two-column
  // wall of un-typeset LaTeX.
  const positions = document.createElement("div");
  positions.className = "roundtable-no-consensus-positions";
  (msg.positions || []).forEach((pos, idx) => {
    const det = document.createElement("details");
    det.className = `roundtable-position roundtable-position-${pos.agent_id}`;
    if (idx === 0) det.setAttribute("open", "");
    const summary = document.createElement("summary");
    const glyph = pos.agent_id === "verifier" ? "β" : "α";
    summary.innerHTML =
      `<span class="roundtable-agent-${pos.agent_id}">${glyph}</span> ` +
      escapeHtml(pos.agent_id === "verifier" ? t("roundtable_position_b") : t("roundtable_position_a"));
    det.appendChild(summary);
    const body = document.createElement("div");
    body.className = "roundtable-no-consensus-body";
    body.innerHTML = renderMarkdown(pos.text || "");
    det.appendChild(body);
    positions.appendChild(det);
  });
  card.appendChild(positions);

  card.appendChild(_buildDiscussionDownloadRow(() => _buildDiscussionMarkdown(msg, "no_agreement")));

  col.appendChild(card);
  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  highlightAll?.();
  scrollToBottom();
}

function _renderRoundtableErrorCard(msg) {
  _clearRoundtablePhaseChip();
  if (streamingBubble) {
    if (streamingText.trim()) finalizeStreamingBubble(streamingBubble, streamingText, null);
    else streamingBubble.wrap?.remove();
    streamingBubble = null;
    streamingText = "";
  }
  const wrap = document.createElement("div");
  wrap.className = "message ai roundtable-no-consensus-wrap";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  avatar.textContent = "A";
  avatar.title = "Aperio";

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  const card = document.createElement("div");
  card.className = "roundtable-error-card";

  const agentLabel = msg.agent_id === "verifier" ? "β" : "α";
  const agent = _findAgent(msg.agent_id);
  const modelLabel = agent
    ? (agent.model ? `${agent.name} · ${agent.model}` : (agent.name || agentLabel))
    : agentLabel;

  const title = document.createElement("div");
  title.className = "roundtable-error-title";
  title.textContent = t("roundtable_error_title", { agent: agentLabel, model: modelLabel, phase: _phaseAction(msg.phase) });
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "roundtable-error-body";
  body.textContent = msg.message || "";
  card.appendChild(body);

  col.appendChild(card);
  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  scrollToBottom();
}

// ── Discuss entry-flow renderers ───────────────────────────────────────────

// A small dim note attributed to a specific party (primary / verifier / aperio).
function _renderDiscussNote(who, text) {
  const note = document.createElement("div");
  note.className = `discuss-note discuss-note-${who}`;
  const glyph = who === "verifier" ? "β" : who === "primary" ? "α" : "✦";
  note.innerHTML =
    `<span class="discuss-note-who roundtable-agent-${who}">${glyph}</span> ` +
    `<span class="discuss-note-text">${escapeHtml(text)}</span>`;
  messagesEl.appendChild(note);
  scrollToBottom();
  return note;
}

// Confirmation card shown after Discuss is armed: the proposed framing summary
// plus Use / Skip buttons that report the choice back to the server.
function _renderDiscussSummaryCard(text) {
  document.getElementById("discuss-summary-card")?.remove();
  const card = document.createElement("div");
  card.id = "discuss-summary-card";
  card.className = "discuss-summary-card";

  const title = document.createElement("div");
  title.className = "discuss-summary-title";
  title.textContent = t("discuss_summary_title");
  card.appendChild(title);

  const body = document.createElement("div");
  body.className = "discuss-summary-body";
  body.innerHTML = renderMarkdown(text);
  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "discuss-summary-actions";
  const send = (accepted) => {
    card.remove();
    window.safeSend?.(JSON.stringify({ type: "discuss_confirm", accepted }));
  };
  const useBtn = document.createElement("button");
  useBtn.className = "discuss-btn discuss-btn-primary";
  useBtn.textContent = t("discuss_use_btn");
  useBtn.onclick = () => send(true);
  const skipBtn = document.createElement("button");
  skipBtn.className = "discuss-btn";
  skipBtn.textContent = t("discuss_skip_btn");
  skipBtn.onclick = () => send(false);
  actions.append(useBtn, skipBtn);
  card.appendChild(actions);

  messagesEl.appendChild(card);
  scrollToBottom();
}

// After the user accepts: both agents acknowledge the topic, and a primary note
// explains the summary feeds in with the next prompt. Canned text — no model
// calls — since the actual framing is injected server-side at run time.
function _renderDiscussStagedNotes() {
  _renderDiscussNote("primary",  t("discuss_ack_note"));
  _renderDiscussNote("verifier", t("discuss_ack_note"));
  _renderDiscussNote("aperio",   t("discuss_staged_note"));
}

// ── Discussion export (Markdown download) ──────────────────────────────────

function _agentDisplay(agentId) {
  const a = _findAgent(agentId);
  const glyph = agentId === "verifier" ? "B" : "A";
  if (!a) return `Agent ${glyph}`;
  const who = a.model ? `${a.name} · ${a.model}` : (a.name || "");
  return who ? `Agent ${glyph} (${who})` : `Agent ${glyph}`;
}

// Build a clean standalone Markdown document for one discussion from the result
// event payload. Used by the Download button on both result cards.
function _buildDiscussionMarkdown(msg, verdict) {
  const lines = [`# Aperio discussion`, ``];
  lines.push(`- **Verdict:** ${verdict === "agreed" ? "✅ Consensus reached" : "❌ No consensus"}`);
  if (msg.rounds) lines.push(`- **Rounds:** ${msg.rounds}`);
  lines.push(`- **Exported:** ${new Date().toISOString()}`, ``, `---`, ``);

  if (verdict === "agreed") {
    lines.push(`## Consensus`, ``, String(msg.text || "").trim(), ``);
  } else {
    (msg.positions || []).forEach(pos => {
      lines.push(`## ${_agentDisplay(pos.agent_id)}`, ``, String(pos.text || "").trim(), ``);
    });
  }
  return lines.join("\n");
}

// A right-aligned Download button that streams the built Markdown as a file.
function _buildDiscussionDownloadRow(getMarkdown) {
  const row = document.createElement("div");
  row.className = "discuss-download-row";
  const btn = document.createElement("button");
  btn.className = "discuss-download-btn";
  btn.innerHTML = `<i class="bi bi-download"></i> ${escapeHtml(t("discuss_download_btn"))}`;
  btn.onclick = () => {
    const blob = new Blob([getMarkdown()], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aperio-discussion-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  row.appendChild(btn);
  return row;
}

function _findAgent(agentId) {
  if (!agentId) return null;
  return _roundtableAgents.find(a => a?.id === agentId) || null;
}

function _buildRoundtableAgentTag(agentMeta) {
  if (!agentMeta?.agentId) return null;
  const agent = _findAgent(agentMeta.agentId);
  if (!agent) return null;
  const tag = document.createElement("div");
  tag.className = `roundtable-agent-tag roundtable-agent-tag-${agentMeta.agentId}`;
  const letter = agentMeta.agentId === "verifier" ? "β" : "α";
  const label = agent.model ? `${agent.name} · ${agent.model}` : (agent.name || letter);
  tag.textContent = label;
  tag.title = label;
  return tag;
}
