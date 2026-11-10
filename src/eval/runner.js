// src/eval/runner.js — drives one target over the fixtures N times and turns
// the raw turns into per-split scores (spec S2.1 "Scenario contract", "Runs").
//
// Per run: one fresh target for the recall corpus, then one fresh target per
// scenario. A scenario's store is seeded once; a new session inside it calls
// reset(), which keeps the store and drops the history. Every target start
// gets its own sandbox. Raw events are scored per turn and then dropped
// (AP6): only numbers leave this module.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { assertSession, assertTargetAdapter } from './adapter-contract.js';
import { seedRows } from './fixtures.js';
import { hitRateAtK, latencyStats, scoreToolTurn, summarize, toolSuccess, usedWithoutHint } from './metrics.js';
import { withRunSandbox } from './sandbox.js';

const SPLITS = ['train', 'holdout'];
const SCORED_TYPES = new Set(['stream_start', 'tool_start', 'tool_result', 'stream_end', 'turn_complete']);

/**
 * Send one turn; an empty completion (the gemma quirk) is retried up to
 * maxEmptyRetries times and counted, never hidden.
 */
export async function turnWithRetry(session, text, { maxEmptyRetries, timeoutMs = 0 }) {
  let emptyRetry = 0;
  for (;;) {
    const result = await withTimeout(session.turn(text), timeoutMs, `turn "${text.slice(0, 40)}"`);
    const empty = !String(result.text ?? '').trim();
    if (!empty) return { ...result, emptyRetry, empty: false };
    if (emptyRetry >= maxEmptyRetries) return { ...result, emptyRetry, empty: true };
    emptyRetry++;
  }
}

async function withTimeout(promise, ms, what) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`eval: ${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The event slice for one turn: from its first stream_start to its
 * turn_complete, only the event types the scorer reads, and at most `max`.
 */
export function sliceTurnEvents(events, max) {
  const start = Math.max(0, events.findIndex((e) => e?.type === 'stream_start'));
  const endRel = events.slice(start).findIndex((e) => e?.type === 'turn_complete');
  const slice = events.slice(start, endRel === -1 ? undefined : start + endRel + 1).filter((e) => SCORED_TYPES.has(e?.type));
  const dropped = Math.max(0, slice.length - max);
  return { events: dropped ? slice.slice(-max) : slice, dropped };
}

/** Start the target in its own sandbox, run fn, and always stop it. */
async function withTarget(adapter, settings, model, fn) {
  return withRunSandbox(settings, async (sandbox) => {
    let failure = null;
    try {
      const session = assertSession(await withTimeout(adapter.start({ sandbox, settings, model }), settings.startTimeoutMs, `${adapter.name} start`));
      return await fn(session);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      try {
        await adapter.stop();
      } catch (stopErr) {
        // Never hide either error (AP5): a stop failure after a run failure
        // travels with it; a stop failure alone is the failure.
        if (!failure) throw stopErr; // eslint-disable-line no-unsafe-finally -- AP5: a failed stop must surface, not vanish
        failure.stopError = stopErr;
      }
    }
  });
}

function emptySplit(modes) {
  return { recall: Object.fromEntries(modes.map((m) => [m, []])), uwh: [], tool: [], durations: [], lags: [], emptyRetry: 0 };
}

async function runCorpus(session, fixtures, settings, acc) {
  for (const mode of settings.modes) {
    const rows = { train: [], holdout: [] };
    for (const q of fixtures.corpus.queries) {
      const { titles } = await session.recall(q.query, settings.k, { mode });
      rows[q.split].push({ id: q.id, expectedTitles: q.expectedTitles, titles });
    }
    for (const split of SPLITS) acc[split].recall[mode].push(hitRateAtK(rows[split], settings.k));
  }
}

async function runScenario(session, scenario, settings, acc, runTurns, counters) {
  const bucket = acc[scenario.split];
  for (const [index, sess] of scenario.sessions.entries()) {
    if (index > 0) await session.reset();
    for (const turn of sess.turns) {
      const lag = monitorEventLoopDelay({ resolution: 10 });
      lag.enable();
      const t0 = performance.now();
      let result;
      try {
        result = await turnWithRetry(session, turn.user, { maxEmptyRetries: settings.maxEmptyRetries, timeoutMs: settings.turnTimeoutMs });
      } finally {
        lag.disable();
      }
      bucket.durations.push(performance.now() - t0);
      bucket.lags.push(result.eventLoopLagMs ?? lag.max / 1e6);
      bucket.emptyRetry += result.emptyRetry;
      const { events, dropped } = sliceTurnEvents(result.events ?? [], settings.maxEventsPerTurn);
      counters.eventsDropped += dropped;
      const id = `${scenario.id}/${sess.id}`;
      if (turn.expect.metric === 'usedWithoutHint') {
        runTurns[scenario.split].uwh.push({ id, user: turn.user, answer: result.text, requiredAnswerTerms: turn.expect.requiredAnswerTerms });
      } else if (turn.expect.metric === 'toolSuccess') {
        runTurns[scenario.split].tool.push(scoreToolTurn({ kind: turn.expect.kind, ...turn.expect }, events));
      }
    }
  }
}

/**
 * Run every fixture N times against one model and return its per-split block.
 * @param {{adapter: object, fixtures: {memories: object, corpus: object, scenarios: object[]},
 *   settings: object, model: {id: string}}} args
 */
export async function runModel({ adapter, fixtures, settings, model }) {
  assertTargetAdapter(adapter);
  const rows = seedRows(fixtures.memories);
  const acc = { train: emptySplit(settings.modes), holdout: emptySplit(settings.modes) };
  const counters = { eventsDropped: 0 };

  for (let run = 0; run < settings.runs; run++) {
    await withTarget(adapter, settings, model, async (session) => {
      await session.seedMemories(rows);
      await runCorpus(session, fixtures, settings, acc);
    });
    const runTurns = { train: { uwh: [], tool: [] }, holdout: { uwh: [], tool: [] } };
    for (const scenario of fixtures.scenarios) {
      await withTarget(adapter, settings, model, async (session) => {
        await session.seedMemories(rows);
        await runScenario(session, scenario, settings, acc, runTurns, counters);
      });
    }
    for (const split of SPLITS) {
      acc[split].uwh.push(usedWithoutHint(runTurns[split].uwh));
      acc[split].tool.push(toolSuccess(runTurns[split].tool));
    }
  }

  const splits = {};
  for (const split of SPLITS) {
    const a = acc[split];
    splits[split] = {
      [`hitRateAt${settings.k}`]: Object.fromEntries(settings.modes.map((m) => [m, summarize(a.recall[m])])),
      usedWithoutHint: summarize(a.uwh),
      toolSuccess: summarize(a.tool),
      latency: latencyStats(a.durations, a.lags),
      emptyRetry: a.emptyRetry,
    };
  }
  return { id: model.id, splits, eventsDropped: counters.eventsDropped };
}
