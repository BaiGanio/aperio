import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { redactSecrets } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";

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

function renderTranscript(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content = m.content;
      if (Array.isArray(content) && content.every(b => b.type === "tool_result")) continue;
      const text = typeof content === "string"
        ? content
        : content?.find?.(b => b.type === "text")?.text ?? "";
      if (text) lines.push(`User: ${text}`);
    } else if (m.role === "assistant") {
      const content = m.content;
      const text = typeof content === "string"
        ? content
        : content?.find?.(b => b.type === "text")?.text ?? "";
      if (text) lines.push(`Assistant: ${text}`);
    }
  }
  return lines.join("\n");
}

function mapUsage(u) {
  return {
    input_tokens: u?.input_tokens ?? 0,
    output_tokens: u?.output_tokens ?? 0,
    thinking_tokens: 0,
    cache_read_input_tokens: u?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export async function runClaudeCodeLoop(messages, emitter, opts = {}, getAbort, setAbort, ctx) {
  const { provider, callTool, getSystemPrompt, getAnthropicTools, claudeCodeState } = ctx;

  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  const lastUserText = typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";

  const resolvedTools = getAnthropicTools(lastUserText, messages);
  const allowedSet = new Set(resolvedTools.map(t => `mcp__aperio__${t.name}`));

  const sdkTools = resolvedTools.map(t =>
    tool(
      t.name,
      t.description ?? "",
      z.object({}).passthrough(),
      async (args) => {
        const result = await callTool(t.name, args);
        return { content: toSdkContent(result) };
      }
    )
  );
  const sdkServer = createSdkMcpServer({ name: "aperio", version: "1", tools: sdkTools });

  const systemPrompt = getSystemPrompt(lastUserText, opts.lang, opts.extraSystem, messages);

  // Resume an existing session (turns 2+) by passing only the new user message.
  // On the first turn there is no session yet, so prepend the conversation transcript.
  const isResuming = !!claudeCodeState?.sessionId;
  let prompt;
  if (isResuming) {
    prompt = lastUserText;
  } else {
    const transcript = renderTranscript(messages.slice(0, -1));
    prompt = transcript
      ? `<conversation_history>\n${transcript}\n</conversation_history>\n\n${lastUserText}`
      : lastUserText;
  }
  // PRIVACY-01: scrub secrets from the outgoing prompt (subscription egress).
  prompt = redactSecrets(prompt);

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

  const queryOptions = {
    model: provider.model,
    systemPrompt,
    mcpServers: { aperio: sdkServer },
    allowedTools: [...allowedSet],
    canUseTool: async (name) =>
      allowedSet.has(name)
        ? { behavior: "allow" }
        : { behavior: "deny", message: `Tool ${name} is not permitted in this context.` },
    includePartialMessages: true,
    maxTurns: 40,
    permissionMode: "default",
    settingSources: [],
    env: subEnv,
    abortController: abortCtrl,
  };

  if (isResuming) {
    queryOptions.resume = claudeCodeState.sessionId;
  }

  const q = query({ prompt, options: queryOptions });

  try {
    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        logger.info(`[claude-code] session_id: ${msg.session_id}${isResuming ? " (resumed)" : " (new)"}`);
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
      }

      if (msg.type === "result") {
        finalText = msg.result ?? streamText;
        finalUsage = mapUsage(msg.usage);
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

  const validatedText = validateOutputSafe(finalText, "claude-code");
  emitter.send({ type: "stream_end", text: validatedText, usage: finalUsage });
  return validatedText;
}
