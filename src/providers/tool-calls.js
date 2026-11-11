// src/providers/tool-calls.js - turn model output into tool calls, honestly
// (spec S2.5, adapter behaviour 4-5).
//
// Ported from v1 lib/tools/executor.js at archive/v1-final: the angle-bracket
// and pipe-delimited leak parsers (L-M05), detectToolCallLeak, recoverToolName,
// looksLikeSystemPromptEcho, matchBrace and quoteBareKeys. Parsers are keyed by
// OUTPUT SHAPE and run on every model, never by model name (AP2).
// Changed (decision 4): bad JSON is never repaired and never becomes `{}`. It
// comes back as `{ error: 'bad_tool_json', raw, message }`, so nothing can run
// a tool with arguments the model did not send.
// Dropped: the bbcode / wire-format / kwarg extractors and the JSON comment
// stripper (no measured need in v2; the return gate can bring them back).

/** @typedef {{ name: string, input: Record<string, unknown>, trailing: string }} TextCall */
/** @typedef {{ name: string, error: 'bad_tool_json', raw: string, message: string, trailing: string }} BadTextCall */

const BAD = 'bad_tool_json';

/**
 * Parse native tool-call arguments. Empty = no arguments. Anything else must be
 * a JSON object, byte for byte as the model sent it.
 * @param {string | null | undefined} raw
 * @returns {{ ok: true, args: Record<string, unknown> } | { ok: false, error: 'bad_tool_json', raw: string, message: string }}
 */
export function parseToolArgs(raw) {
  if (raw == null || !String(raw).trim()) return { ok: true, args: {} };
  const s = String(raw);
  let v;
  try {
    v = JSON.parse(s);
  } catch (err) {
    return { ok: false, error: BAD, raw: s, message: `tool arguments are not valid JSON: ${err.message}` };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: BAD, raw: s, message: 'tool arguments must be a JSON object' };
  }
  return { ok: true, args: v };
}

/** Index just past the brace that closes the one at `start`, or -1. Strings are skipped. */
function matchBrace(s, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Quote bare object keys (`{query:"x"}` -> `{"query":"x"}`). This is the pipe
 * shape's own key syntax, not a repair: string contents are never touched.
 * @param {string} s
 */
function quoteBareKeys(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    const id = /^[a-zA-Z_$][\w$]*/.exec(s.slice(i));
    if (id) {
      const after = s.slice(i + id[0].length);
      const ws = /^\s*/.exec(after)[0];
      if (after[ws.length] === ':') {
        out += `"${id[0]}"`;
        i += id[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Angle-bracket leak: `<tool_call> <function=name> <parameter=k> v </parameter> </function> </tool_call>`.
 * A parameter value that looks like JSON and parses becomes that value; any
 * other value stays the string the model wrote.
 * @param {string} text @returns {TextCall | null}
 */
export function extractAngleToolCall(text) {
  if (!text) return null;
  const head = text.match(/<tool_call>\s*<function\s*=\s*([a-zA-Z_][\w-]*)\s*>/i);
  if (!head) return null;
  const rest = text.slice(head.index + head[0].length);
  /** @type {Record<string, unknown>} */
  const input = {};
  let lastEnd = 0;
  const argRe = /<parameter\s*=\s*([a-zA-Z_][\w-]*)\s*>([\s\S]*?)<\/parameter>/gi;
  let m;
  while ((m = argRe.exec(rest)) !== null) {
    const raw = m[2].trim();
    let val = raw;
    if (/^[[{]/.test(raw)) {
      try { val = JSON.parse(raw); } catch { val = raw; } // not JSON: the value is the text as written
    }
    input[m[1]] = val;
    lastEnd = m.index + m[0].length;
  }
  const trailing = rest.slice(lastEnd).replace(/<\/function>\s*<\/tool_call>/i, '').trim();
  return { name: head[1], input, trailing };
}

/**
 * Pipe-delimited leak: `<|tool_call>call:name{key:<|"|>value<|"|>}<tool_call|>`.
 * `<|"|>` is the template's quote marker. A matched call whose body does not
 * parse is `bad_tool_json`, never `{}`.
 * @param {string} text @returns {TextCall | BadTextCall | null}
 */
export function extractPipeAngleToolCall(text) {
  if (!text) return null;
  const normalized = text.replace(/<\|\s*"\s*\|>/g, '"');
  const head = normalized.match(/\bcall\s*:\s*([a-zA-Z_][\w.-]*)\s*\{/);
  if (!head) return null;
  const name = head[1];
  const braceStart = head.index + head[0].length - 1;
  const end = matchBrace(normalized, braceStart);
  const stripTags = (s) => s.replace(/<\s*\|?\s*tool_call\s*\|?\s*>/gi, '').trim();
  if (end === -1) {
    const raw = stripTags(normalized.slice(braceStart));
    return { name, error: BAD, raw, message: 'tool arguments are not valid JSON: the object never closes', trailing: '' };
  }
  const body = normalized.slice(braceStart, end);
  const trailing = stripTags(normalized.slice(end));
  const parsed = parseToolArgs(quoteBareKeys(body));
  if (!parsed.ok) return { name, error: BAD, raw: body, message: parsed.message, trailing };
  return { name, input: parsed.args, trailing };
}

/**
 * A call leaked into text, for a known tool only. An empty tool list matches
 * nothing (no permissive fallback: v1's "US Letter (612 x 792)" bug).
 * @param {string} text @param {readonly string[]} toolNames
 * @returns {TextCall | BadTextCall | null}
 */
export function extractTextToolCall(text, toolNames) {
  if (!text || !toolNames?.length) return null;
  for (const extract of [extractAngleToolCall, extractPipeAngleToolCall]) {
    const call = extract(text);
    if (call && toolNames.includes(call.name)) return call;
  }
  return null;
}

/** Shapes of a tool call written as prose instead of a real call. */
const TOOL_LEAK_PATTERNS = [
  /<\/?\s*(?:execute_tool|tool_call|tool_use|function_call|invoke|tool)\b/i,
  /\[tool_call\]\s*\(/i,
  /<\|\s*tool_call\s*\|?>/i, // the closing pipe is sometimes dropped
  /\bcall\s*\(\s*['"]?[a-zA-Z_]/, // call(recall, ...)
  /\bcall\s*:\s*\w+\s*[{(]/i, // call:recall{...}
  /:\s*call\s*\(/i,
];

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when text looks like a tool call the model wrote instead of issuing.
 * Plain prose, advice ("you can call X"), past tense and unknown tools pass.
 * @param {string} text @param {readonly string[]} [toolNames]
 */
export function detectToolCallLeak(text, toolNames = []) {
  if (!text || !text.trim()) return false;
  if (TOOL_LEAK_PATTERNS.some((re) => re.test(text))) return true;
  if (!toolNames.length) return false;
  const names = toolNames.map(escapeRe).join('|');
  if (new RegExp(`\\b(?:${names})\\s*\\(\\s*[a-zA-Z_]+\\s*=`, 'i').test(text)) return true; // recall(query="x")
  if (new RegExp(`"(?:name|call|tool|function)"\\s*:\\s*"(?:${names})"`, 'i').test(text)) return true; // wire JSON as prose
  if (new RegExp(`^\\s*\`?(?:${names})\`?\\s*(?:\\r?\\n|$)`, 'i').test(text)) return true; // a bare tool name line
  // Narrated call: "Calling `recall` for ..." / "I'll call recall ...".
  const gerund = new RegExp(`(?:^|[.!?)\\]\\n]\\s*)(?:calling|invoking|running|executing)\\s+(?:the\\s+)?\`?(?:${names})\`?\\b`, 'i');
  if (gerund.test(text)) return true;
  const verb = 'call|calling|invoke|invoking|use|using|run|running|execute|executing';
  const intent = new RegExp(`\\b(?:i['’]?ll|i\\s+will|i['’]?m|i\\s+am|i\\s+need\\s+to|let\\s+me|let['’]?s)\\s+(?:now\\s+)?(?:${verb})\\s+(?:the\\s+)?\`?(?:${names})\`?\\b`, 'i');
  return intent.test(text);
}

/**
 * Recover a known tool name from a corrupted native name (channel markup in
 * the name field). Token-bounded; the last match wins (the one after `call:`).
 * @param {string} name @param {readonly string[]} toolNames @returns {string | null}
 */
export function recoverToolName(name, toolNames = []) {
  if (!name) return null;
  if (toolNames.includes(name)) return name;
  let best = null;
  for (const t of toolNames) {
    const re = new RegExp(`(?<![a-zA-Z0-9_])${escapeRe(t)}(?![a-zA-Z0-9_])`, 'g');
    let m;
    while ((m = re.exec(name)) !== null) {
      if (!best || m.index > best.index || (m.index === best.index && t.length > best.name.length)) best = { name: t, index: m.index };
    }
  }
  return best ? best.name : null;
}

/**
 * True when the reply recites the system prompt: most fixed-size chunks of the
 * text appear verbatim in it.
 * @param {string} text @param {string} systemPrompt
 */
export function looksLikeSystemPromptEcho(text, systemPrompt, { chunkSize = 60, minChunks = 3, matchRatio = 0.5 } = {}) {
  if (!text || !systemPrompt || text.length < chunkSize * minChunks) return false;
  let total = 0;
  let hits = 0;
  for (let i = 0; i + chunkSize <= text.length; i += chunkSize) {
    total++;
    if (systemPrompt.includes(text.slice(i, i + chunkSize))) hits++;
  }
  return total >= minChunks && hits / total >= matchRatio;
}
