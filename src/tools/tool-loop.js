// src/tools/tool-loop.js - one turn: ask the model, run the tools it calls
// in-process, feed the results back, until it answers (spec S2.7 rev 3 §2.3).
//
// History is appended in place and never rewritten, so every request extends
// the previous one (KV reuse, L-M22). A tool error is a result the model sees
// (ok: false), never a thrown turn (AP5).

/**
 * The one ctx every tool gets. Fragile zone: its 4 keys are frozen by
 * tests/tools/tools-contract.test.js; extra fields are dropped, not passed on.
 */
export function makeToolCtx({ store, embedder, config, log }) {
  return Object.freeze({ store, embedder, config, log });
}

/** A model that keeps calling tools is cut here; its last calls are not run. */
export const MAX_TOOL_ROUNDS = 4;

/**
 * @param {{ provider: { streamChat: Function }, system: string, history: object[],
 *   tools: readonly { name: string, run: Function }[], ctx: object,
 *   emit: (e: object) => void, log: { error: Function } }} args
 * @returns {Promise<object>} the provider result of the last request
 */
export async function runToolLoop({ provider, system, history, tools, ctx, emit, log }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (let round = 0; ; round++) {
    const r = await provider.streamChat({ system, messages: [...history], emit });
    if (!r.toolCalls.length || r.error || r.aborted || round >= MAX_TOOL_ROUNDS) {
      history.push({ role: 'assistant', content: r.text });
      return r;
    }
    history.push({
      role: 'assistant',
      content: r.text ?? '',
      tool_calls: r.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
    });
    for (const c of r.toolCalls) {
      emit({ type: 'tool_start', id: c.id, name: c.name, arguments: c.args });
      const result = await runOne(byName.get(c.name), c, ctx, log);
      emit({ type: 'tool_result', id: c.id, name: c.name, ok: result.ok !== false });
      history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
    }
  }
}

async function runOne(tool, call, ctx, log) {
  if (call.error) return { ok: false, error: `The arguments were not valid JSON: ${call.message}` };
  if (!tool) return { ok: false, error: `There is no tool named ${call.name}.` };
  try {
    return await tool.run(call.args ?? {}, ctx);
  } catch (err) {
    log.error(`[tools] ${call.name} failed: ${err.message}`);
    return { ok: false, error: `${call.name} failed: ${err.message}` };
  }
}
