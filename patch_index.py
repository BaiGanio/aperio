#!/usr/bin/env python3
import sys, os

path = "public/index.html"
if not os.path.exists(path):
    print(f"ERROR: {path} not found. Run from your aperio/ root.")
    sys.exit(1)

html = open(path).read()
original_len = len(html)

# ── Patch 1: fix stream_end — render msg.text even when no tokens streamed ────
# R1 and other models sometimes skip token events entirely (no <think> blocks,
# or model responds before streaming kicks in). In that case streamingBubble is
# null but msg.text has the full response. We need to render it directly.
FIND1 = (
  '  if (msg.type === "stream_end") {\n'
  '    if (streamingBubble && streamingText.trim()) {\n'
  '      finalizeStreamingBubble(streamingBubble, msg.text || streamingText);\n'
  '    } else if (streamingBubble) {\n'
  '      streamingBubble.wrap?.remove();\n'
  '    }\n'
  '    streamingBubble = null;\n'
  '    streamingText = "";\n'
  '    isThinking = false;\n'
  '    setStatus("connected", "connected");\n'
  '    sendBtn.disabled = chatInput.value.trim() === "";\n'
  '    scrollToBottom();\n'
  '  }'
)
REPL1 = (
  '  if (msg.type === "stream_end") {\n'
  '    const finalText = msg.text || streamingText;\n'
  '    if (streamingBubble && finalText.trim()) {\n'
  '      // Normal path — tokens streamed, finalize the bubble\n'
  '      finalizeStreamingBubble(streamingBubble, finalText);\n'
  '    } else if (streamingBubble && !finalText.trim()) {\n'
  '      // Empty response — remove the empty bubble\n'
  '      streamingBubble.wrap?.remove();\n'
  '    } else if (!streamingBubble && finalText.trim()) {\n'
  '      // No tokens streamed but msg.text has content (R1 without <think>, fast models)\n'
  '      // Remove thinking dots and render the message directly\n'
  '      removeThinking();\n'
  '      removeToolIndicator();\n'
  '      addMessage("ai", finalText);\n'
  '    }\n'
  '    streamingBubble = null;\n'
  '    streamingText = "";\n'
  '    isThinking = false;\n'
  '    setStatus("connected", "connected");\n'
  '    sendBtn.disabled = chatInput.value.trim() === "";\n'
  '    scrollToBottom();\n'
  '  }'
)

if FIND1 not in html:
    print("SKIP Patch 1 — anchor not found (may already be patched)")
else:
    html = html.replace(FIND1, REPL1, 1)
    print("OK Patch 1 — stream_end fallback renderer")

# ── Patch 2: retract handler ──────────────────────────────────────────────────
FIND2 = '  if (msg.type === "memories") {'
REPL2 = (
    '  if (msg.type === "retract") {\n'
    '    const reasoningText = msg.reasoning || "";\n'
    '    if (streamingBubble) {\n'
    '      streamingBubble.wrap.remove();\n'
    '      streamingBubble = null;\n'
    '    }\n'
    '    streamingText = "";\n'
    '    const showReasoning = localStorage.getItem("aperio-reasoning") !== "false";\n'
    '    if (showReasoning && reasoningText.trim()) {\n'
    '      const details = document.createElement("details");\n'
    '      details.style.cssText = "margin:4px 0 0 38px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;opacity:0.8;max-width:780px;";\n'
    '      const summary = document.createElement("summary");\n'
    '      summary.style.cssText = "padding:5px 10px;cursor:pointer;font-family:var(--font-mono);font-size:11px;color:var(--text-muted);background:var(--bg-hover);border-bottom:1px solid var(--border);list-style:none;user-select:none;";\n'
    '      summary.textContent = "\U0001f9e0 Reasoning";\n'
    '      const pre = document.createElement("pre");\n'
    '      pre.style.cssText = "margin:0;padding:10px 12px;font-family:var(--font-mono);font-size:11.5px;line-height:1.6;color:var(--text-muted);background:var(--bg-panel);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;";\n'
    '      pre.textContent = reasoningText;\n'
    '      details.appendChild(summary);\n'
    '      details.appendChild(pre);\n'
    '      messagesEl.appendChild(details);\n'
    '      messagesEl.scrollTop = messagesEl.scrollHeight;\n'
    '    }\n'
    '    return;\n'
    '  }\n'
    '\n'
    '  if (msg.type === "memories") {'
)

if FIND2 not in html:
    print("SKIP Patch 2 — already applied or anchor not found")
else:
    html = html.replace(FIND2, REPL2, 1)
    print("OK Patch 2 — retract handler")

# ── Patch 3: reasoning toggle button in header ────────────────────────────────
FIND3 = '    <div class="theme-switcher">'
REPL3 = (
    '    <button id="reasoningToggle" title="Toggle reasoning display" style="height:26px;padding:0 10px;border-radius:20px;border:1px solid var(--border);background:var(--bg-hover);color:var(--text-muted);font-family:var(--font-mono);font-size:10px;font-weight:600;letter-spacing:0.06em;cursor:pointer;display:flex;align-items:center;gap:5px;transition:all var(--transition);white-space:nowrap;">\n'
    '      \U0001f9e0 <span id="reasoningLabel">reasoning off</span>\n'
    '    </button>\n'
    '    <div class="theme-switcher">'
)

if FIND3 not in html:
    print("SKIP Patch 3 — already applied or anchor not found")
else:
    html = html.replace(FIND3, REPL3, 1)
    print("OK Patch 3 — reasoning toggle button")

# ── Patch 4: reasoning toggle JS ─────────────────────────────────────────────
FIND4 = '// ── Boot ─────────────────────────────────────────────────────'
REPL4 = (
    '// ── Reasoning toggle ─────────────────────────────────────────\n'
    '(function() {\n'
    '  const btn   = document.getElementById("reasoningToggle");\n'
    '  const label = document.getElementById("reasoningLabel");\n'
    '  let on = localStorage.getItem("aperio-reasoning") !== "false";\n'
    '  function apply() {\n'
    '    label.textContent     = on ? "reasoning on"       : "reasoning off";\n'
    '    btn.style.color       = on ? "var(--accent)"      : "var(--text-muted)";\n'
    '    btn.style.borderColor = on ? "var(--accent)"      : "var(--border)";\n'
    '    btn.style.background  = on ? "var(--accent-soft)" : "var(--bg-hover)";\n'
    '    localStorage.setItem("aperio-reasoning", on ? "true" : "false");\n'
    '  }\n'
    '  btn.addEventListener("click", () => { on = !on; apply(); });\n'
    '  apply();\n'
    '})();\n'
    '\n'
    '// ── Boot ─────────────────────────────────────────────────────'
)

if FIND4 not in html:
    print("SKIP Patch 4 — already applied or anchor not found")
else:
    html = html.replace(FIND4, REPL4, 1)
    print("OK Patch 4 — reasoning toggle JS")

open(path, "w").write(html)
print(f"\nDone. {path} updated ({original_len} -> {len(html)} bytes)")