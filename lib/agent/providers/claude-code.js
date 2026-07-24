import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { jsonSchemaToZodShape } from "../../providers/schema.js";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { redactSecrets } from "../../helpers/redactSecrets.js";
import { SELF_MEMORY_TOOLS, SELF_WIKI_TOOLS } from "../tool-profiles.js";
import { summarizeArgs } from "../toolActivity.js";
import logger from "../../helpers/logger.js";

// Aperio's own MCP tools are bridged into the SDK as `mcp__aperio__<name>`
// (see sdkServer below) and already flow through callToolHooked inside the
// bridge handler — that hook emits its own tool_start/tool_result. Only
// built-in SDK tools (Bash, WebFetch, Read, …) lack any card at all, so the
// synthesis below is keyed to exclude this prefix; matching by name here is
// exactly what prevents the double-card the plan's Risks section warns about.
const APERIO_TOOL_PREFIX = "mcp__aperio__";

function summarizeToolResultBlock(block) {
  const text = typeof block.content === "string"
    ? block.content
    : Array.isArray(block.content)
      ? block.content.filter(b => b.type === "text").map(b => b.text).join("\n")
      : "";
  const trimmed = text.trim();
  const ok = !block.is_error;
  if (!trimmed) return { ok };
  const line = trimmed.split("\n").find(l => l.trim()) ?? "";
  return { ok, summary: line.length > 80 ? line.slice(0, 79) + "…" : line };
}

function toSdkContent(result) {
  if (typeof result === "string") return [{ type: "text", text: result || "No result" }];
  if (Array.isArray(result)) {
    return result.map(block =>
      block.type === "image"
        ? { type: "image", source: block.source }
        : { type: "text", text: block.text ?? "" }
    );
  }
  return [{ type: "text", text: "No result" }];
}

function mapUsage(u, thinkingTokens = 0) {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    thinking_tokens: thinkingTokens,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export async function runClaudeCodeLoop(messages, emitter, opts = {}, getAbort, setAbort, ctx) {
  const { provider, callTool, mcpTools, claudeCodeState, nextToolSeq, state } = ctx;

  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  const lastUserText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";

  // Build tool bridge — the one thing Aperio must provide. Filter out
  // self-memory / self-wiki tools (local-only; never exposed to cloud providers).
  // The SDK manages its own tool selection, permissions, and turn loop.
  const sdkTools = (mcpTools ?? [])
    .filter(t => !SELF_MEMORY_TOOLS.has(t.name) && !SELF_WIKI_TOOLS.has(t.name))
    .map(t => tool(
      t.name, t.description ?? "", jsonSchemaToZodShape(t.inputSchema),
      async (args) => {
        const result = await callTool(t.name, args);
        return { content: toSdkContent(result) };
      }
    ));
  const sdkServer = createSdkMcpServer({ name: "aperio", version: "1", tools: sdkTools });

  // PRIVACY-01: scrub secrets from the outgoing prompt (subscription egress).
  const prompt = redactSecrets(lastUserText);

  // Scrub ANTHROPIC_API_KEY so the SDK authenticates via subscription credentials.
  const subEnv = { ...process.env };
  delete subEnv.ANTHROPIC_API_KEY;

  let abortCtrl = getAbort?.();
  if (!abortCtrl) {
    abortCtrl = new AbortController();
    setAbort?.(abortCtrl);
  }

  emitter.send({ type: "stream_start" });

  let streamText = "";
  let finalText = "";
  let finalUsage = mapUsage(null);
  // Built-in tool cards share callToolHooked's per-turn seq allocator
  // (ctx.nextToolSeq) rather than keeping an independent counter — the SDK
  // bridge's aperio tool calls go through that same hook in this same turn,
  // so two separate counters would both start at 1 and collide on the
  // frontend's seq-keyed card map (the first result could resolve the wrong
  // card while the other one is left stuck, or gets resolved twice).
  const pendingBuiltinTools = new Map(); // tool_use id -> { seq, name }
  // WS4/D1: real thinking-token breakdown only appears on the raw stream_event's
  // message_delta (verified live) — the final "result" message's usage lacks it —
  // so it's captured here and spliced into finalUsage below instead of the
  // hardcoded 0 (D2).
  let realThinkingTokens = 0;
  let inThinkingBlock = false;

  const queryOptions = {
    model: provider.model,
    mcpServers: { aperio: sdkServer },
    maxTurns: 10,
    // Non-interactive: auto-approve every tool (built-in WebFetch/Bash/… and
    // mcp__aperio__*). There is no permission-prompt bridge to the web UI, so
    // "default" mode would stall the turn waiting on an approval that can never
    // arrive. bypassPermissions lets the SDK pick the best tool for the job.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true, // required by the SDK for bypassPermissions
    settingSources: [],
    env: subEnv,
    abortController: abortCtrl,
    // Required for any `stream_event` messages to be emitted at all (verified
    // live — without it the CLI never passes --include-partial-messages, so
    // even the text-token streaming above silently never fires).
    includePartialMessages: true,
  };

  if (claudeCodeState?.sessionId) {
    queryOptions.resume = claudeCodeState.sessionId;
  }

  const q = query({ prompt, options: queryOptions });

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        const label = claudeCodeState?.sessionId ? " (resumed)" : " (new)";
        logger.info(`[claude-code] session_id: ${msg.session_id}${label}`);
        if (claudeCodeState) claudeCodeState.sessionId = msg.session_id;
      }

      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          emitter.send({ type: "token", text: ev.delta.text });
          streamText += ev.delta.text;
        }
        if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          const toolName = ev.content_block.name.replace(/^mcp__aperio__/, "");
          emitter.send({ type: "tool", name: toolName });
        }
        // WS4/D1: adaptive thinking is on by default for supporting models (SDK
        // docs) — this just surfaces it as the same collapsed bubble every other
        // provider uses. A redacted/adaptive turn can carry an empty `thinking`
        // string (verified live) — still open/close the bubble, just skip the
        // no-op token emit.
        if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") {
          inThinkingBlock = true;
          if (state) state.thinks = true;
          emitter.send({ type: "reasoning_start" });
        }
        if (ev.type === "content_block_delta" && ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
          emitter.send({ type: "reasoning_token", text: ev.delta.thinking });
        }
        if (ev.type === "content_block_stop" && inThinkingBlock) {
          inThinkingBlock = false;
          emitter.send({ type: "reasoning_done" });
        }
        if (ev.type === "message_delta" && ev.usage?.output_tokens_details) {
          realThinkingTokens = ev.usage.output_tokens_details.thinking_tokens ?? realThinkingTokens;
        }
      }

      // Built-in tool cards (WS3 / group C): assistant messages carry the
      // full tool_use block (id, name, input) once the model finishes
      // emitting it. Aperio tools are excluded — the SDK bridge's own
      // callToolHooked invocation already cards those; carding them again
      // here would double them (plan Risks, test C2).
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_use" || block.name.startsWith(APERIO_TOOL_PREFIX)) continue;
          const seq = nextToolSeq();
          pendingBuiltinTools.set(block.id, { seq, name: block.name });
          emitter.send({ type: "tool_start", seq, name: block.name, arg: summarizeArgs(block.name, block.input || {}) });
        }
      }

      if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type !== "tool_result") continue;
          const pending = pendingBuiltinTools.get(block.tool_use_id);
          if (!pending) continue; // aperio tool_result, or no matching tool_use seen — never fabricate a card
          pendingBuiltinTools.delete(block.tool_use_id);
          emitter.send({ type: "tool_result", seq: pending.seq, name: pending.name, ...summarizeToolResultBlock(block) });
        }
      }

      if (msg.type === "result") {
        finalText = msg.result ?? streamText;
        finalUsage = mapUsage(msg.usage, realThinkingTokens);
        const cacheRead = msg.usage?.cache_read_input_tokens ?? 0;
        const cacheCreated = msg.usage?.cache_creation_input_tokens ?? 0;
        if (cacheRead > 0 || cacheCreated > 0) {
          logger.info(`[claude-code] cache: read=${cacheRead} created=${cacheCreated} input=${msg.usage?.input_tokens ?? 0}`);
        }
        if (msg.subtype !== "success") {
          logger.warn(`[claude-code] result subtype: ${msg.subtype}`);
        }
      }
    }
  } catch (err) {
    logger.error("[claude-code] loop error:", err.message);
    const errText = `⚠️ Claude Code provider error: ${err.message}`;
    emitter.send({ type: "token", text: errText });
    finalText = streamText || errText;
  }

  // Any built-in tool_use observed but never resolved with a tool_result (the
  // SDK threw, the turn ended abnormally, a result was dropped) must not
  // leave its card stuck "running" on the frontend forever.
  for (const pending of pendingBuiltinTools.values()) {
    emitter.send({ type: "tool_result", seq: pending.seq, name: pending.name, ok: false });
  }
  pendingBuiltinTools.clear();

  // A thinking block opened but never stopped (SDK threw, turn aborted mid-
  // reasoning) must not leave the collapsed bubble stuck "thinking…" forever.
  if (inThinkingBlock) { emitter.send({ type: "reasoning_done" }); inThinkingBlock = false; }

  const validatedText = validateOutputSafe(finalText, "claude-code");
  emitter.send({ type: "stream_end", text: validatedText, usage: finalUsage });
  return validatedText;
}
