import { validateOutputSafe } from "../helpers/validateOutput.js";
import logger from "../helpers/logger.js";

const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, thinking_tokens: 0 });

// Tools that touch disk, memory, or external state. For these, we refuse to
// "repair" malformed JSON args — the regex repair below can succeed in
// producing parseable JSON while silently shifting string boundaries, which
// for edit_file/write_file means a corrupted file lands on disk. Better to
// hand the model a parse error and let it retry with valid JSON.
export const DESTRUCTIVE_TOOLS = new Set([
  "write_file", "edit_file", "append_file", "generate_xlsx", "generate_docx", "run_node_script",
  "run_python_script", "run_shell", "wiki_write", "remember", "update_memory", "forget",
  "backfill_embeddings", "deduplicate_memories", "delete_file", "db_execute",
]);

// The effective destructive-tool set: the built-in baseline above (a non-removable
// floor) plus any extra tool names the user listed in APERIO_EXTRA_DESTRUCTIVE_TOOLS
// (e.g. their own MCP tools). Read lazily so DB-stored config injected into
// process.env at boot is picked up. Built-ins can't be removed here — weakening
// the corruption guard on file/db tools is never a config away.
export function getDestructiveTools() {
  const extra = (process.env.APERIO_EXTRA_DESTRUCTIVE_TOOLS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  return extra.length ? new Set([...DESTRUCTIVE_TOOLS, ...extra]) : DESTRUCTIVE_TOOLS;
}

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

// Quote bare (unquoted) object keys so JSON.parse accepts them: local models
// routinely emit JS-object-literal shape ({issue_url: "…"}) instead of strict
// JSON ({"issue_url": "…"}). Without this, JSON.parse throws on the very first
// bare key and the whole args object is silently dropped to {} — the tool call
// still dispatches (with none of the model's actual arguments), producing a
// confusing "missing required param" error instead of the real problem (wrong
// param name). String contents are left untouched; only identifiers outside
// quotes and immediately followed by ":" are rewritten.
function quoteBareKeys(s) {
  let out = "", inStr = false, esc = false, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    const idMatch = /^[a-zA-Z_$][\w$]*/.exec(s.slice(i));
    if (idMatch) {
      const after = s.slice(i + idMatch[0].length);
      const ws = /^\s*/.exec(after)[0];
      if (after[ws.length] === ":") {
        out += `"${idMatch[0]}"`;
        i += idMatch[0].length;
        continue;
      }
    }
    out += c; i++;
  }
  return out;
}

// Parse Python-kwarg-style call args — name(key='val', key2="val2", key3=3) —
// into a plain object. Splits on top-level commas (honoring quotes and nested
// brackets so a comma inside a string or array value doesn't split early),
// then each `key=value` pair has its value coerced: quoted → string,
// true/false/None/null → the JS equivalent, numeric → Number, otherwise a
// best-effort JSON.parse with the raw text as fallback.
function parseKwargs(s) {
  const pairs = [];
  let buf = "", inStr = null, esc = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      buf += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === ")" || c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "," && depth === 0) { pairs.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) pairs.push(buf);

  const args = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    let val = pair.slice(eq + 1).trim();
    if (!/^[a-zA-Z_]\w*$/.test(key)) continue;
    if (val.length >= 2 && ((val[0] === '"' && val[val.length - 1] === '"') || (val[0] === "'" && val[val.length - 1] === "'"))) {
      val = val.slice(1, -1);
    } else if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val === "None" || val === "null") val = null;
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    else { try { val = JSON.parse(val); } catch { /* keep as raw string */ } }
    args[key] = val;
  }
  return args;
}

// Ornith-family models emit tool calls as bracket ("bbcode") markup rather than
// a JSON object or a native tool_calls array:
//
//   [tool_call](fetch_github_issue) [url]https://…/issues/49[/url][repo]aperio[/repo]
//
// Ollama's `ornith` renderer normally converts this into a real tool_calls array,
// but under load it intermittently leaks the raw markup into the answer text —
// where, unrecovered, it renders as dead text while the model believes it ran the
// tool. Recover the tool name and its [key]value[/key] arguments so the call can
// be dispatched like any other. Values that look like JSON arrays/objects are
// parsed; everything else (URLs, plain strings) is kept as a trimmed string.
export function extractBracketToolCall(text) {
  if (!text) return null;
  const head = text.match(/\[tool_call\]\(\s*([a-zA-Z_][\w-]*)\s*\)/);
  if (!head) return null;
  const rest = text.slice(head.index + head[0].length);
  const input = {};
  let lastEnd = 0;
  const argRe = /\[([a-zA-Z_][\w-]*)\]([\s\S]*?)\[\/\1\]/g;
  let m;
  while ((m = argRe.exec(rest)) !== null) {
    const raw = m[2].trim();
    let val = raw;
    if (/^[[{]/.test(raw)) { try { val = JSON.parse(raw); } catch { /* keep string */ } }
    input[m[1]] = val;
    lastEnd = m.index + m[0].length;
  }
  const trailing = rest.slice(lastEnd).replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
  return { name: head[1], input, trailing };
}

export function extractTextToolCall(text, messages) {
  const bracket = extractBracketToolCall(text);
  if (bracket) return bracket;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const searchIn = fenceMatch ? fenceMatch[1].trim() : text;
  // Scan each "{" for the first brace-balanced object that parses and carries a
  // string tool-name. The previous non-greedy regex stopped at the first "}", which
  // truncated any object whose params object closed before the outer brace —
  // i.e. the common name-first { "name": …, "parameters": { … } } shape that
  // local models emit, so those calls were silently dropped as plain text.
  //
  // The name may live under "name" or, for models parroting the OpenAI wire
  // format in prose, "call"/"tool"/"function"; params under parameters/input/
  // arguments/args. We do NOT coerce arg shapes (e.g. a scalar the model wrapped
  // in a one-element array) — a wrong-typed arg is left to the tool's schema
  // validation and the retry/nudge loop rather than silently reshaped here.
  for (let i = searchIn.indexOf("{"); i !== -1; i = searchIn.indexOf("{", i + 1)) {
    const end = matchBrace(searchIn, i);
    if (end === -1) continue;
    const candidate = searchIn.slice(i, end);
    if (!/"(?:name|call|tool|function|tool_name)"\s*:\s*"[^"]+"/.test(candidate)) continue;
    let parsed;
    try { parsed = JSON.parse(quoteBareKeys(stripJsonComments(candidate))); } catch { continue; }
    const name = [parsed.name, parsed.call, parsed.tool, parsed.function, parsed.tool_name].find(v => typeof v === "string" && v);
    if (!name) continue;
    const params = parsed.parameters ?? parsed.input ?? parsed.arguments ?? parsed.args ?? parsed.params ?? {};
    const cleaned = Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null"));
    let trailing = fenceMatch
      ? text.slice(text.indexOf(fenceMatch[0]) + fenceMatch[0].length).trim()
      : text.slice(text.indexOf(candidate) + candidate.length).trim();
    trailing = trailing.replace(/^[-–—\s]*(?:Response|Result|Answer|Output)\s*:\s*/i, "").trim();
    return { name, input: cleaned, trailing };
  }
  // Fallback: recover call:name{json} / call:name(key=val) from text (Gemma/Qwen-style)
  const callMatch = searchIn.match(/(?:call:\s*)?([a-zA-Z_][\w.\-]*)\s*\{([\s\S]*?)\}\s*$/);
  if (callMatch) {
    let rawName = callMatch[1];
    // Strip namespace prefix (e.g. "memory-protocol.recall" → "recall")
    const parts = rawName.split(".");
    const toolName = parts[parts.length - 1];
    let rawArgs;
    try { rawArgs = JSON.parse(quoteBareKeys(stripJsonComments("{" + callMatch[2] + "}"))); }
    catch { rawArgs = {}; }
    if (typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
      const cleaned = Object.fromEntries(Object.entries(rawArgs).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null"));
      return { name: toolName, input: cleaned, trailing: "" };
    }
  }
  // Fallback: recover call:name(key='val', key2="val2") Python-kwarg-style
  // calls — common when code-trained local models (Qwen/DeepSeek-Coder
  // family) hallucinate a function-call rendering instead of the tool schema,
  // e.g. "call: fetch_github_issue(issue_url='https://…')".
  const kwargMatch = searchIn.match(/(?:call:\s*)?([a-zA-Z_][\w.\-]*)\s*\(([\s\S]*?)\)\s*$/);
  if (kwargMatch) {
    const parts = kwargMatch[1].split(".");
    const toolName = parts[parts.length - 1];
    const rawArgs = parseKwargs(kwargMatch[2]);
    const cleaned = Object.fromEntries(Object.entries(rawArgs).filter(([, v]) => v != null && v !== "" && v !== "None" && v !== "null"));
    return { name: toolName, input: cleaned, trailing: "" };
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
  /\[tool_call\]\s*\(/i,            // Ornith bbcode: [tool_call](name) [key]val[/key]
  /<\|\s*tool_call\s*\|?>/i,        // Qwen-style: <|tool_call|>call:name{…} — the closing pipe is
                                     // sometimes dropped by the model, so it's optional here too
  /\bcall\s*\(\s*['"]?[a-zA-Z_]/,   // call(recall, …)  /  call("recall", …)
  /\bcall\s*:\s*\w+\s*[{(]/i,       // Gemma/Qwen-style: call:recall{…} or call:recall(…)
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
    const names = toolNames.map(escapeRe).join("|");
    // Function-call form printed as text: recall(query="…")
    if (new RegExp(`\\b(?:${names})\\s*\\(\\s*[a-zA-Z_]+\\s*=`, "i").test(text)) return true;
    // OpenAI wire-format leak: a weaker model parrots the tool_calls JSON as prose
    // with the tool name under a name/call/tool/function key, e.g.
    // {"call": "fetch_github_issue", "args": {…}}. Bounded on a REAL tool name as
    // the value so ordinary JSON output never false-positives. When the JSON is
    // well-formed, extractTextToolCall recovers it (so the leak branch is skipped);
    // this is the safety net that fires the retract/nudge/retry when it is not.
    if (new RegExp(`"(?:name|call|tool|function)"\\s*:\\s*"(?:${names})"`, "i").test(text)) return true;
    // Bare known-tool line: some weak models emit only the native name, then
    // continue with a second prose-form call (observed: "run_shell" followed
    // by "fetch_url https://…"). Restrict this to the leading line and an
    // exact registered tool name so ordinary snake_case prose is not guessed
    // to be a call.
    const bareKnownTool = new RegExp(`^\\s*\`?(?:${names})\`?\\s*(?:\\r?\\n|$)`, "i");
    if (bareKnownTool.test(text)) return true;
    // Narrated call: the model announces it is calling a known tool by name but
    // never emits a native tool_calls array (gemma e4b: "Calling
    // `fetch_github_issue` for https://…"), then waits forever for a result that
    // never comes. Anchored on a REAL tool name plus an action signal that the
    // call is happening now — a clause-initial gerund ("Calling X"), or a
    // first-person intent ("I'll call X", "Let me use X"). Deliberately excludes
    // second-person advice ("you can call X") and past tense ("I called X",
    // reporting a completed call) so plain chat and post-call summaries pass.
    const gerund = new RegExp(`(?:^|[.!?)\\]\\n]\\s*)(?:calling|invoking|running|executing)\\s+(?:the\\s+)?\`?(?:${names})\`?\\b`, "i");
    if (gerund.test(text)) return true;
    const verb = "call|calling|invoke|invoking|use|using|run|running|execute|executing";
    const intent = new RegExp(`\\b(?:i['’]?ll|i\\s+will|i['’]?m|i\\s+am|i\\s+need\\s+to|let\\s+me|let['’]?s)\\s+(?:now\\s+)?(?:${verb})\\s+(?:the\\s+)?\`?(?:${names})\`?\\b`, "i");
    if (intent.test(text)) return true;
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

// A degenerate failure mode distinct from tool-call leakage: instead of
// answering (or issuing a tool call), the model regurgitates a large verbatim
// chunk of its own system prompt — persona text, tool docs, skill instructions
// — as if that were the answer. Observed after a confused retry: a garbled
// tool-call leak triggered a nudge, and the retry degenerated into reciting
// id/whoami.md instead of looking at the actual GitHub issue. Left unguarded
// this silently discloses the app's internal instructions to the user.
//
// Detected cheaply without a full diff: sample fixed-size chunks of cleanText
// and check what fraction appear verbatim in the system prompt. A genuine
// answer about the user's topic shares almost none of these chunks; a
// recited prompt shares nearly all of them.
export function looksLikeSystemPromptEcho(cleanText, systemPrompt, { chunkSize = 60, minChunks = 3, matchRatio = 0.5 } = {}) {
  if (!cleanText || !systemPrompt || cleanText.length < chunkSize * minChunks) return false;
  let total = 0, hits = 0;
  for (let i = 0; i + chunkSize <= cleanText.length; i += chunkSize) {
    total++;
    if (systemPrompt.includes(cleanText.slice(i, i + chunkSize))) hits++;
  }
  return total >= minChunks && hits / total >= matchRatio;
}

// Order-independent JSON key: two arg objects that differ only in key order (or
// nested key order) hash the same, so "same call, keys shuffled" still dedups.
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
}

// A real user turn (text), not a tool_result message or the synthetic greeting.
function isRealUserMsg(m) {
  return m?.role === "user" && (typeof m.content === "string" || (Array.isArray(m.content) && m.content.some(b => b?.type === "text")));
}

// Loop-breaker: on a tiny context window, trimming evicts the freshest
// tool_use/tool_result pair, so the model — no longer seeing what it just
// fetched — re-issues the identical call and spins (observed: fetch_github_issue
// called 3×, same URL). The persistent `messages` array still holds the prior
// result even after the wire copy was trimmed, so we find that result and hand
// it back instead of re-running the tool. Scoped to the CURRENT turn (after the
// last real user message) so a legitimate re-ask in a later turn still re-runs.
// Returns the prior result string, or null when there's no in-turn duplicate.
export function findPriorToolResult(messages, name, args) {
  const sig = stableStringify(args ?? {});
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) { if (isRealUserMsg(messages[i])) { start = i + 1; break; } }
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b?.type === "tool_use" && b.name === name && stableStringify(b.input ?? {}) === sig) {
        for (const r of messages) {
          if (!Array.isArray(r.content)) continue;
          for (const rb of r.content) {
            if (rb?.type === "tool_result" && rb.tool_use_id === b.id && typeof rb.content === "string") return rb.content;
          }
        }
      }
    }
  }
  return null;
}

// Wrap a reused prior result with a nudge so the model stops repeating the call
// and answers from it. Shared by the native and text-intercepted tool paths so
// the two never drift.
function reuseNote(name, cached) {
  return `⚠️ You already called \`${name}\` with identical arguments earlier in this turn, so it was NOT run again. Here is the result from before — use it to answer now; do not call \`${name}\` again.\n\n${cached}`;
}

// Shared across every provider loop (deepseek/llamacpp via ToolExecutor below,
// anthropic/gemini directly) so the empty-completion bubble can't drift into
// per-provider copies — WS5/E2.
export const EMPTY_RESPONSE_FALLBACK = "*(The model produced no response. Please try again or simplify your request.)*";

export function emitEmptyResponseFallback(emitter, messages, usage, reasoningContent = null) {
  emitter.send({ type: "token", text: EMPTY_RESPONSE_FALLBACK });
  emitter.send({ type: "stream_end", text: EMPTY_RESPONSE_FALLBACK, usage });
  messages.push({ role: "assistant", content: [{ type: "text", text: EMPTY_RESPONSE_FALLBACK }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
  return EMPTY_RESPONSE_FALLBACK;
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
    const cachedByTc = new Map();
    for (const tc of toolCalls) {
      const parsed = this.parseArgs(tc.args, tc.name);
      parsedByTc.set(tc.id, parsed);
      // Detect before pushing `msg` so the current call can't match itself.
      cachedByTc.set(tc.id, findPriorToolResult(this.messages, tc.name, parsed));
      msg.content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parsed });
    }
    this.messages.push(msg);
    const results = [];
    for (const tc of toolCalls) {
      // Surface each tool call to the UI so the user sees what the agent is
      // doing during the otherwise-silent execution window (e.g. write_file →
      // run_node_script → verify on a pptx build). Without this the frontend
      // falls back to an idle "connected" state and looks frozen. Anthropic
      // emits this from its own stream; deepseek/llamacpp route through here.
      this.emitter.send({ type: "tool", name: tc.name });
      const cached = cachedByTc.get(tc.id);
      let content;
      if (cached != null) {
        logger.warn(`[executor] duplicate tool call "${tc.name}" (identical args, same turn) — reusing prior result, not re-executing`);
        content = reuseNote(tc.name, cached);
      } else {
        content = await this.callTool(tc.name, parsedByTc.get(tc.id));
      }
      results.push({ type: "tool_result", tool_use_id: tc.id, content });
    }
    this.messages.push({ role: "tool", content: results }); return true;
  }
  async executeInterceptedToolCall(intercepted, reasoningContent = null) {
    if (!intercepted) return false;
    this.emitter.send({ type: "retract" }); this.emitter.send({ type: "tool", name: intercepted.name });
    // Same loop-breaker as executeToolCalls: if this exact call already ran this
    // turn, hand back the prior result instead of re-executing (detect before the
    // push below so it can't match itself).
    const cached = findPriorToolResult(this.messages, intercepted.name, intercepted.input);
    let result;
    if (cached != null) {
      logger.warn(`[executor] duplicate intercepted tool call "${intercepted.name}" (identical args, same turn) — reusing prior result, not re-executing`);
      result = reuseNote(intercepted.name, cached);
    } else {
      result = await this.callTool(intercepted.name, intercepted.input);
    }
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
      if (getDestructiveTools().has(toolName)) {
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
      return emitEmptyResponseFallback(this.emitter, this.messages, this.streamUsage, reasoningContent);
    }
    this.emitter.send({ type: "stream_end", text: "", usage: this.streamUsage });
    const validated = validateOutputSafe(cleanText, "non-thinking-final");
    this.messages.push({ role: "assistant", content: [{ type: "text", text: validated }], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
    return validated;
  }
}
