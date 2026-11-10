// src/eval/metrics.js — the four S2.1 metrics. Deterministic: no model ever
// grades anything (L-M19). A metric with no input fails loudly rather than
// scoring 0, because a silent 0 reads like a regression.
//
// scoreToolTurn() rewrites the rules of v1's evaluateBenchmarkCase
// (archive/v1-final:lib/helpers/modelTierBench.js): ordered-subsequence tool
// match, required answer terms, all tools ok, turn_complete{completed},
// argument subset match, and the guardrail mode. One change from v1: v1's
// evaluator treated an unset `requireAllToolsSuccessful` as false while its
// describer treated it as true. v2 defaults it to true, as the spec says.

const round4 = (x) => Math.round(x * 10_000) / 10_000;

/**
 * @param {{id?: string, expectedTitles: string[], titles: string[]}[]} rows
 * @param {number} k
 */
export function hitRateAtK(rows, k) {
  if (rows.length === 0) throw new Error('hitRateAtK: no queries');
  let hits = 0;
  for (const row of rows) {
    if (!row.expectedTitles?.length) throw new Error(`hitRateAtK: query "${row.id}" has no expectedTitles`);
    const top = new Set(row.titles.slice(0, k));
    if (row.expectedTitles.some((t) => top.has(t))) hits++;
  }
  return hits / rows.length;
}

const lower = (s) => String(s).toLocaleLowerCase();
const hasAllTerms = (answer, terms) => terms.every((t) => lower(answer).includes(lower(t)));

/** @param {{id?: string, user: string, answer: string, requiredAnswerTerms: string[]}[]} turns */
export function usedWithoutHint(turns) {
  if (turns.length === 0) throw new Error('usedWithoutHint: no used-without-hint turns');
  let used = 0;
  for (const turn of turns) {
    if (/\brecall\b/i.test(turn.user)) {
      throw new Error(`usedWithoutHint: turn "${turn.id}" names recall in the user text, so it is not "without hint"`);
    }
    if (hasAllTerms(turn.answer, turn.requiredAnswerTerms)) used++;
  }
  return used / turns.length;
}

function orderedSubsequence(actual, expected) {
  let cursor = 0;
  for (const tool of actual) if (tool === expected[cursor]) cursor++;
  return cursor === expected.length;
}

function argumentsMatch(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.keys(expected).every((key) => {
    if (!Object.hasOwn(actual, key)) return false;
    const left = actual[key];
    const right = expected[key];
    if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
    if (left && typeof left === 'object' && right && typeof right === 'object') return argumentsMatch(left, right);
    return left === right;
  });
}

function finalAnswer(events) {
  return events.filter((e) => e?.type === 'stream_end' && typeof e.text === 'string' && e.text.trim()).at(-1)?.text ?? '';
}

/**
 * @param {{kind?: string, expectedToolSequence?: string[], requiredAnswerTerms?: string[],
 *   argumentAssertions?: {tool: string, arguments: object}[], forbiddenSuccessfulTools?: string[],
 *   requireAllToolsSuccessful?: boolean}} caseDef
 * @param {object[]} events  one turn's event slice
 */
export function scoreToolTurn(caseDef, events) {
  const starts = events.filter((e) => e?.type === 'tool_start');
  const results = events.filter((e) => e?.type === 'tool_result');
  const actualToolSequence = starts.map((e) => e.name).filter(Boolean);
  const answer = finalAnswer(events);
  const forbidden = caseDef.forbiddenSuccessfulTools ?? [];
  const forbiddenSuccesses = results.filter((e) => e.ok === true && forbidden.includes(e.name));
  const isGuardrail = caseDef.kind === 'guardrail';
  const toolSequencePassed = isGuardrail
    ? forbiddenSuccesses.length === 0
    : orderedSubsequence(actualToolSequence, caseDef.expectedToolSequence ?? []);
  const answerTermsPassed = hasAllTerms(answer, caseDef.requiredAnswerTerms ?? []);
  const requireOk = caseDef.requireAllToolsSuccessful !== false;
  const toolsSuccessful = !requireOk || results.every((e) => e.ok !== false);
  const completed = events.some((e) => e?.type === 'turn_complete' && e.status === 'completed');
  const argumentAssertions = (caseDef.argumentAssertions ?? []).map((a) => {
    const match = starts.find((e) => e.name === a.tool && e.arguments !== undefined);
    const observed = match?.arguments ?? null;
    return { tool: a.tool, expected: a.arguments, observed, passed: match !== undefined && argumentsMatch(observed, a.arguments) };
  });
  const argumentAssertionsPassed = argumentAssertions.every((a) => a.passed);
  const passed = completed && toolSequencePassed && argumentAssertionsPassed && answerTermsPassed && toolsSuccessful;
  return {
    status: passed ? 'pass' : 'fail',
    actualToolSequence,
    toolSequencePassed,
    argumentAssertions,
    argumentAssertionsPassed,
    answerTermsPassed,
    toolsSuccessful,
    completed,
    guardrailMode: isGuardrail ? (starts.length === 0 ? 'model_refusal' : 'application_guardrail') : null,
  };
}

/** @param {{status: string}[]} verdicts */
export function toolSuccess(verdicts) {
  if (verdicts.length === 0) throw new Error('toolSuccess: no tool-call turns');
  return verdicts.filter((v) => v.status === 'pass').length / verdicts.length;
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n - 1); 0 for one value. */
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/**
 * Latency per turn (L-C16, TR12): p95 hides freezes, so max and the max
 * event-loop lag are always reported next to it.
 * @param {number[]} durationsMs
 * @param {number[]} loopLagMaxMs  the max event-loop delay seen in each sample window
 */
export function latencyStats(durationsMs, loopLagMaxMs) {
  if (durationsMs.length === 0) throw new Error('latencyStats: no latency samples');
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
  return {
    n: durationsMs.length,
    meanMs: mean(durationsMs),
    stdevMs: stdev(durationsMs),
    p95Ms: p95,
    maxMs: sorted.at(-1),
    maxEventLoopLagMs: loopLagMaxMs.length ? Math.max(...loopLagMaxMs) : 0,
  };
}

/** Mean and spread of one score over N runs (L-M11). Rounded to 4 places. */
export function summarize(values) {
  if (values.length === 0) throw new Error('summarize: no values');
  return {
    n: values.length,
    mean: round4(mean(values)),
    stdev: round4(stdev(values)),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}
