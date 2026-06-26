import { validateOutputSafe } from "../helpers/validateOutput.js";
import logger from "../helpers/logger.js";

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

// Tools that touch disk, memory, or external state. For these, we refuse to
// "repair" malformed JSON args — the regex repair below can succeed in
// producing parseable JSON while silently shifting string boundaries, which
// for edit_file/write_file means a corrupted file lands on disk. Better to
// hand the model a parse error and let it retry with valid JSON.
const DESTRUCTIVE_TOOLS = new Set([
  "write_file", "edit_file", "append_file", "generate_xlsx", "generate_docx", "run_node_script",
  "run_python_script", "run_shell", "wiki_write", "remember", "update_memory", "forget",
  "backfill_embeddings", "deduplicate_memories", "delete_file", "db_execute",
]);

// Walk from the "{" at `start` to its string-aware matching "}". Returns the
// index just past the close, or -1 if the object never balances. Quotes and
// escapes are tracked so braces inside string values don't shift the depth.
function matchBrace(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

// Strip //-line and /* */-block comments that weak models sometimes emit inside
// JSON, leaving string contents untouched. JSON.parse rejects comments, so an
// otherwise-valid tool call carrying them would be dropped without this.
function stripJsonComments(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < s.length && s[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out;
}

export function extractTextToolCall(text, messages) {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const searchIn = fenceMatch ? fenceMatch[1].trim() : text;
  // Scan each "{" for the first brace-balanced object that parses and carries a
  // string "name". The previous non-greedy regex stopped at the first "}", which
  // truncated any object whose params object closed before the outer brace —
  // i.e. the common name-first { "name": …, "parameters": { … } } shape that
  // local models emit, so those calls were silently dropped as plain text.
  for (let i = searchIn.indexOf("{"); i !== -1; i = searchIn.indexOf("{", i + 1)) {
    const end = matchBrace(searchIn, i);
    if (end === -1) continue;
    const candidate = searchIn.slice(i, end);
    if (!/"name"\s*:\s*"[^"]+"/.test(candidate)) continue;
    let parsed;
    try { parsed = JSON.parse(stripJsonComments(candidate)); } catch { continue; }
    if (typeof parsed.name !== "string" || !parsed.name) continue;
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? {};
    const cleaned = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null"));
    let trailing = fenceMatch
      ? text.slice(text.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim()
      : text.slice(text.indexOf(candidate) + candidate.length).trim();
    trailing = trailing.replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
    return { name: parsed.name, input: cleaned, trailing };
  }
  return null;
}

// Tool-call shapes a weak model emits when it "calls" a tool in prose instead
// of via a real tool_calls array: XML-ish tags it hallucinates from training
// data (<execute_tool>…</execute_tool>), or the function notation lifted
// verbatim from skill docs (recall(query?, …)). extractTextToolCall recovers
// the JSON-object form; these slip past it and would otherwise render as a
// normal answer — a silent failure where the model then claims it ran the tool.
const TOOL_LEAK_PATTERNS = [
  /<\/?\s*(?:execute_tool|tool_call|tool_use|function_call|invoke|tool)\b/i,
  /\bcall\s*\(\s*['"]?[a-zA-Z_]/,   // call(recall, …)  /  call("recall", …)
  /:\s*call\s*\(/i,                 // skills/…/SKILL.md:call(recall, …)
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// True when `text` looks like a tool call rendered as prose AND none of the
// real channels (native tool_calls / extractTextToolCall) recovered it. The
// known-tool function form (recall(query="…")) is only flagged when it carries
// a `name=` argument, so plain prose ("I'll recall it later") never matches.
export function detectToolCallLeak(text, toolNames = []) {
  if (!text || !text.trim()) return false;
  if (TOOL_LEAK_PATTERNS.some((re) => re.test(text))) return true;
  if (toolNames.length) {
    const re = new RegExp(`\\b(?:${toolNames.map(escapeRe).join("|")})\\s*\\(\\s*[a-zA-Z_]+\\s*=`, "i");
    if (re.test(text)) return true;
  }
  return false;
}

// A native tool call whose function.name arrived corrupted: gemma (especially
// with reasoning on) sometimes wraps its call in hallucinated channel/harmony
// markup ("<|channel>thought <channel|><|tool_call>call:db_schema") and Ollama
// dumps the raw text into function.name, so the dispatched name matches no tool
// and MCP returns -32602 "not found". The real tool name is still embedded;
// recover it by matching a known tool name as a bounded token, preferring the
// last occurrence (the one right after the "call:" marker). Returns null when
// no known tool is present — the call is unusable and the caller treats it as a
// leak (retract + nudge + retry).
export function recoverToolName(name, toolNames = []) {
  if (!name) return null;
  if (toolNames.includes(name)) return name;
  let best = null;
  for (const t of toolNames) {
    const re = new RegExp(`(?<![a-zA-Z0-9_])${escapeRe(t)}(?![a-zA-Z0-9_])`, "g");
    let m;
    while ((m = re.exec(name)) !== null) {
      if (!best || m.index > best.index || (m.index === best.index && t.length > best.name.length)) best = { name: t, index: m.index };
    }
  }
  return best ? best.name : null;
}

export class ToolExecutor {
  constructor(callTool, emitter, messages) { this.callTool = callTool; this.emitter = emitter; this.messages = messages; this.streamUsage = zeroUsage(); }
  async executeToolCalls(toolCalls, cleanText = "", reasoningContent = null) {
    if (!toolCalls?.length) return false;
    const validatedText = validateOutputSafe(cleanText, "tool-preamble");
    const msg = { role: "assistant", content: [] };
    if (validatedText) msg.content.push({ type: "text", text: validatedText });
    if (reasoningContent) msg.reasoning_content = reasoningContent;
    const parsedByTc = new Map();
    for (const tc of toolCalls) {
      const parsed = this.parseArgs(tc.args, tc.name);
      parsedByTc.set(tc.id, parsed);
      msg.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parsed });
    }
    this.messages.push(msg);
    const results = [];
    for (const tc of toolCalls) {
      // Surface each tool call to the UI so the user sees what the agent is
      // doing during the otherwise-silent execution window (e.g. write_file →
      // run_node_script → verify on a pptx build). Without this the frontend
      // falls back to an idle "connected" state and looks frozen. Anthropic
      // emits this from its own stream; deepseek/ollama route through here.
      this.emitter.send({ type: "tool", name: tc.name });
      results.push({ type: "tool_result", tool_use_id: tc.id, content: await this.callTool(tc.name, parsedByTc.get(tc.id)) });
    }
    this.messages.push({ role: "tool", content: results }); return true;
  }
  async executeInterceptedToolCall(intercepted, reasoningContent = null) {
    if (!intercepted) return false;
    this.emitter.send({ type: "retract" }); this.emitter.send({ type: "tool", name: intercepted.name });
    const result = await this.callTool(intercepted.name, intercepted.input);
    const id = `intercept_${Date.now()}`;
    this.messages.push({ role: "assistant", content: [{ type: "tool_use", id, name: intercepted.name, input: intercepted.input }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    this.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] });
    if (intercepted.trailing) {
      const validated = validateOutputSafe(intercepted.trailing, "intercept-trailing");
      this.emitter.send({ type: "stream_start" }); this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }] }); return validated;
    }
    return null;
  }
  parseArgs(argsStr, toolName = "") {
    if (!argsStr || argsStr.trim() === "") return {};
    try { return JSON.parse(argsStr); } catch (err) {
      // For destructive tools, do not attempt regex repair — a "successful"
      // repair can shift string boundaries by one quote and silently corrupt
      // file contents. Hand the model a parse error and let it retry.
      if (DESTRUCTIVE_TOOLS.has(toolName)) {
        logger.error(
          `[executor] parseArgs REFUSED to repair "${toolName}" args (destructive tool): ${err.message}\n` +
          `  raw: ${argsStr.slice(0, 400)}`
        );
        return { __parse_error__:
          `Tool "${toolName}" requires strictly valid JSON arguments. JSON.parse error: ${err.message}. ` +
          `Retry with correctly escaped JSON (every string must be double-quoted, every key must be followed by a colon, every internal quote must be escaped as \\").`
        };
      }
      const repaired = argsStr
        .replace(/"([^"\\]*)"\s*(?=")/g, '"$1":')              // missing colon: {"key""val"} → {"key":"val"}
        .replace(/(?<=[{,]\s*)"([^"{}:,\n\r]+):/g, '"$1":')    // unclosed key quote: "key: val → "key": val
        .replace(/([^"\\])\s*}\s*$/, '$1"}');                   // missing closing quote at end
      try {
        const result = JSON.parse(repaired);
        logger.warn(
          `[executor] parseArgs repaired malformed JSON from model (${toolName || "unknown"})\n` +
          `  raw:      ${argsStr.slice(0, 400)}\n` +
          `  repaired: ${repaired.slice(0, 400)}`
        );
        return result;
      } catch { /* fall through to error */ }
      logger.error(
        `[executor] parseArgs failed (${toolName || "unknown"}): ${err.message}\n` +
        `  raw: ${argsStr.slice(0, 400)}`
      );
      return { __parse_error__: `Tool arguments were not valid JSON: ${err.message}. Please retry with correct JSON.` };
    }
  }
  async executeThinkingResponse(cleanText, toolCalls, streamHandler, isThinkingModel, reasoningContent = null) {
    const intercepted = cleanText.trim() ? extractTextToolCall(cleanText, this.messages) : null;
    if (intercepted) {
      const validated = validateOutputSafe(cleanText, "thinking-intercept");
      this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_start" });
      this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
      const r = await this.executeInterceptedToolCall(intercepted, reasoningContent);
      if (this.emitter._confirmPending) { delete this.emitter._confirmPending; return ""; }
      return r;
    }
    if (toolCalls.length > 0) { this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage }); await this.executeToolCalls(toolCalls, cleanText, reasoningContent); if (this.emitter._confirmPending) { delete this.emitter._confirmPending; return ""; } return null; }
    if (!cleanText.trim()) {
      const fallback = "*(The model finished thinking but produced no response. Please try again or simplify your request.)*";
      this.emitter.send({ type: "reasoning_done" });
      this.emitter.send({ type: "token", text: fallback });
      this.emitter.send({ type: "stream_end", text: fallback, usage: this.streamUsage });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: fallback }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
      return fallback;
    }
    const validated = validateOutputSafe(cleanText, "thinking-final");
    this.emitter.send({ type: "reasoning_done" }); this.emitter.send({ type: "stream_end", text: validated, usage: this.streamUsage });
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
  async executeNonThinkingResponse(cleanText, toolCalls, streamHandler, reasoningContent = null) {
    if (toolCalls.length > 0) { this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage }); await this.executeToolCalls(toolCalls, cleanText, reasoningContent); if (this.emitter._confirmPending) { delete this.emitter._confirmPending; return ""; } return null; }
    if (cleanText.trim()) { const intercepted = extractTextToolCall(cleanText, this.messages); if (intercepted) { streamHandler.tokenBuffer = ""; const r = await this.executeInterceptedToolCall(intercepted, reasoningContent); if (this.emitter._confirmPending) { delete this.emitter._confirmPending; return ""; } return r; } }
    streamHandler.flushRemainingTokenBuffer();
    if (!cleanText.trim()) {
      const fallback = "*(The model produced no response. Please try again or simplify your request.)*";
      this.emitter.send({ type: "token", text: fallback });
      this.emitter.send({ type: "stream_end", text: fallback, usage: this.streamUsage });
      this.messages.push({ role: "assistant", content: [{ type: "text", text: fallback }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
      return fallback;
    }
    this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage });
    const validated = validateOutputSafe(cleanText, "non-thinking-final");
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
}
