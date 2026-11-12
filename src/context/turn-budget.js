// src/context/turn-budget.js - the one budget function (spec S2.13 §2; plan TR14,
// Appendix A1 items 1-2, A2).
//
// Pure: no config read, no I/O, no state. The caller passes the server's n_ctx
// (launcher servedCtx, L-M08) and the config marks.
// - A tool result is cut ONCE, when stored (head + tail + one mark line), so the
//   bytes in history never change after that.
// - History is cut by WHOLE turns (a user message and all that follows it), so a
//   tool result can never lose its call (A1 item 2): no second pass.
// - Two marks (hysteresis): nothing changes below TRIM_AT, so each request is the
//   last one plus a new tail (full KV reuse, L-M22). At TRIM_AT the oldest turns
//   go until history is at most TRIM_TO: few, big cuts.
// - The current turn is never dropped. If it alone does not fit: context_full.

import { estimateTokens } from './recall-block.js';

export class BudgetError extends Error {
  /** @param {'window_too_small' | 'context_full'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

const TRUNC_MARK = '\n[... truncated to fit context ...]\n';

/** Tokens one stored message costs: its text plus its tool calls, if any. */
export function messageTokens(msg) {
  const calls = msg.tool_calls?.length ? estimateTokens(JSON.stringify(msg.tool_calls)) : 0;
  return estimateTokens(msg.content ?? '') + calls;
}

/** @param {object[]} history */
export const historyTokens = (history) => history.reduce((sum, m) => sum + messageTokens(m), 0);

/**
 * @param {{ nCtx: number, prefixTokens: number, outputReserve: number, toolResultPct: number, recallBudget: number }} args
 * @returns {{ usable: number, toolResultMax: number, recallMax: number }}
 */
export function planBudget({ nCtx, prefixTokens, outputReserve, toolResultPct, recallBudget }) {
  const usable = nCtx - prefixTokens - outputReserve;
  if (!(usable > 0)) {
    throw new BudgetError('window_too_small',
      `The context window (${nCtx} tokens) cannot hold the tools and system prompt (${prefixTokens}) plus the answer reserve (${outputReserve}).`);
  }
  return {
    usable,
    toolResultMax: Math.floor((usable * toolResultPct) / 100),
    recallMax: Math.min(recallBudget, Math.floor(usable / 10)),
  };
}

/**
 * Head + tail of a too-big tool result (the verdict is often at the end). Same string when it fits.
 * @param {string} text @param {number} maxTokens
 */
export function capToolResult(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return text;
  const room = Math.max(0, maxTokens * 3 - TRUNC_MARK.length); // estimateTokens = ceil(chars / 3)
  const head = Math.ceil(room / 2);
  return text.slice(0, head) + TRUNC_MARK + text.slice(text.length - (room - head));
}

/**
 * Drop the oldest whole turns when history reaches trimAtPct of usable, down to trimToPct.
 * Returns the same array when nothing is dropped. The caller replaces its stored history.
 * @param {object[]} history
 * @param {{ usable: number, trimAtPct: number, trimToPct: number }} marks
 * @returns {{ history: object[], dropped: number, pct: number, trimmed: boolean }}
 */
export function fitHistory(history, { usable, trimAtPct, trimToPct }) {
  let total = historyTokens(history);
  const pct = Math.round((100 * total) / usable);
  if (total * 100 < usable * trimAtPct) return { history, dropped: 0, pct, trimmed: false };

  const current = Math.max(0, history.findLastIndex((m) => m.role === 'user'));
  let cut = 0;
  for (let i = 0; i < current && total * 100 > usable * trimToPct; ) {
    let next = i + 1; // the end of the turn that starts at i
    while (next < current && history[next].role !== 'user') next++;
    for (let j = i; j < next; j++) total -= messageTokens(history[j]);
    cut = i = next;
  }
  if (total > usable) {
    throw new BudgetError('context_full',
      `This message is too long for the context window (about ${total} tokens, ${usable} available). Please send a shorter one.`);
  }
  if (cut === 0) return { history, dropped: 0, pct, trimmed: false };
  return { history: history.slice(cut), dropped: cut, pct, trimmed: true };
}
