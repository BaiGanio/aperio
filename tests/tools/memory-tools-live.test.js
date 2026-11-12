// T2.7 rev 3 - live: the model decides when to call remember / recall, real
// llama-server (spec S2.7 rev 3 §3, the eval number).
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
];
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
  try {
    const s = await adapter.start({ sandbox: { root, dbPath: join(root, 'eval.sqlite'), port: PORT, releasePort: async () => {} }, settings: {}, model: { id: model } });
    // Like the runner: every scenario starts from the seeded rows (cross-session facts are seed: false).
    await s.seedMemories(seedRows(memories));
    let pass = true;
    for (const [i, session] of scenario.sessions.entries()) {
      if (i > 0) await s.reset();
      for (const t of session.turns) {
        const r = await s.turn(t.user);
        called.push(...r.events.filter((e) => e.type === 'tool_start').map((e) => e.name));
        if (t.expect.metric === 'usedWithoutHint') pass &&= usedWithoutHint([{ user: t.user, answer: r.text, requiredAnswerTerms: t.expect.requiredAnswerTerms }]) === 1;
        if (t.expect.metric === 'toolSuccess') pass &&= scoreToolTurn({ kind: scenario.kind, ...t.expect }, r.events).status === 'pass';
      }
    }
    return { pass, called };
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
        result[id] = { pass: 0, n: N, calls: {} };
        for (let i = 0; i < N; i++) {
          const { pass, called } = await runOnce(model, sc, fx.memories);
          if (pass) result[id].pass++;
          for (const name of called) result[id].calls[name] = (result[id].calls[name] ?? 0) + 1;
        }
        t.diagnostic(JSON.stringify({ model, id, ...result[id] }));
      }
      t.diagnostic(JSON.stringify({ model, result }));
    });
  });
}
