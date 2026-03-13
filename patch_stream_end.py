import sys

path = sys.argv[1] if len(sys.argv) > 1 else "public/index.html"

with open(path, "r", encoding="utf-8") as f:
    src = f.read()

OLD = '''  if (msg.type === "stream_end") {
    if (streamingBubble && streamingText.trim()) {
      finalizeStreamingBubble(streamingBubble, msg.text || streamingText);
    } else if (streamingBubble) {
      streamingBubble.wrap?.remove();
    }
    streamingBubble = null;
    streamingText = "";
    isThinking = false;
    setStatus("connected", "connected");
    sendBtn.disabled = chatInput.value.trim() === "";
    scrollToBottom();
  }'''

NEW = '''  if (msg.type === "stream_end") {
    if (streamingBubble && streamingText.trim()) {
      finalizeStreamingBubble(streamingBubble, msg.text || streamingText);
    } else if (streamingBubble) {
      streamingBubble.wrap?.remove();
    } else if (msg.text?.trim()) {
      // No streaming bubble (thinking model — answer sent all at once)
      removeThinking();
      removeToolIndicator();
      addMessage("ai", msg.text);
    }
    streamingBubble = null;
    streamingText = "";
    isThinking = false;
    setStatus("connected", "connected");
    sendBtn.disabled = chatInput.value.trim() === "";
    scrollToBottom();
  }'''

assert OLD in src, "❌ stream_end block not found verbatim — check spacing"
src = src.replace(OLD, NEW, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(src)

print(f"✅ stream_end fallback added to {path}")
