import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { jsonSchemaToZodShape } from "../../providers/schema.js";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { redactSecrets } from "../../helpers/redactSecrets.js";
import { SELF_MEMORY_TOOLS, SELF_WIKI_TOOLS, SYNTHETIC_USER } from "../tool-profiles.js";
import { summarizeArgs } from "../toolActivity.js";
import logger from "../../helpers/logger.js";

// Aperio's own MCP tools are bridged into the SDK as `mcp__aperio__<name>`
// (see sdkServer below) and already flow through callToolHooked inside the
// bridge handler — that hook emits its own tool_start/tool_result. Only
// built-in SDK tools (Bash, WebFetch, Read, …) lack any card at all, so the
// synthesis below is keyed to exclude this prefix; matching by name here is
// exactly what prevents the double-card the plan's Risks section warns about.
const APERIO_TOOL_PREFIX = "mcp__aperio__";

// T-R5 cross-check (2026-07-27): with no skill match and no extraSystem, the
// SDK's own `claude_code` preset was the *only* identity the model had — it
// answered like a generic coding CLI ("what would you like help with?")
// instead of using an Aperio tool's results to answer the user's actual
// question. This nudge is deliberately narrow (not Aperio's full persona —
// see the getSkillsBlock comment below on why the full identity isn't sent)
// so it adds a task-completion instruction without fighting the preset.
// Always present in systemAppend (below), so exported for direct test
// assertions rather than re-deriving the string in the test file.
export const TOOL_RESULT_NUDGE = "You have Aperio's own tools (mcp__aperio__*) for the user's personal memory, documents, and data. When a tool call returns results, use them to answer the user's question directly and completely in this same turn — don't just describe what you found or ask what to do next unless the request is genuinely ambiguous. Your extended thinking already shows the user your plan and what you're about to do — do not restate it as a visible sentence before the answer (e.g. \"Let me pull those directly\" or \"I already have X, now I need Y\"); begin the visible response with the answer itself.";

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

// Anthropic MessageParam content for the outgoing turn: text blocks are
// redacted (PRIVACY-01, subscription egress), image blocks are passed through
// unchanged — imageHandler.js already emits the exact {type:"image",
// source:{type:"base64",...}} shape the SDK expects. A plain-string message
// (the common case, no attachments) stays a string rather than a
// single-element block array — smaller diff, and MessageParam accepts either.
function buildUserContent(lastUserMsg) {
  if (typeof lastUserMsg?.content === "string") return redactSecrets(lastUserMsg.content);
  const blocks = Array.isArray(lastUserMsg?.content) ? lastUserMsg.content : [];
  return blocks.map(block =>
    block.type === "text" ? { type: "text", text: redactSecrets(block.text ?? "") } : block
  );
}

function extractUserText(lastUserMsg) {
  return typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
}

// Preflight (lib/agent/preflight.js) can run an auto-doc_batch/doc_repos
// shortcut before this loop ever sees `messages`: it pushes a synthetic
// { role: "assistant", tool_use } + { role: "user", tool_result } pair
// straight onto the array so the last "user" message is that tool_result,
// not the real question. Every other provider forwards the whole trimmed
// `messages` array to the model, so this is invisible to them; this loop
// forwards only the one message it thinks is "the user's turn", so an
// unqualified last-user lookup here hands the SDK a bare tool-result blob
// with no question attached (T-R5 cross-check, 2026-07-27 — Sonnet 5 replied
// "I don't see a specific task or question in your message yet"). Skipping
// SYNTHETIC_USER-marked messages recovers the real question; the synthetic
// tail collected below recovers the retrieved content that would otherwise
// be silently dropped.
function findRealLastUserMsg(messages) {
  return [...messages].reverse().find(m => m.role === "user" && !m[SYNTHETIC_USER]);
}

// Everything preflight appended after the real user turn is a tool_use/
// tool_result pair this SDK session never saw happen (it isn't a resumed
// turn), so it can't be replayed as history — only its content can be
// surfaced. Folded into the outgoing user text as labeled, already-fetched
// context rather than as fake tool_result blocks, which would need a
// tool_use_id the SDK's own session never issued and could be rejected.
function collectAutoFetchedContext(messages, lastUserMsg) {
  const idx = messages.indexOf(lastUserMsg);
  if (idx === -1) return "";
  const chunks = [];
  for (const m of messages.slice(idx + 1)) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "tool_result" && typeof block.content === "string" && block.content.trim()) {
        chunks.push(block.content);
      }
    }
  }
  return chunks.join("\n\n---\n\n");
}

function withAutoFetchedContext(userContent, autoFetchedContext) {
  if (!autoFetchedContext) return userContent;
  const preamble = `Aperio already looked this up for you:\n\n${autoFetchedContext}\n\n---\n\nNow answer this:\n\n`;
  if (typeof userContent === "string") return preamble + userContent;
  return [{ type: "text", text: preamble }, ...userContent];
}

// query()'s async-iterable prompt form: exactly one SDKUserMessage carrying
// this turn's full content (text + any images) — Aperio doesn't replay
// history through this channel, the SDK's own session `resume` already
// carries prior turns.
async function* buildPromptIterable(content) {
  yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
}

export async function runClaudeCodeLoop(messages, emitter, opts = {}, getAbort, setAbort, ctx) {
  const { provider, callTool, mcpTools, claudeCodeState, nextToolSeq, state } = ctx;

  const lastUserMsg = findRealLastUserMsg(messages);
  const autoFetchedContext = collectAutoFetchedContext(messages, lastUserMsg);

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

  const prompt = buildPromptIterable(withAutoFetchedContext(buildUserContent(lastUserMsg), autoFetchedContext));

  // WS-B: reuse Aperio's own skill matcher (ensureTurn/getSkillPrompts via
  // ctx.getSkillsBlock) rather than pointing claude-code's native
  // .claude/skills/ discovery at Aperio's skills/ dir — that would bypass the
  // skill panel's enable/disable state, the forced /skill command, and
  // one-shot picks. WS-C: opts.extraSystem (memory pointers, post-compression
  // RAG blocks, workspace directives) previously never reached claude-code at
  // all — it now shares this same append channel.
  const skillsBlock = ctx.getSkillsBlock?.(extractUserText(lastUserMsg), opts.lang, messages) || "";
  const systemAppend = [TOOL_RESULT_NUDGE, skillsBlock, opts.extraSystem].filter(Boolean).join("\n\n---\n\n");

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

  const queryOptions = {
    model: provider.model,
    mcpServers: { aperio: sdkServer },
    maxTurns: 10,
    // Pinned to "medium" for every model behind this provider — not low/high/
    // xhigh/max. Works with the SDK's adaptive thinking to bound how much a
    // model narrates/deliberates before answering; models that don't support
    // effort levels at all silently ignore this field.
    effort: "medium",
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

  if (process.env.APERIO_CLAUDE_CODE_CWD) queryOptions.cwd = process.env.APERIO_CLAUDE_CODE_CWD;

  // Append onto the SDK's own `claude_code` preset system prompt rather than
  // replacing it — never inject an empty/stray append when there's no skill
  // match and no extraSystem this turn (J3).
  if (systemAppend) {
    queryOptions.systemPrompt = { type: "preset", preset: "claude_code", append: systemAppend };
  }

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
        // WS4/D1 gave claude-code the same collapsed reasoning bubble every
        // other provider uses, on the assumption that a `thinking` content
        // block always carries real narration. Verified live (2026-07-27)
        // that's often false: adaptive thinking regularly opens and closes a
        // `thinking` block with zero `thinking_delta` text in between while
        // still billing real thinking tokens (message_delta usage) — Aperio
        // has no control over whether Anthropic discloses a summary that
        // turn. A UI bubble that opens, shows nothing, and closes reads as
        // broken rather than "no reasoning to show," so the bubble itself is
        // retired for this provider; the real token spend is still tracked
        // below and reported via stream_end.usage.thinking_tokens.
        if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") {
          if (state) state.thinks = true;
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

  const validatedText = validateOutputSafe(finalText, "claude-code");
  emitter.send({ type: "stream_end", text: validatedText, usage: finalUsage });
  return validatedText;
}
