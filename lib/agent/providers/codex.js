import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { validateOutputSafe } from "../../helpers/validateOutput.js";
import { redactSecrets } from "../../helpers/redactSecrets.js";
import logger from "../../helpers/logger.js";

const ROOT_ARTIFACT_EXTENSIONS = new Set([
  ".csv", ".tsv", ".xls", ".xlsx", ".doc", ".docx", ".ppt", ".pptx",
  ".pdf", ".txt", ".xml", ".zip", ".png", ".jpg", ".jpeg", ".webp", ".gif",
]);

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function tomlStringArray(values) {
  return `[${values.map(v => tomlString(v)).join(", ")}]`;
}

function enumValue(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function mapUsage(usage) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    thinking_tokens: usage?.reasoning_output_tokens ?? 0,
    cache_read_input_tokens: usage?.cached_input_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

function latestUserText(messages) {
  const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
  return typeof lastUserMsg?.content === "string"
    ? lastUserMsg.content
    : lastUserMsg?.content?.find?.(b => b.type === "text")?.text ?? "";
}

function buildPrompt(messages, extraSystem = "") {
  const userText = redactSecrets(latestUserText(messages));
  const systemText = redactSecrets(extraSystem);
  if (!systemText) return userText;
  return `${systemText}\n\n---\n\n## Current user request\n${userText}`;
}

function rootArtifactSnapshot(root) {
  try {
    return new Set(readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile() && ROOT_ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
      .map(entry => entry.name));
  } catch {
    return new Set();
  }
}

function relocateNewRootArtifacts(root, scratchDir, before) {
  if (!scratchDir) return [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const moved = [];
  for (const entry of entries) {
    if (!entry.isFile() || before.has(entry.name)) continue;
    if (!ROOT_ARTIFACT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;

    try {
      mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
      let filename = entry.name;
      let destination = join(scratchDir, filename);
      try {
        statSync(destination);
        filename = `${Date.now()}-${filename}`;
        destination = join(scratchDir, filename);
      } catch { /* destination is available */ }
      renameSync(join(root, entry.name), destination);
      const sizeKb = Math.max(1, Math.round(statSync(destination).size / 1024));
      moved.push({
        filename,
        path: destination,
        url: `/scratch/${basename(scratchDir)}/${filename}`,
        sizeKb,
      });
    } catch (err) {
      logger.warn(`[codex] failed to relocate root artifact ${entry.name}: ${err.message}`);
    }
  }
  return moved;
}

function itemName(item) {
  if (!item) return null;
  if (item.type === "command_execution") return item.command || "shell";
  if (item.type === "mcp_tool_call") {
    return item.tool || item.name || item.tool_name || item.server_tool_name || "mcp";
  }
  if (item.type === "web_search") return "web_search";
  if (item.type === "file_change") return item.path ? `file_change ${item.path}` : "file_change";
  return null;
}

function buildCodexArgs({ prompt, provider, root, sessionId }) {
  const mcpPath = resolve(root, "mcp/index.js");
  const sandbox = enumValue(
    process.env.CODEX_SANDBOX,
    new Set(["read-only", "workspace-write", "danger-full-access"]),
    "workspace-write",
  );
  const approvalPolicy = enumValue(
    process.env.CODEX_APPROVAL_POLICY,
    new Set(["untrusted", "on-request", "never"]),
    "never",
  );
  // `approval_policy=never` cannot answer an MCP prompt. `approve` marks this
  // explicitly configured, required Aperio server as trusted for the run.
  const mcpApprovalMode = enumValue(
    process.env.CODEX_MCP_APPROVAL_MODE,
    new Set(["auto", "prompt", "approve"]),
    "approve",
  );
  const timeout = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const toolTimeoutSec = timeout(process.env.CODEX_MCP_TOOL_TIMEOUT_SEC, 300);
  const startupTimeoutSec = timeout(process.env.CODEX_MCP_STARTUP_TIMEOUT_SEC, 20);

  const common = [
    "exec",
    "--json",
    "--ignore-user-config",
    "--cd", root,
    "--sandbox", sandbox,
    "--model", provider.model,
    "-c", `approval_policy=${tomlString(approvalPolicy)}`,
    "-c", `mcp_servers.aperio.command=${tomlString(process.execPath)}`,
    "-c", `mcp_servers.aperio.args=${tomlStringArray(["--no-warnings=ExperimentalWarning", mcpPath])}`,
    "-c", `mcp_servers.aperio.cwd=${tomlString(root)}`,
    "-c", "mcp_servers.aperio.required=true",
    "-c", `mcp_servers.aperio.startup_timeout_sec=${startupTimeoutSec}`,
    "-c", `mcp_servers.aperio.tool_timeout_sec=${toolTimeoutSec}`,
    "-c", `mcp_servers.aperio.default_tools_approval_mode=${tomlString(mcpApprovalMode)}`,
  ];

  if (process.env.CODEX_IGNORE_RULES === "1") common.push("--ignore-rules");

  if (sessionId) {
    return [...common, "resume", sessionId, prompt];
  }
  return [...common, prompt];
}

export async function runCodexLoop(messages, emitter, opts = {}, getAbort, setAbort, ctx) {
  const {
    provider, codexState, getProviderSessionId, updateProviderSessionId,
  } = ctx;
  const root = opts.root || ctx.root || process.cwd();
  const prompt = buildPrompt(messages, opts.extraSystem);
  const spawn = ctx.codexSpawn || nodeSpawn;
  const scratchDir = ctx.getActiveScratchDir?.() ?? null;
  const rootArtifactsBefore = rootArtifactSnapshot(root);

  let abortCtrl = getAbort?.();
  if (!abortCtrl) {
    abortCtrl = new AbortController();
    setAbort?.(abortCtrl);
  }

  emitter.send({ type: "stream_start" });

  let finalText = "";
  let streamedText = "";
  let finalUsage = mapUsage(null);
  let stderr = "";
  let buffer = "";
  let settled = false;
  let turnFailed = "";

  const providerSessionKey = opts.providerSessionKey || "codex";
  const persistedSessionId = opts.aperioSessionId
    ? getProviderSessionId?.(opts.aperioSessionId, providerSessionKey)
    : null;
  // Scoped calls must never fall back to agent-global state: that would leak
  // one Aperio chat's Codex transcript into another connection.
  const resumeSessionId = opts.aperioSessionId
    ? persistedSessionId
    : codexState?.sessionId;

  const args = buildCodexArgs({ prompt, provider, root, sessionId: resumeSessionId });
  const env = {
    ...process.env,
    APERIO_PROC_ROLE: "codex-provider",
    APERIO_PROVIDER_LOCAL: "0",
  };
  const child = spawn("codex", args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: abortCtrl.signal,
  });

  function handleEvent(ev) {
    if (ev.type === "thread.started" && ev.thread_id) {
      const label = resumeSessionId ? " (resumed)" : " (new)";
      logger.info(`[codex] thread_id: ${ev.thread_id}${label}`);
      if (codexState) codexState.sessionId = ev.thread_id;
      if (opts.aperioSessionId) {
        updateProviderSessionId?.(opts.aperioSessionId, providerSessionKey, ev.thread_id);
      }
      return;
    }

    if (ev.type === "item.started") {
      const name = itemName(ev.item);
      if (name) emitter.send({ type: "tool", name });
      return;
    }

    if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
      const text = ev.item.text ?? "";
      if (text) {
        if (streamedText) {
          emitter.send({ type: "token", text: "\n\n" });
          streamedText += "\n\n";
        }
        emitter.send({ type: "token", text });
        streamedText += text;
        finalText = text;
      }
      return;
    }

    if (ev.type === "turn.completed") {
      finalUsage = mapUsage(ev.usage);
      return;
    }

    if (ev.type === "turn.failed" || ev.type === "error") {
      const msg = ev.error?.message || ev.message || "Codex turn failed";
      turnFailed = msg;
      logger.warn(`[codex] ${msg}`);
    }
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handleEvent(JSON.parse(trimmed));
    } catch (err) {
      logger.warn(`[codex] ignored non-JSON output: ${trimmed.slice(0, 200)}`);
    }
  }

  child.stdout?.setEncoding?.("utf8");
  child.stdout?.on("data", chunk => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
    }
  });

  child.stderr?.setEncoding?.("utf8");
  child.stderr?.on("data", chunk => {
    stderr += chunk;
  });

  const exitCode = await new Promise(resolveExit => {
    child.on("error", err => {
      if (settled) return;
      settled = true;
      resolveExit({ code: null, error: err });
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      resolveExit({ code });
    });
  });

  if (buffer.trim()) handleLine(buffer);

  if (abortCtrl.signal.aborted) {
    emitter.send({ type: "stream_end", text: "", usage: finalUsage });
    return "";
  }

  if (exitCode.error) {
    logger.error("[codex] process error:", exitCode.error.message);
    const errText = `⚠️ Codex provider error: ${exitCode.error.message}`;
    emitter.send({ type: "token", text: errText });
    finalText = streamedText || errText;
  } else if (exitCode.code !== 0) {
    const detail = stderr.trim() || `exit code ${exitCode.code}`;
    logger.error(`[codex] process exited with ${detail}`);
    const errText = `⚠️ Codex provider error: ${detail}`;
    emitter.send({ type: "token", text: errText });
    finalText = streamedText || errText;
  } else if (turnFailed) {
    const errText = `⚠️ Codex provider error: ${turnFailed}`;
    emitter.send({ type: "token", text: errText });
    finalText = streamedText || errText;
  } else if (!finalText && !streamedText) {
    const errText = "⚠️ Codex provider error: Codex exited without a final response";
    emitter.send({ type: "token", text: errText });
    finalText = errText;
  }

  const relocated = relocateNewRootArtifacts(root, scratchDir, rootArtifactsBefore);
  if (relocated.length) {
    for (const file of relocated) {
      emitter.send({
        type: "generated_file",
        filename: file.filename,
        url: file.url,
        sizeKb: file.sizeKb,
      });
    }
    const paths = relocated.map(file => `- ${file.path}`).join("\n");
    const note = `Aperio moved generated artifact${relocated.length === 1 ? "" : "s"} into the session workspace:\n${paths}`;
    emitter.send({ type: "token", text: `\n\n${note}` });
    streamedText += `\n\n${note}`;
    finalText = finalText ? `${finalText}\n\n${note}` : note;
  }

  const validatedText = validateOutputSafe(finalText || streamedText, "codex");
  emitter.send({ type: "stream_end", text: validatedText, usage: finalUsage });
  return validatedText;
}
