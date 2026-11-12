// T2.7 rev 3 + T2.8 - live: the model decides when to call its 5 memory tools,
// real llama-server (spec S2.7 rev 3 §3; spec S2.8 §3, the eval number).
// S2.8: the 7 S2.7 scenarios re-run with 5 tools (compare with the 2-tool
// numbers in spec S2.7 §5), plus update / forget / list. A store check after
// each run proves the right id was used. Surprise forget calls are counted.
// S2.7 rev 4 (both): code auto-recall is on. Per scenario it also reports the
// turns with an injected block, and how often the model still called recall on them.
//
//   APERIO_LIVE=1 node --test --test-name-pattern=gemma tests/tools/memory-tools-live.test.js
// Port 18433, temp dir per run, every server stopped (the port is checked free).
// N = 5 per scenario. The bar is REPORTED, not fixed (spec §3): the developer
// accepts the number. It is compared with S2.6 code recall (gemma 15/15 on the
// 3 seeded scenarios). The test fails only when a run crashes or leaks a server.
// Ornith: the developer runs it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { resolveCacheRoot } from '../../src/providers/gguf-cache.js';
import { loadEvalFixtures, seedRows } from '../../src/eval/fixtures.js';
import { scoreToolTurn, usedWithoutHint } from '../../src/eval/metrics.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';

const PORT = 18433;
const N = 5;
const MODELS = ['unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', 'protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M'];
const SCENARIOS = [
  'uwh-cross-session-standup', 'uwh-cross-session-pager',
  'uwh-seeded-slo', 'uwh-seeded-coffee', 'uwh-seeded-beacon',
  'tool-remember-explicit', 'tool-recall-explicit',
  'tool-update-explicit', 'tool-forget-explicit', 'tool-list-explicit',
];

/** S2.8: after the run, the store must show the change (proves the right id). */
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
  return { timeout: 3_600_000 };
};

/**
 * One run of a scenario on a FRESH store, one server for all its sessions.
 * Returns pass/fail plus which tools the model called.
 */
async function runOnce(model, scenario, memories) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-live-tools-'));
  const adapter = createV2LiveAdapter({ config: { ...BASE, LLAMACPP_PORT: PORT, LLAMACPP_SERVE_CTX: 16384 }, deps: { log: { error: console.error, warn: console.warn, info() {} } } });
  const called = [];
  let injected = 0;
  let recallAfterInject = 0;
  try {
    const s = await adapter.start({ sandbox: { root, dbPath: join(root, 'eval.sqlite'), port: PORT, releasePort: async () => {} }, settings: {}, model: { id: model } });
    // Like the runner: every scenario starts from the seeded rows (cross-session facts are seed: false).
    const seeded = seedRows(memories);
    await s.seedMemories(seeded);
    let pass = true;
    for (const [i, session] of scenario.sessions.entries()) {
      if (i > 0) await s.reset();
      for (const t of session.turns) {
        const r = await s.turn(t.user);
        const names = r.events.filter((e) => e.type === 'tool_start').map((e) => e.name);
        called.push(...names);
        if (r.events.some((e) => e.type === 'recall_injected')) {
          injected++;
          if (names.includes('recall')) recallAfterInject++;
        }
        if (t.expect.metric === 'usedWithoutHint') pass &&= usedWithoutHint([{ user: t.user, answer: r.text, requiredAnswerTerms: t.expect.requiredAnswerTerms }]) === 1;
        if (t.expect.metric === 'toolSuccess') pass &&= scoreToolTurn({ kind: scenario.kind, ...t.expect }, r.events).status === 'pass';
      }
    }
    const check = STORE_CHECKS[scenario.id];
    if (check) pass &&= check(await s.memories(), seeded.length);
    return { pass, called, injected, recallAfterInject };
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/health`), 'no stray server');
  }
}

for (const model of MODELS) {
  describe(`live memory tools ${model}`, () => {
    test('the model decides: pass count per scenario, N = 5 (reported)', gate(model), async (t) => {
      const fx = await loadEvalFixtures(fileURLToPath(new URL('../../evals/', import.meta.url)));
      const result = {};
      for (const id of SCENARIOS) {
        const sc = fx.scenarios.find((x) => x.id === id);
        assert.ok(sc, id);
        result[id] = { pass: 0, n: N, calls: {}, injected: 0, recallAfterInject: 0 };
        for (let i = 0; i < N; i++) {
          const { pass, called, injected, recallAfterInject } = await runOnce(model, sc, fx.memories);
          if (pass) result[id].pass++;
          result[id].injected += injected;
          result[id].recallAfterInject += recallAfterInject;
          for (const name of called) result[id].calls[name] = (result[id].calls[name] ?? 0) + 1;
        }
        t.diagnostic(JSON.stringify({ model, id, ...result[id] }));
      }
      t.diagnostic(JSON.stringify({ model, result }));
      // S2.8 bar: forget is never called when the user did not ask (reported here, judged by the developer).
      const surpriseForget = SCENARIOS.filter((id) => id !== 'tool-forget-explicit').reduce((n, id) => n + (result[id].calls.forget ?? 0), 0);
      t.diagnostic(JSON.stringify({ model, surpriseForget }));
    });
  });
}
