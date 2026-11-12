// src/chat/turn-runner.js - one chat turn: recall → assemble → tool loop →
// turn_complete (spec S2.14 §2.1). The eval adapter and the server both call
// this; it is the only copy of the turn wiring (no second path to drift).
//
// Moved out of src/eval/v2-live-adapter.js (S2.13) with no change to the bytes
// on the wire: tests/fixtures/turn-wire-golden.json is the bar.
// The budget is planned once per runner from the n_ctx the server reports
// (L-M08). A conversation is plain data: { history, recallSession }. No module state.

import { makeToolCtx, runToolLoop } from '../tools/tool-loop.js';
import { buildRecallBlock, createRecallSession, estimateTokens } from '../context/recall-block.js';
import { assembleUserTurn } from '../context/assemble-turn.js';
import { planBudget } from '../context/turn-budget.js';

/** @typedef {{ history: object[], recallSession: ReturnType<typeof createRecallSession> }} Conversation */
/** @typedef {'completed' | 'aborted' | 'error'} TurnStatus */

/**
 * @param {{ store: any, embedder: any, provider: { toolsJson: string, streamChat: Function },
 *   system: string, tools: readonly { name: string, run: Function }[], config: Record<string, any>,
 *   nCtx: number, autoRecall?: boolean, log: { error: Function, warn?: Function, info?: Function } }} opts
 */
export function createTurnRunner({ store, embedder, provider, system, tools, config, nCtx, autoRecall = true, log }) {
  // A window that cannot hold the prefix fails here, once (window_too_small).
  const plan = planBudget({
    nCtx, prefixTokens: estimateTokens(provider.toolsJson + system),
    outputReserve: config.CONTEXT_OUTPUT_RESERVE, toolResultPct: config.CONTEXT_TOOL_RESULT_PCT, recallBudget: config.RECALL_TOKEN_BUDGET,
  });
  const budget = Object.freeze({ usable: plan.usable, toolResultMax: plan.toolResultMax, trimAtPct: config.CONTEXT_TRIM_AT_PCT, trimToPct: config.CONTEXT_TRIM_TO_PCT });
  const recallConfig = { ...config, RECALL_TOKEN_BUDGET: plan.recallMax };

  /** @returns {Conversation} */
  function newConversation() {
    return { history: [], recallSession: createRecallSession() };
  }

  /**
   * Every turn ends in exactly one turn_complete, emitted here.
   * @param {Conversation} conv @param {string} text
   * @param {{ emit: (e: { type: string, [k: string]: unknown }) => void, signal?: AbortSignal }} io
   */
  async function runTurn(conv, text, { emit, signal }) {
    let rec = { block: null };
    if (autoRecall) {
      rec = await buildRecallBlock({ store, embedder, text, session: conv.recallSession, config: recallConfig, emit, log });
      if (rec.block) emit({ type: 'recall_injected', rows: rec.rows, tokens: rec.tokens, ms: rec.ms });
    }
    const userTurn = assembleUserTurn({ recallBlock: rec.block, text });
    conv.history.push({ role: 'user', content: userTurn });
    const ctx = makeToolCtx({ store, embedder, config, log });
    const r = await runToolLoop({ provider, system, history: conv.history, tools, ctx, emit, log, budget, signal });
    /** @type {TurnStatus} */
    const status = r.error ? 'error' : r.aborted ? 'aborted' : 'completed';
    emit({ type: 'turn_complete', status });
    return { text: r.text, status, userTurn, prefixHash: r.prefixHash, timings: r.timings, usage: r.usage };
  }

  return Object.freeze({ newConversation, runTurn });
}
