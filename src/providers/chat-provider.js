// src/providers/chat-provider.js - one streamed model call to llama-server,
// with the provider-level retries (spec S2.5, adapter behaviour 1-8).
//
// Ported in spirit from v1 lib/agent/providers/llamacpp.js at archive/v1-final:
// empty-completion retry with thinking off, leak / echo / corrupt-name retract
// + one retry, streamed and HTTP errors reported verbatim.
// Changed (A2, L-M03/L-M04): the tools are serialized ONCE at creation and sent
// as those exact bytes; the system message is never edited. A retry nudge is a
// trailing user message after history. Nothing here pops a tool or trims history.
// Bad tool JSON is `bad_tool_json`, never `{}` (decision 4).
// Not here (decision 2): the multi-step tool loop, repeat breaker, step cap (S2.8).
// No module state: every createChatProvider() owns its own snapshot.

import { createHash } from 'node:crypto';
import { readSseStream } from './sse-stream.js';
import {
  parseToolArgs, extractTextToolCall, detectToolCallLeak, recoverToolName, looksLikeSystemPromptEcho,
} from './tool-calls.js';

export const EMPTY_FALLBACK = '(The model gave no answer. Please try again.)';
export const LEAK_FALLBACK = '(The model did not give a usable answer. Please try again.)';

const NUDGE = Object.freeze({
  empty: 'Please answer my last message directly.',
  leak: 'Your last reply wrote a tool call as text. Use a real tool call, or answer in plain words.',
  echo: 'Please answer my last message in your own words.',
});

/** One retry each (spec §2 limits). */
const MAX_RETRIES = 1;

/**
 * @typedef {{ name: string, description?: string, parameters?: object }} ToolDef
 * @typedef {{ id: string, name: string, args?: Record<string, unknown>, error?: 'bad_tool_json', raw?: string, message?: string }} ToolCall
 * @typedef {{ kind: string, message: string, status?: number }} CallError
 * @typedef {{ type: string, [k: string]: unknown }} ProviderEvent
 */

/**
 * @param {{ baseURL: string, tools: readonly ToolDef[], capabilities: { tools: boolean, thinking: boolean },
 *   fetch?: typeof fetch, log?: { error: Function, warn: Function, info: Function },
 *   idleTimeoutMs?: number, thinkingTimeoutMs?: number }} opts
 */
export function createChatProvider({ baseURL, tools, capabilities, fetch: fetchImpl = globalThis.fetch, log = console, idleTimeoutMs, thinkingTimeoutMs }) {
  if (typeof baseURL !== 'string' || !baseURL) throw new TypeError('baseURL: is required');
  const url = `${baseURL.replace(/\/+$/, '')}/v1/chat/completions`;
  // The snapshot: serialized once, reused as the same string on every request.
  const toolsJson = JSON.stringify((tools ?? []).map((t) => ({ type: 'function', function: t })));
  const toolNames = Object.freeze(JSON.parse(toolsJson).map((t) => t.function.name));
  const sendTools = capabilities?.tools !== false && toolNames.length > 0;

  /** @param {object[]} messages @param {boolean} thinkingOff */
  function body(messages, thinkingOff) {
    const head = { messages, stream: true, stream_options: { include_usage: true } };
    if (thinkingOff) head.chat_template_kwargs = { enable_thinking: false };
    const json = JSON.stringify(head);
    return sendTools ? `${json.slice(0, -1)},"tools":${toolsJson}}` : json;
  }

  /**
   * @param {{ system: string, messages: object[], emit?: (e: ProviderEvent) => void,
   *   signal?: AbortSignal, thinking?: boolean }} req
   */
  async function streamChat({ system, messages, emit = () => {}, signal, thinking }) {
    const prefixHash = createHash('sha1').update(toolsJson + system).digest('hex');
    const base = [{ role: 'system', content: system }, ...messages];
    const retries = { empty: 0, leak: 0, echo: 0 };
    let nudge = null;
    let thinkingOff = thinking === false;
    let last = { usage: null, timings: null, reasoning: null };

    const done = (fields) => {
      const result = {
        text: '', toolCalls: [], error: null, aborted: false, prefixHash, retries,
        usage: last.usage, timings: last.timings, reasoning: last.reasoning, ...fields,
      };
      if (result.error) {
        log.error(`chat-provider: ${result.error.kind}: ${result.error.message}`);
        emit({ type: 'error', kind: result.error.kind, message: result.error.message });
      }
      emit({ type: 'stream_end', text: result.text, toolCalls: result.toolCalls, aborted: result.aborted });
      return result;
    };
    const aborted = () => done({ aborted: true });
    /** @param {'empty' | 'leak' | 'echo'} kind */
    const canRetry = (kind) => {
      if (retries[kind] >= MAX_RETRIES) return false;
      retries[kind]++;
      nudge = { role: 'user', content: NUDGE[kind] };
      thinkingOff = true;
      return true;
    };

    for (;;) {
      if (signal?.aborted) return aborted();
      emit({ type: 'stream_start' });
      const wire = nudge ? [...base, nudge] : base;

      let res;
      try {
        res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(wire, thinkingOff), signal });
      } catch (err) {
        if (signal?.aborted) return aborted();
        const code = err?.cause?.code ?? err?.code ?? '';
        return done({ text: LEAK_FALLBACK, error: { kind: 'unreachable', message: `llama-server at ${baseURL} is not reachable (${code || err.message})` } });
      }
      if (!res.ok) return done({ text: LEAK_FALLBACK, error: await httpError(res) });

      const r = await readSseStream(res, { emit, signal, idleTimeoutMs, thinkingTimeoutMs });
      last = { usage: r.usage, timings: r.timings, reasoning: r.reasoning };
      if (r.aborted) return aborted();
      if (r.streamError) return done({ text: r.text || LEAK_FALLBACK, error: { kind: 'stream', message: r.streamError } });

      // 1. Native tool calls.
      if (r.toolCalls.length) {
        const calls = [];
        let corrupt = null;
        for (const tc of r.toolCalls) {
          const name = recoverToolName(tc.name, toolNames);
          if (!name) { corrupt = tc.name; break; }
          calls.push(toCall(tc.id || `call_${tc.index}`, name, parseToolArgs(tc.args), emit));
        }
        if (corrupt === null) return done({ text: r.text, toolCalls: calls });
        emit({ type: 'retract', reason: 'corrupt_tool_name' });
        if (canRetry('leak')) continue;
        return done({ text: LEAK_FALLBACK, error: { kind: 'corrupt_tool_name', message: `the model called an unknown tool: ${JSON.stringify(corrupt)}` } });
      }

      // 2. Empty (or cut off while thinking).
      if (r.thinkingTimedOut || !r.text.trim()) {
        if (canRetry('empty')) continue;
        return done({ text: EMPTY_FALLBACK, error: { kind: 'empty', message: 'the model gave an empty answer twice' } });
      }

      // 3. A call leaked into text, in a shape we can read.
      const textCall = extractTextToolCall(r.text, toolNames);
      if (textCall) {
        emit({ type: 'retract', reason: 'text_tool_call' });
        const parsed = 'error' in textCall
          ? { ok: false, error: textCall.error, raw: textCall.raw, message: textCall.message }
          : { ok: true, args: textCall.input };
        return done({ text: textCall.trailing, toolCalls: [toCall('call_text_0', textCall.name, parsed, emit)] });
      }

      // 4. A leak we cannot read, or a recited system prompt.
      const kind = detectToolCallLeak(r.text, toolNames) ? 'leak' : looksLikeSystemPromptEcho(r.text, system) ? 'echo' : null;
      if (kind) {
        emit({ type: 'retract', reason: kind });
        if (canRetry(kind)) continue;
        const message = kind === 'leak' ? 'the model wrote a tool call as text twice' : 'the model recited its instructions twice';
        return done({ text: LEAK_FALLBACK, error: { kind: kind === 'leak' ? 'tool_call_leak' : 'echo', message } });
      }

      return done({ text: r.text });
    }
  }

  return Object.freeze({ toolsJson, toolNames, streamChat });
}

/**
 * @param {string} id @param {string} name
 * @param {{ ok: boolean, args?: Record<string, unknown>, error?: string, raw?: string, message?: string }} parsed
 * @param {(e: ProviderEvent) => void} emit
 * @returns {ToolCall}
 */
function toCall(id, name, parsed, emit) {
  if (parsed.ok) return { id, name, args: parsed.args };
  emit({ type: 'tool_args_invalid', id, name, raw: parsed.raw, message: parsed.message });
  return { id, name, error: 'bad_tool_json', raw: parsed.raw, message: parsed.message };
}

/** @param {Response} res @returns {Promise<CallError>} */
async function httpError(res) {
  let detail;
  try {
    const text = await res.text();
    try { detail = JSON.parse(text)?.error?.message ?? text; } catch { detail = text; } // not JSON: keep the raw body
  } catch (err) {
    detail = `(body unreadable: ${err.message})`;
  }
  const kind = res.status === 503 ? 'loading' : 'http';
  const message = kind === 'loading'
    ? `llama-server is still loading the model (HTTP 503${detail ? `: ${detail}` : ''})`
    : `llama-server returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
  return { kind, message, status: res.status };
}
