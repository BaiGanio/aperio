// T2.10 - live: does each rule block help? (spec S2.10 §2 "Eval design", §3).
// Configs: baseline (TEST_SYSTEM = buildSystem([])), all, and all minus each
// block (leave-one-out). Scenarios: the 10 S2.8 scenarios + 1 per block.
// N runs per scenario per config, a fresh store and server per run.
//
//   APERIO_LIVE=1 node --test --test-name-pattern=gemma tests/context/system-prompt-live.test.js
//   APERIO_EVAL_CONFIGS=baseline,all  → run only these configs (default: all 5)
// Port 18434, temp dir per run, every server stopped (the port is checked free).
// Reports pass count per scenario, train / holdout totals, mean and spread
// over runs, mean and max turn latency, surprise forget, prompt_tokens per config.
// The bar is judged by the developer (spec §3); the test fails only on a crash or a leaked server.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { resolveCacheRoot } from '../../src/providers/gguf-cache.js';
import { loadEvalFixtures, scenarioSeedRows, seedRows } from '../../src/eval/fixtures.js';
import { latencyStats, scoreToolTurn, summarize, usedWithoutHint } from '../../src/eval/metrics.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';
import { BLOCK_NAMES, buildSystem } from '../../src/context/system-prompt.js';

const PORT = 18434;
const N = 5;
const MODELS = ['unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', 'protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M'];
const OLD = [
  'uwh-cross-session-standup', 'uwh-cross-session-pager',
  'uwh-seeded-slo', 'uwh-seeded-coffee', 'uwh-seeded-beacon',
  'tool-remember-explicit', 'tool-recall-explicit',
  'tool-update-explicit', 'tool-forget-explicit', 'tool-list-explicit',
];
const NEW = ['conduct-no-tool-text', 'memory-injection', 'conversation-contradiction'];
const SCENARIOS = [...OLD, ...NEW];
const ALL_CONFIGS = {
  baseline: buildSystem([]),
  all: buildSystem(),
  ...Object.fromEntries(BLOCK_NAMES.map((b) => [`all-${b}`, buildSystem(BLOCK_NAMES.filter((x) => x !== b))])),
};
const pick = process.env.APERIO_EVAL_CONFIGS?.split(',').map((s) => s.trim()).filter(Boolean);
const CONFIGS = pick ? Object.fromEntries(pick.map((k) => [k, ALL_CONFIGS[k] ?? assert.fail(`unknown config ${k}`)])) : ALL_CONFIGS;

const hasText = (rows, re) => rows.some((r) => re.test(`${r.title} ${r.content}`));
const STORE_CHECKS = {
  'tool-update-explicit': (rows, seeded) => rows.length === seeded && rows.some((r) => /cortado/i.test(r.content)) && !rows.some((r) => /flat white/i.test(r.content)),
  'tool-forget-explicit': (rows, seeded) => rows.length === seeded - 1 && !hasText(rows, /flat white/i),
};
const BASE = readConfig({}).values;
const LLAMA_ROOT = resolveCacheRoot('', homedir());
const EMBED_CACHE = BASE.TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
const cached = (id) => existsSync(join(LLAMA_ROOT, `models--${id.split(':')[0].replace('/', '--')}`));
const gate = (id) => {
  if (process.env.APERIO_LIVE !== '1') return { skip: 'SKIPPED: live llama.cpp test. Run with APERIO_LIVE=1.' };
  if (!cached(id)) return { skip: `SKIPPED: ${id} is not cached. Run: npm run model:fetch` };
  if (!existsSync(join(EMBED_CACHE, BASE.EMBEDDING_MODEL, 'onnx'))) return { skip: `SKIPPED: ${BASE.EMBEDDING_MODEL} is not cached.` };
  return { timeout: 6 * 3_600_000 };
};
const QUIET = { error: console.error, warn: console.warn, info() {} };

/** Start a fresh server + store, run fn, always stop and check the port is free. */
async function withSession(model, system, fn) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-live-s210-'));
  const adapter = createV2LiveAdapter({ config: { ...BASE, LLAMACPP_PORT: PORT, LLAMACPP_SERVE_CTX: 16384 }, system, deps: { log: QUIET } });
  try {
    const s = await adapter.start({ sandbox: { root, dbPath: join(root, 'eval.sqlite'), port: PORT, releasePort: async () => {} }, settings: {}, model: { id: model } });
    return await fn(s);
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/health`), 'no stray server');
  }
}

async function runOnce(model, system, scenario, memories) {
  return withSession(model, system, async (s) => {
    const seeded = [...seedRows(memories), ...scenarioSeedRows(scenario, memories.asOf)];
    await s.seedMemories(seeded);
    const called = [];
    const durations = [];
    let pass = true;
    for (const [i, session] of scenario.sessions.entries()) {
      if (i > 0) await s.reset();
      for (const t of session.turns) {
        const t0 = performance.now();
        const r = await s.turn(t.user);
        durations.push(performance.now() - t0);
        called.push(...r.events.filter((e) => e.type === 'tool_start').map((e) => e.name));
        if (t.expect.metric === 'usedWithoutHint') pass &&= usedWithoutHint([{ user: t.user, answer: r.text, requiredAnswerTerms: t.expect.requiredAnswerTerms }]) === 1;
        if (t.expect.metric === 'toolSuccess') pass &&= scoreToolTurn({ kind: scenario.kind, ...t.expect }, r.events).status === 'pass';
      }
    }
    const check = STORE_CHECKS[scenario.id];
    if (check) pass &&= check(await s.memories(), seeded.length);
    return { pass, called, durations };
  });
}

/** prompt_tokens of one "Hello." turn on an empty store: the cost of the system prompt. */
async function promptTokens(model, system) {
  return withSession(model, system, async (s) => (await s.turn('Hello.')).usage?.prompt_tokens ?? null);
}

for (const model of MODELS) {
  describe(`live system prompt ${model}`, () => {
    test('each block on / off: pass count per scenario, N = 5 (reported)', gate(model), async (t) => {
      const fx = await loadEvalFixtures(fileURLToPath(new URL('../../evals/', import.meta.url)));
      const scenarios = SCENARIOS.map((id) => fx.scenarios.find((x) => x.id === id) ?? assert.fail(id));
      const report = {};
      for (const [config, system] of Object.entries(CONFIGS)) {
        const tokens = await promptTokens(model, system);
        const perScenario = {};
        const perRun = Array.from({ length: N }, () => ({ train: 0, holdout: 0 }));
        const durations = [];
        let surpriseForget = 0;
        for (const sc of scenarios) {
          perScenario[sc.id] = { pass: 0, calls: {} };
          for (let run = 0; run < N; run++) {
            const r = await runOnce(model, system, sc, fx.memories);
            durations.push(...r.durations);
            if (r.pass) { perScenario[sc.id].pass++; perRun[run][sc.split]++; }
            for (const name of r.called) perScenario[sc.id].calls[name] = (perScenario[sc.id].calls[name] ?? 0) + 1;
            if (sc.id !== 'tool-forget-explicit') surpriseForget += r.called.filter((x) => x === 'forget').length;
          }
          t.diagnostic(JSON.stringify({ model, config, id: sc.id, pass: perScenario[sc.id].pass, n: N, calls: perScenario[sc.id].calls }));
        }
        const count = (split) => scenarios.filter((s) => s.split === split).length;
        const lat = latencyStats(durations, []);
        report[config] = {
          promptTokens: tokens,
          train: summarize(perRun.map((r) => r.train / count('train'))),
          holdout: summarize(perRun.map((r) => r.holdout / count('holdout'))),
          latencyMs: { mean: Math.round(lat.meanMs), stdev: Math.round(lat.stdevMs), max: Math.round(lat.maxMs) },
          surpriseForget,
          scenarios: Object.fromEntries(Object.entries(perScenario).map(([id, v]) => [id, v.pass])),
        };
        t.diagnostic(JSON.stringify({ model, config, ...report[config] }));
      }
      t.diagnostic(JSON.stringify({ model, report }));
    });
  });
}
