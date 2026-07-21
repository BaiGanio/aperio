function createStreamingBubble(agentMeta = null) {
  const wrap = document.createElement("div");
  wrap.className = "message ai";

  const avatar = document.createElement("div");
  avatar.className = "avatar ai";
  // Round-table avatars: "α" for primary, "β" for verifier. Single-agent path
  // keeps the default "A" Aperio mark.
  let avatarLetter = "A";
  if (agentMeta?.agentId === "primary" || agentMeta?.persona === "primary") avatarLetter = "α";
  if (agentMeta?.persona === "verifier" || agentMeta?.agentId === "verifier") avatarLetter = "β";
  avatar.textContent = avatarLetter;

  if (agentMeta?.agentId) {
    wrap.classList.add(`message-agent-${agentMeta.agentId}`);
    avatar.classList.add(`avatar-agent-${agentMeta.agentId}`);
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble streaming";
  bubble.innerHTML = '<span class="cursor">▋</span>';

  const col = document.createElement("div");
  col.style.cssText = "display:flex;flex-direction:column;flex:1;min-width:0;";

  // Round-table only: small inline header above the bubble showing the agent's
  // provider and model so users can tell A and B apart without hovering the
  // avatar. Falls back silently if the provider event hasn't populated
  // `_roundtableAgents` yet (single-agent chats render no tag).
  const tag = _buildRoundtableAgentTag(agentMeta);
  if (tag) col.appendChild(tag);

  col.appendChild(bubble);

  wrap.appendChild(avatar);
  wrap.appendChild(col);
  messagesEl.appendChild(wrap);
  scrollToBottom();
  return { wrap, bubble, col, agentMeta };
}

function _scheduleStreamRender() {
  if (_streamRenderScheduled) return;
  _streamRenderScheduled = true;
  requestAnimationFrame(() => {
    _streamRenderScheduled = false;
    if (!streamingBubble) return;   // finalized/torn down before this frame ran
    updateStreamingBubble(streamingBubble, streamingText);
    scrollToBottom();
  });
}

function updateStreamingBubble(ref, text) {
  const fenceCount = (text.match(/```/g) || []).length;
  const hasOpenFence = fenceCount % 2 !== 0;

  if (hasOpenFence) {
    const lastFence = text.lastIndexOf("```");
    const before = text.slice(0, lastFence);
    const inProgress = text.slice(lastFence + 3);

    const firstNewline = inProgress.indexOf("\n");
    const lang = firstNewline > 0 ? inProgress.slice(0, firstNewline).trim() : "";
    const codeContent = firstNewline > 0 ? inProgress.slice(firstNewline + 1) : inProgress;

    // Render everything before the open fence (any completed deliverables there
    // stripped to cards), then handle the in-progress block.
    const { text: cleanBefore, files } = _stripDeliverables(before);
    ref.bubble.innerHTML = renderMarkdown(cleanBefore);
    files.forEach(f => ref.bubble.appendChild(_buildDeliverableCard(f, true)));

    if (_isDeliverable(lang, codeContent)) {
      // A build deliverable streaming in shows a "Building …" placeholder, never
      // raw source — the file is saved and surfaced as a card on completion.
      ref.bubble.appendChild(_buildDeliverableCard({ name: _deliverableName(lang, codeContent), content: codeContent }, true));
    } else {
      const escaped = codeContent.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const safeLabel = escapeHtml(lang || "code");
      const safeLangForClass = (lang && /^[a-zA-Z0-9_+-]+$/.test(lang)) ? lang : "";
      const langClass = safeLangForClass ? ` class="language-${safeLangForClass}"` : "";
      const holder = document.createElement("div");
      holder.innerHTML =
        `<div class="code-block">` +
        `<div class="code-toolbar"><span class="code-lang">${safeLabel}</span>` +
        `<span class="csp-style-23">${t("msg_streaming")}</span></div>` +
        `<pre><code${langClass}>${escaped}</code></pre></div>`;
      ref.bubble.appendChild(holder.firstChild);
    }
    ref.bubble.insertAdjacentHTML("beforeend", '<span class="cursor">▋</span>');
  } else {
    _renderWithDeliverables(ref.bubble, text, true);
    highlightAll();
  }
  scrollToBottom();
}

// ── AI bubble enhancements ───────────────────────────────────────────────────
// A "build" request shouldn't dump 10k lines of code into the chat. When the
// model writes the file to disk it surfaces as a generated-file card; but weak
// models often paste the code inline anyway. So collapse any large inline code
// block behind a compact toolbar (Expand / Copy / Download / — for HTML —
// Preview) instead of letting it flood the transcript.
const _CODE_EXT = { html: "html", htm: "html", css: "css", javascript: "js", js: "js",
                    jsx: "jsx", tsx: "tsx", typescript: "ts", ts: "ts", python: "py",
                    py: "py", json: "json", sh: "sh", bash: "sh", xml: "xml", svg: "svg",
                    markdown: "md", md: "md" };

function _makeCodeBtn(iconClass, label) {
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.innerHTML = `<i class="bi ${iconClass}"></i> ${label}`;
  return btn;
}

// ── Build deliverables ───────────────────────────────────────────────────────
// A build request ("make me a page") shouldn't dump the file's source into the
// chat at all. The server persists such blocks to the workspace (see
// persistAnswerArtifacts) and emits a download/preview card; the chat just shows
// a "Building …" placeholder where the code would be. Criteria mirror the server
// so the client hides exactly what the server saved.
// Classify a fenced block as a deliverable, sniffing CONTENT (not just the fence
// label) because weak models routinely emit a bare ``` fence — the exact case
// where the code leaked into the bubble and no card appeared. Mirrors the
// server's classifyDeliverable so the client hides exactly what the server saves.
function _classifyDeliverable(lang, code) {
  const l = (lang || "").toLowerCase();
  if (l === "html" || l === "htm") return "html";
  if (l === "svg") return "svg";
  if (l === "md" || l === "markdown") return "md";
  if (l && l !== "code") return null;        // tagged js/css/python/… → not a deliverable
  if (/<!doctype html/i.test(code) || /<html[\s>]/i.test(code)) return "html";
  if (/^\s*<svg[\s>]/i.test(code)) return "svg";
  return null;
}
function _isDeliverable(lang, text) {
  if (!_classifyDeliverable(lang, text)) return false;
  return text.length >= 1000 || text.split("\n").length >= 20;
}
function _deliverableName(lang, text) {
  const kind = _classifyDeliverable(lang, text);
  if (kind === "html") {
    const m = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const slug = m && m[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    return slug ? `${slug}.html` : "index.html";
  }
  if (kind === "svg") return "image.svg";
  return "document.md";
}
// Remove build deliverables from the message text BEFORE rendering, so the
// source never reaches the bubble in ANY form: fenced (```html / bare ```),
// or raw `<!DOCTYPE html>…`/`<svg>…` with no fence (optionally wrapped in a
// literal <pre><code>). Returns the cleaned text plus the extracted files.
function _stripDeliverables(text) {
  const files = [];
  let out = text;

  // Fenced blocks whose content classifies as a deliverable.
  out = out.replace(/```(\w*)[ \t]*\r?\n?([\s\S]*?)```/g, (full, lang, code) => {
    const body = code.replace(/\s+$/, "");
    if (!_isDeliverable(lang, body)) return full;
    files.push({ name: _deliverableName(lang, body), content: body });
    return "";
  });

  // Raw, unfenced HTML/SVG document — closed, or (while streaming) running to
  // the end of the text. A leading literal <pre><code> wrapper is absorbed.
  out = out.replace(
    /(?:<pre>\s*<code>\s*)?(<!doctype html\b[\s\S]*?(?:<\/html\s*>|$)|<html\b[\s\S]*?(?:<\/html\s*>|$)|<svg\b[\s\S]*?(?:<\/svg\s*>|$))(?:\s*<\/code>\s*<\/pre>)?/i,
    (full, doc) => {
      const body = doc.replace(/\s+$/, "");
      if (body.length < 400) return full;   // small inline example — leave it
      const kind = /^\s*<svg/i.test(body) ? "svg" : "html";
      files.push({ name: _deliverableName(kind, body), content: body });
      return "";
    }
  );

  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), files };
}

// The placeholder shown in place of a deliverable: "Building…" while streaming,
// or a card with Preview/Download (built from the captured content) once done.
function _buildDeliverableCard(file, building) {
  const card = document.createElement("div");
  card.className = "build-card";
  card.innerHTML =
    `<span class="build-card-icon">${building ? "⏳" : "📄"}</span>` +
    `<span class="build-card-name">${escapeHtml(file.name)}</span>` +
    `<span class="build-card-sub">${building ? "building, saving to your workspace…" : "saved to your workspace"}</span>`;
  if (!building) {
    const actions = document.createElement("span");
    actions.className = "build-card-actions";
    if (/\.html?$/i.test(file.name)) {
      const pv = _makeCodeBtn("bi-eye", "preview");
      pv.addEventListener("click", () => previewHtmlString(file.content, file.name));
      actions.appendChild(pv);
    }
    const dl = _makeCodeBtn("bi-download", "download");
    dl.addEventListener("click", () => {
      const blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    actions.appendChild(dl);
    card.appendChild(actions);
  }
  return card;
}

// Render answer text with deliverables stripped out and shown as cards instead.
function _renderWithDeliverables(bubble, text, streaming) {
  const { text: clean, files } = _stripDeliverables(text);
  bubble.innerHTML = renderMarkdown(clean) + (streaming ? '<span class="cursor">▋</span>' : "");
  files.forEach(f => bubble.appendChild(_buildDeliverableCard(f, streaming)));
  return files.length;
}

function _collapseLargeCodeBlocks(bubble) {
  bubble.querySelectorAll(".code-block").forEach(block => {
    if (block.dataset.enhanced) return;
    const code = block.querySelector("code");
    const toolbar = block.querySelector(".code-toolbar");
    if (!code || !toolbar) return;
    const text = code.textContent;
    const lineCount = text.split("\n").length;
    const isLarge = lineCount > 12 || text.length > 800;
    if (!isLarge) return;
    block.dataset.enhanced = "1";

    const langLabel = (block.querySelector(".code-lang")?.textContent || "code").toLowerCase();
    const ext = _CODE_EXT[langLabel] || "txt";
    const filename = `generated.${ext}`;

    block.classList.add("code-block--collapsed");

    if (ext === "html" || ext === "htm") {
      const previewBtn = _makeCodeBtn("bi-eye", "preview");
      previewBtn.addEventListener("click", () => previewHtmlString(text, filename));
      toolbar.appendChild(previewBtn);
    }

    const dlBtn = _makeCodeBtn("bi-download", "download");
    dlBtn.title = `Save as ${filename}`;
    dlBtn.addEventListener("click", () => {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    toolbar.appendChild(dlBtn);

    const expandBtn = _makeCodeBtn("bi-arrows-expand", `expand (${lineCount} lines)`);
    expandBtn.addEventListener("click", () => {
      const collapsed = block.classList.toggle("code-block--collapsed");
      expandBtn.innerHTML = collapsed
        ? `<i class="bi bi-arrows-expand"></i> expand (${lineCount} lines)`
        : `<i class="bi bi-arrows-collapse"></i> collapse`;
    });
    toolbar.appendChild(expandBtn);
  });
}

// Render trailing "pick an option" prompts as clickable pills. The user can
// still type a free-form answer — the pills are a shortcut, not a constraint.
// Heuristic: the message asks a question and lists 2–6 short **bold** items.
//
// Two shapes of prompt, handled differently:
//   • Answer  — the bold item IS the answer ("**A skill**", "**An MCP server**").
//               Clicking it sends that text straight back.
//   • Topic   — the bold item is a category that poses its own follow-up after a
//               dash ("**Email provider** — Gmail, Outlook, or IMAP?"). Sending
//               the bare label answers nothing, so clicking instead seeds the
//               input with "Email provider: " and focuses it for the user to fill.
function _extractChoices(text) {
  if (text.includes("```")) return null;            // a build result, not a prompt
  if (!text.includes("?")) return null;             // not a question at all
  const items = [];
  const re = /^\s*(?:\d+\.|[-*+])\s+\*\*([^*\n]+?)\*\*\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].replace(/[:：]\s*$/, "").trim();
    if (!label || label.length > 40 || items.some(it => it.label === label)) continue;
    const rest = (m[2] || "").trim();
    // A "topic" item trails a dash and asks its own sub-question — its label
    // names what to answer rather than being the answer.
    const needsInput = /[—–-]/.test(rest) && rest.includes("?");
    items.push({ label, needsInput });
  }
  return items.length >= 2 && items.length <= 6 ? items : null;
}

function _renderChoicePills(bubble, text) {
  const items = _extractChoices(text);
  if (!items) return;
  // If most items pose their own follow-up, the whole prompt needs the user's
  // own answers — seed the input instead of auto-sending bare labels.
  const clarify = items.filter(it => it.needsInput).length > items.length / 2;

  const wrap = document.createElement("div");
  wrap.className = "choice-pills-wrap";

  const cap = document.createElement("div");
  cap.className = "choice-pills-caption";
  cap.textContent = clarify ? t("choice_caption_clarify") : t("choice_caption_pick");
  wrap.appendChild(cap);

  const row = document.createElement("div");
  row.className = "choice-pills";
  items.forEach(({ label }) => {
    const pill = document.createElement("button");
    pill.className = "choice-pill" + (clarify ? " choice-pill--topic" : "");
    pill.textContent = label;
    pill.addEventListener("click", () => {
      const input = document.getElementById("chatInput");
      if (!input) return;
      if (clarify) {
        // Seed "Topic: " (append on a new line if the user is mid-answer),
        // focus the caret at the end, and let the textarea grow.
        const prefix = input.value.trim() ? input.value.replace(/\s+$/, "") + "\n" : "";
        input.value = prefix + label + ": ";
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (window.autoResize) window.autoResize();
      } else if (window.send) {
        input.value = label;
        window.send();
      }
    });
    row.appendChild(pill);
  });
  wrap.appendChild(row);
  bubble.appendChild(wrap);

  // Mirror the lead choice into the input as an inline next-step suggestion
  // (Claude-Code style): ghost text in the empty prompt, accepted with Tab / →.
  // Topic items seed "Label: " for the user to finish; answer items seed the
  // label itself. The pills above stay as the full, clickable list.
  const lead = items[0];
  const acceptValue = clarify ? lead.label + ": " : lead.label;
  window.setInputSuggestion?.(acceptValue, lead.label);
}

function _enhanceAiBubble(bubble, rawText) {
  _collapseLargeCodeBlocks(bubble);     // large non-deliverable snippets → collapsed
  _renderChoicePills(bubble, rawText);
}

function finalizeStreamingBubble(ref, fullText, stats) {
  ref.bubble.classList.remove("streaming");

  ref.bubble.innerHTML = "";
  if (fullText.includes("🧠 **Memory suggestions**") && !suggestionShown) {
    suggestionShown = true;
    const [before, after] = fullText.split("🧠 **Memory suggestions**");
    _renderWithDeliverables(ref.bubble, before.trim(), false);
    ref.bubble.appendChild(parseSuggestionBlock(after));
  } else {
    _renderWithDeliverables(ref.bubble, fullText, false);
  }
  if (fullText.trim()) _attachBubbleCopyBtn(ref.bubble, fullText);
  _enhanceAiBubble(ref.bubble, fullText);

  const col = ref.wrap.querySelector("div[style]") || ref.wrap;

  const ts = document.createElement("div");
  ts.className = "msg-timestamp";
  ts.textContent = t("mem_just_now");
  ts.dataset.ts = Date.now();
  col.appendChild(ts);

  if (stats) {
    const answerTok = stats.outputTokens - (stats.thinkingTokens || 0);
    const secLabel = stats.elapsedSec.toFixed(1) + "s";
    const displayTok = estimateTokens(fullText);
    const badge = document.createElement("div");
    badge.className = "msg-stats";
    const hasTimings = stats.timings?.prompt_per_second || stats.timings?.predicted_per_second;
    const overallSpeed = stats.elapsedSec > 0 ? (displayTok / stats.elapsedSec) : 0;
    let label;
    if (hasTimings) {
      // LlamaCPP: show only ⚡P/💨G split — omit the `speed` param so {speed}
      // stays as literal text, then strip the {speed} segment with a locale-
      // agnostic regex that matches the next · separator.
      const params = { total: stats.outputTokens, answer: answerTok, thinking: stats.thinkingTokens, sec: secLabel };
      label = (stats.thinkingTokens > 0 ? t("stats_with_thinking", params) : t("stats_plain", params));
      label = label.replace(/ · 🚙 [^·]+/g, "");
    } else {
      // Non-llamacpp providers: show overall average rate (answer tok / elapsedSec).
      const params = { total: stats.outputTokens, answer: answerTok, thinking: stats.thinkingTokens, sec: secLabel, speed: overallSpeed.toFixed(1) };
      label = (stats.thinkingTokens > 0 ? t("stats_with_thinking", params) : t("stats_plain", params));
    }
    // Providers that report prompt-context tokens can surface that occupancy
    // here. Aggregate agent-loop work (Codex) is deliberately excluded.
    if (stats.inputTokens > 0 && stats.inputTokensKind !== "aggregate") {
      label += " · " + t("stats_context_in", { n: stats.inputTokens.toLocaleString() });
    }
    // Append llama-server timings (prompt vs gen tok/s) to the same line.
    if (hasTimings) {
      const t = stats.timings;
      const parts = [];
      if (t.prompt_per_second) parts.push(`⚡P: ${t.prompt_per_second.toFixed(1)} tok/s`);
      if (t.predicted_per_second) parts.push(`💨G: ${t.predicted_per_second.toFixed(1)} tok/s`);
      label += " · " + parts.join(" · ");
    }
    badge.textContent = label;
    col.appendChild(badge);
  }

  highlightAll();
}
