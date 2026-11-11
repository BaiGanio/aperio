// T2.7 - live: capture -> next session -> recall, real llama-server (spec S2.7 §3).
//
//   APERIO_LIVE=1 node --test tests/capture/capture-live.test.js
// Empty store, the 2 cross-session scenarios, N = 5. Bar: usedWithoutHint
// >= 4/5 per scenario with capture on, 0/5 off. Port 18433, temp dir, every
// server stopped (the port is checked free). Ornith: the developer runs it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../../src/config/read-config.js';
import { resolveCacheRoot } from '../../src/providers/gguf-cache.js';
import { loadEvalFixtures } from '../../src/eval/fixtures.js';
import { usedWithoutHint } from '../../src/eval/metrics.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';

const PORT = 18433;
const N = 5;
const MODELS = ['unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', 'protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M'];
const CROSS = ['uwh-cross-session-standup', 'uwh-cross-session-pager'];
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

/** One run of a scenario on a FRESH store: session A, reset, session B. */
async function runOnce(model, scenario, capture) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-live-capture-'));
  const adapter = createV2LiveAdapter({ config: { ...BASE, LLAMACPP_PORT: PORT, LLAMACPP_SERVE_CTX: 16384 }, recall: true, capture, deps: { log: { error: console.error, warn: console.warn, info() {} } } });
  try {
    const s = await adapter.start({ sandbox: { root, dbPath: join(root, 'eval.sqlite'), port: PORT, releasePort: async () => {} }, settings: {}, model: { id: model } });
    for (const t of scenario.sessions[0].turns) await s.turn(t.user);
    await s.reset();
    const scored = [];
    for (const t of scenario.sessions[1].turns) {
      const r = await s.turn(t.user);
      if (t.expect.metric === 'usedWithoutHint') scored.push({ user: t.user, answer: r.text, requiredAnswerTerms: t.expect.requiredAnswerTerms });
    }
    return usedWithoutHint(scored) === 1;
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/health`), 'no stray server');
  }
}

for (const model of MODELS) {
  describe(`live capture ${model}`, () => {
    test('cross-session: capture on >= 4/5 each, off 0/5', gate(model), async (t) => {
      const fx = await loadEvalFixtures(fileURLToPath(new URL('../../evals/', import.meta.url)));
      const result = {};
      for (const id of CROSS) {
        const sc = fx.scenarios.find((x) => x.id === id);
        result[id] = { on: 0, off: 0 };
        for (let i = 0; i < N; i++) {
          if (await runOnce(model, sc, true)) result[id].on++;
          if (await runOnce(model, sc, false)) result[id].off++;
        }
      }
      t.diagnostic(JSON.stringify({ model, result }));
      for (const id of CROSS) {
        assert.ok(result[id].on >= 4, `${id}: on ${result[id].on}/${N}`);
        assert.equal(result[id].off, 0, `${id}: off ${result[id].off}/${N}`);
      }
    });
  });
}
