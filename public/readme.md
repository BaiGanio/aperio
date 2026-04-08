Here's a token-based trimming function to replace the current MAX_HISTORY logic:
javascriptconst CTX_LIMIT = 131072;      // your model's context window
const CTX_TRIM_TARGET = 0.75;  // trim when above 75% full
const CTX_MIN_MESSAGES = 4;    // always keep at least this many recent messages

function trimByTokens(messages, inputTokens) {
  // Not near the limit yet — keep everything
  if (inputTokens < CTX_LIMIT * CTX_TRIM_TARGET) return messages;

  // How aggressively to trim — the closer to the limit, the more we drop
  const pressure = (inputTokens - CTX_LIMIT * CTX_TRIM_TARGET) / 
                   (CTX_LIMIT * (1 - CTX_TRIM_TARGET));
  const dropFraction = Math.min(0.5, pressure * 0.5);
  const toDrop = Math.floor((messages.length - 1) * dropFraction);

  if (toDrop <= 0) return messages;

  // Always keep messages[0] (system prompt) and the most recent messages
  const kept = Math.max(CTX_MIN_MESSAGES, messages.length - toDrop);
  return [messages[0], ...messages.slice(-(kept - 1))];
}
Then in runOllamaLoop, replace:
javascript// OLD
const trimmed = messages.length > MAX_HISTORY
  ? [messages[0], ...messages.slice(-(MAX_HISTORY - 1))]
  : messages;
with:
javascript// NEW
const trimmed = trimByTokens(messages, streamUsage.input_tokens);
How it works:

Below 75% of context — no trimming at all
Between 75–100% — progressively drops older messages, the closer you are to the limit the more it drops
Always preserves the first message (system prompt) and at least CTX_MIN_MESSAGES recent messages

You'll want to set CTX_LIMIT to match your model — common values are 131072 (128k) for Llama 3 / Qwen, 32768 for older models. You can also make it a variable pulled from the provider config if you switch models often.