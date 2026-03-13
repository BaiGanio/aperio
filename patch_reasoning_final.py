#!/usr/bin/env python3
"""
Fixes reasoning bubble lifecycle in Aperio's index.html.

Changes:
  1. reasoning_start  — remove duplicate guard (allow new bubble per response)
                       — check toggle FIRST, then proceed
  2. reasoning_token  — unchanged, keep as-is
  3. reasoning_done   — rename from retract_done + collapse bubble cleanly
  4. stream_start     — collapse any lingering reasoning bubble (safety net)

Run from repo root:
  python3 patch_reasoning_final.py public/index.html
  # or pass path as first arg
"""

import sys
import re

path = sys.argv[1] if len(sys.argv) > 1 else "public/index.html"

with open(path, "r", encoding="utf-8") as f:
    src = f.read()

original = src  # keep for diff

# ── 1. Fix reasoning_start handler ─────────────────────────────────────────
# Remove the early-return duplicate guard so each new response gets a fresh bubble.
# Also ensure toggle check is first.
OLD_REASONING_START = '''  if (msg.type === "reasoning_start") {
    if (reasoningBubble) return;'''

NEW_REASONING_START = '''  if (msg.type === "reasoning_start") {
    // Close any previous bubble cleanly before starting a new one
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
      reasoningText = "";
    }
    // Respect toggle — if off, don't create a bubble
    if (localStorage.getItem("aperio-reasoning") === "false") return;'''

assert OLD_REASONING_START in src, "❌ Could not find reasoning_start block. Check the file manually."
src = src.replace(OLD_REASONING_START, NEW_REASONING_START, 1)
print("✅ Fixed reasoning_start handler")

# ── 2. Rename retract_done → reasoning_done ────────────────────────────────
count = src.count('"retract_done"')
if count > 0:
    src = src.replace('"retract_done"', '"reasoning_done"')
    print(f"✅ Renamed {count}x retract_done → reasoning_done")
else:
    print("⚠️  No retract_done found — skipping rename")

# ── 3. Fix reasoning_done handler — always collapse + null out ─────────────
# Find the reasoning_done block and replace with clean version
OLD_REASONING_DONE = '''  if (msg.type === "reasoning_done") {
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
    }
    reasoningText = "";'''

NEW_REASONING_DONE = '''  if (msg.type === "reasoning_done") {
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
    }
    reasoningText = "";
    streamingText = "";'''

if OLD_REASONING_DONE in src:
    src = src.replace(OLD_REASONING_DONE, NEW_REASONING_DONE, 1)
    print("✅ Fixed reasoning_done handler")
else:
    print("⚠️  reasoning_done block not found verbatim — trying fuzzy patch")
    # Fuzzy: find the if block and ensure reasoningBubble is nulled
    if '"reasoning_done"' in src:
        print("   reasoning_done exists, manual review recommended")

# ── 4. Add safety net to stream_start — collapse any stray reasoning bubble ─
OLD_STREAM_START = '  if (msg.type === "stream_start") {'

NEW_STREAM_START = '''  if (msg.type === "stream_start") {
    // Safety net: collapse reasoning bubble if still open
    if (reasoningBubble) {
      reasoningBubble.details.removeAttribute("open");
      reasoningBubble.statusSpan.textContent = "done";
      reasoningBubble.statusSpan.style.animation = "none";
      reasoningBubble.statusSpan.style.opacity = "0.4";
      reasoningBubble = null;
    }'''

assert OLD_STREAM_START in src, "❌ Could not find stream_start block."
src = src.replace(OLD_STREAM_START, NEW_STREAM_START, 1)
print("✅ Added safety net to stream_start")

# ── 5. Verify reasoningBubble declared at top level ───────────────────────
if "let reasoningBubble = null;" in src:
    print("✅ reasoningBubble variable already declared")
else:
    print("⚠️  'let reasoningBubble = null;' not found — add it near other let declarations")

# ── Write output ──────────────────────────────────────────────────────────
if src == original:
    print("\n⚠️  No changes made — all patterns may have already been applied")
else:
    with open(path, "w", encoding="utf-8") as f:
        f.write(src)
    print(f"\n✅ Patched file written to: {path}")
    print(f"   Changed {abs(len(src) - len(original))} bytes")
