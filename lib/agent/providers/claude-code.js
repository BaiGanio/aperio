import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { jsonSchemaToZodShape } from "../../providers/schema.js";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { redactSecrets } from "../../helpers/redactSecrets.js";
import { SELF_MEMORY_TOOLS, SELF_WIKI_TOOLS } from "../tool-profiles.js";
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
  const { provider, callTool, mcpTools, claudeCodeState } = ctx;

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
