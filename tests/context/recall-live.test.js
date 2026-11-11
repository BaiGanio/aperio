// T2.6 - live: auto-recall against the real llama-server, both test models
// (spec S2.6 §3, the eval number).
//
// Runs only with APERIO_LIVE=1 (starts real servers, several minutes):
//   APERIO_LIVE=1 node --test tests/context/recall-live.test.js
// Isolated: port 18432, DB and logs in a temp dir, every server stopped after
// (the test checks the port is free). Without APERIO_LIVE=1 or a cached model
// it SKIPS with the reason.
//
// Bars (spec §3), N = 5:
//   usedWithoutHint on the 3 seeded scenarios: recall on >= 4/5 per scenario, and on > off;
//   KV on turns 2-3 with recall on: the whole previous prompt is reused
//   (cache_n >= the previous turn's prompt tokens). The % is reported only
//   (decision 2026-11-11: a recall block is new text, so the % drops by design);
//   ceil(chars / 3) >= the real /tokenize count for every block.
// Reported: recall step latency mean / sd / max.

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
import { usedWithoutHint } from '../../src/eval/metrics.js';
import { estimateTokens } from '../../src/context/recall-block.js';
import { createV2LiveAdapter } from '../../src/eval/v2-live-adapter.js';

const PORT = 18432;
const CTX = 16384;
const N = 5;
const EVALS = fileURLToPath(new URL('../../evals/', import.meta.url));
const MODELS = ['unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', 'protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M'];
const SEEDED = ['uwh-seeded-slo', 'uwh-seeded-coffee', 'uwh-seeded-beacon'];
const BASE = readConfig({}).values;
const LLAMA_ROOT = resolveCacheRoot('', homedir());
const EMBED_CACHE = BASE.TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());

// The S2.5 KV setup: 5 tools and a long system, so the % compares with S2.5.
const TOOLS = ['remember', 'recall', 'update', 'forget', 'list'].map((name) => ({
  name, description: `The ${name} memory tool.`, parameters: { type: 'object', properties: { query: { type: 'string' } } },
}));
const PARA = 'Aperio is a small local assistant that remembers. It keeps the user memories in a local database and answers with them in mind. Be brief, be honest, and say when you do not know. ';
const KV_SYSTEM = `You are Aperio.\n${PARA.repeat(30)}`;
const KV_TURNS = ['Morning! I am planning the week for the platform team.', 'We see 70ms at p99 on /quote this week. Is that inside our target?', 'Thanks. Write one short sentence about dogs.'];

const cachedModel = (id) => existsSync(join(LLAMA_ROOT, `models--${id.split(':')[0].replace('/', '--')}`));
const gate = (id) => {
  if (process.env.APERIO_LIVE !== '1') return { skip: 'SKIPPED: live llama.cpp test. Run with APERIO_LIVE=1.' };
  if (!cachedModel(id)) return { skip: `SKIPPED: ${id} is not in ${LLAMA_ROOT}. Run: npm run model:fetch` };
  if (!existsSync(join(EMBED_CACHE, BASE.EMBEDDING_MODEL, 'onnx'))) return { skip: `SKIPPED: ${BASE.EMBEDDING_MODEL} is not cached. Run: npm run model:fetch` };
  return { timeout: 3_600_000 };
};

const stat = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(xs.length - 1, 1));
  return { n: xs.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2), max: +Math.max(...xs).toFixed(2) };
};

/** One adapter, one server, one temp dir. Always stopped; the port is free after. */
async function withAdapter(model, opts, fn) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-live-recall-'));
  const config = { ...BASE, LLAMACPP_PORT: PORT, LLAMACPP_SERVE_CTX: CTX };
  const adapter = createV2LiveAdapter({ config, ...opts, deps: { log: { error: console.error, warn: console.warn, info() {} } } });
  try {
    const session = await adapter.start({ sandbox: { root, dbPath: join(root, 'eval.sqlite'), port: PORT, releasePort: async () => {} }, settings: {}, model: { id: model } });
    return await fn(session);
  } finally {
    await adapter.stop();
    await rm(root, { recursive: true, force: true });
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/health`), 'the port is free after stop: no stray server');
  }
}

async function tokenizeCount(text) {
  const res = await fetch(`http://127.0.0.1:${PORT}/tokenize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) });
  return (await res.json()).tokens.length;
}

for (const model of MODELS) {
  describe(`live recall ${model}`, () => {
    test('usedWithoutHint on vs off, KV reuse, chars/3 vs /tokenize, recall latency', gate(model), async (t) => {
      const fx = await loadEvalFixtures(EVALS);
      const rows = seedRows(fx.memories);
      const scenarios = SEEDED.map((id) => fx.scenarios.find((s) => s.id === id));
      const blocks = [];
      const recallMs = [];

      /** N runs of every seeded scenario; returns passes per scenario. */
      const runScenarios = (recall) => withAdapter(model, { recall }, async (session) => {
        await session.seedMemories(rows);
        const passes = {};
        for (const s of scenarios) {
          const turns = [];
          for (let run = 0; run < N; run++) {
            await session.reset();
            for (const turn of s.sessions[0].turns) {
              const r = await session.turn(turn.user);
              if (recall) {
                recallMs.push(r.recall.ms);
                if (r.recall.block) blocks.push({ block: r.recall.block, count: await tokenizeCount(r.recall.block) });
              }
              if (turn.expect.metric === 'usedWithoutHint') {
                turns.push({ id: `${s.id}/${run}`, user: turn.user, answer: r.text, requiredAnswerTerms: turn.expect.requiredAnswerTerms });
                if (!usedWithoutHint([turns.at(-1)])) t.diagnostic(`${recall ? 'on' : 'off'} miss ${s.id}/${run}: ${JSON.stringify(r.text.slice(0, 200))}`);
              }
            }
          }
          passes[s.id] = Math.round(usedWithoutHint(turns) * N);
        }
        return passes;
      });

      const on = await runScenarios(true);
      const off = await runScenarios(false);
      t.diagnostic(JSON.stringify({ model, usedWithoutHint: { on, off } }));

      // KV reuse with recall on, the S2.5 setup.
      const kv = [[], []];
      const whole = [];
      await withAdapter(model, { recall: true, system: KV_SYSTEM, tools: TOOLS }, async (session) => {
        await session.seedMemories(rows);
        for (let run = 0; run < N; run++) {
          await session.reset();
          let prevPrompt = 0;
          for (const [i, text] of KV_TURNS.entries()) {
            const r = await session.turn(text);
            const tm = r.timings;
            if (r.recall.block) blocks.push({ block: r.recall.block, count: await tokenizeCount(r.recall.block) });
            if (i > 0) {
              kv[i - 1].push((100 * tm.cache_n) / (tm.cache_n + tm.prompt_n));
              whole.push({ run, turn: i + 1, cache_n: tm.cache_n, prevPrompt, injected: Boolean(r.recall.block) });
            }
            prevPrompt = tm.cache_n + tm.prompt_n;
          }
        }
      });
      const reuse = { turn2: stat(kv[0]), turn3: stat(kv[1]) };
      t.diagnostic(JSON.stringify({ model, kvReusePct: reuse, injectedOnTurn2: whole.filter((w) => w.turn === 2 && w.injected).length }));

      const over = blocks.filter((b) => estimateTokens(b.block) < b.count);
      const ratio = blocks.map((b) => estimateTokens(b.block) / b.count);
      t.diagnostic(JSON.stringify({ model, blocks: blocks.length, chars3OverTokenize: ratio.length ? stat(ratio) : null, under: over.length }));
      t.diagnostic(JSON.stringify({ model, recallMs: stat(recallMs) }));

      for (const id of SEEDED) assert.ok(on[id] >= 4, `${id}: recall on ${on[id]}/${N} >= 4`);
      const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      assert.ok(sum(on) > sum(off), `on ${sum(on)} > off ${sum(off)}`);
      // Bar (developer decision 2026-11-11, option A): the whole previous prompt is
      // reused. The % is reported, not gated: a recall block is new text, so the
      // % drops on an injected turn even with a perfect cache.
      for (const w of whole) assert.ok(w.cache_n >= w.prevPrompt, `run ${w.run} turn ${w.turn}: the whole previous prompt is reused (${w.cache_n} >= ${w.prevPrompt})`);
      assert.ok(blocks.length > 0, 'at least one block was checked');
      assert.equal(over.length, 0, `ceil(chars/3) >= /tokenize on every block: ${JSON.stringify(over.map((b) => b.count))}`);
    });
  });
}
