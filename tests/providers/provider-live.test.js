// T2.5 - live: the real llama-server, both test models (spec S2.5 §3, the eval number).
//
// Runs only with APERIO_LIVE=1 (about 3 minutes, starts real servers):
//   APERIO_LIVE=1 node --test tests/providers/provider-live.test.js
// Isolated: port 18432, logs in a temp dir, every server stopped after (the test
// checks the port is free). Without APERIO_LIVE=1 or a cached model it SKIPS
// with the reason.
//
// The bar is the v1 measurement in spec §1 (2026-11-11, N = 5 cold runs):
//   KV reuse on turns 2-3 >= 97 % (v1: 97.7-98.3 %);
//   turn-2 TTFT mean <= v1 max (gemma 242 ms, Ornith 386 ms).
// Plus: >= 4 of 5 tool-call prompts give a parsed `recall` call (or an honest
// bad_tool_json - never {}), and gemma keeps >= 80 % of its idle tok/s while
// the S2.4 embedder runs (the CPU-fight check).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../../src/config/read-config.js';
import { startLlama } from '../../src/providers/llama-launcher.js';
import { createChatProvider } from '../../src/providers/chat-provider.js';
import { resolveCacheRoot } from '../../src/providers/gguf-cache.js';
import { createEmbedder } from '../../src/embeddings/local-embedder.js';

const PORT = 18432;
const CTX = 16384;
const N = 5;
const CACHE_ROOT = resolveCacheRoot('', homedir());
const MODELS = [
  { id: 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', ttftBarMs: 242 },
  { id: 'protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M', ttftBarMs: 386 },
];
const TOOLS = [
  { name: 'remember', description: 'Save a new memory.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'recall', description: 'Search the user memories.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'update', description: 'Update a memory.', parameters: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' } }, required: ['id'] } },
  { name: 'forget', description: 'Delete a memory.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'list', description: 'List recent memories.', parameters: { type: 'object', properties: { limit: { type: 'integer' } } } },
];
const PARA = 'Aperio is a small local assistant that remembers. It keeps the user memories in a local database and answers with them in mind. Be brief, be honest, and say when you do not know. ';
const SYSTEM = 'You are Aperio.\n' + PARA.repeat(30);
const USERS = ['Hi. My dog is called Pixel and she is 3 years old.', 'What did I tell you about my dog?', 'Write one short sentence about dogs.'];
const ASSIST = ['Nice to meet Pixel. I will remember that she is 3.', 'You said your dog Pixel is 3 years old.'];

const cachedModel = (id) => existsSync(join(CACHE_ROOT, `models--${id.split(':')[0].replace('/', '--')}`));
const gate = (id) => {
  if (process.env.APERIO_LIVE !== '1') return { skip: 'SKIPPED: live llama.cpp test. Run with APERIO_LIVE=1 (about 3 min).' };
  if (!cachedModel(id)) return { skip: `SKIPPED: ${id} is not in ${CACHE_ROOT}. Run: npm run model:fetch` };
  return { timeout: 600_000 };
};

const stat = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean: +mean.toFixed(1), sd: +sd.toFixed(1), max: +Math.max(...xs).toFixed(1) };
};

async function withServer(model, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'aperio-live-llama-'));
  const config = { ...readConfig({}).values, LLAMACPP_MODEL: model, LLAMACPP_PORT: PORT, LLAMACPP_SERVE_CTX: CTX };
  const llama = await startLlama({ config, deps: { logPath: join(dir, 'llama-server.log') } });
  try {
    return await fn(llama, config);
  } finally {
    await llama.stop();
    await rm(dir, { recursive: true, force: true });
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/health`), 'the port is free after stop: no stray server');
  }
}

/** One streamed call; returns the result plus time to the first token or reasoning token. */
async function timedCall(provider, req) {
  const t0 = Date.now();
  let first = null;
  let tokens = 0;
  const emit = (e) => {
    if ((e.type === 'token' || e.type === 'reasoning_token') && first === null) first = Date.now() - t0;
    if (e.type === 'token' || e.type === 'reasoning_token') tokens++;
  };
  const r = await provider.streamChat({ ...req, emit });
  return { r, ttft: first, tokens };
}

for (const m of MODELS) {
  describe(`live ${m.id}`, () => {
    test('start, stream, KV reuse, TTFT, tool call, stop', gate(m.id), async (t) => {
      await withServer(m.id, async (llama) => {
        assert.equal(llama.ctx, CTX, 'min(cap, header)');
        assert.equal(llama.servedCtx, CTX, 'the server reports the context we asked for');
        const provider = createChatProvider({ baseURL: llama.baseURL, tools: TOOLS, capabilities: llama.capabilities });

        const turns = [[], [], []];
        for (let run = 0; run < N; run++) {
          const system = `Run ${run}-${Date.now()}. ${SYSTEM}`; // cold turn 1 every run
          const messages = [];
          const hashes = new Set();
          for (let i = 0; i < 3; i++) {
            messages.push({ role: 'user', content: USERS[i] });
            const { r, ttft, tokens } = await timedCall(provider, { system, messages: [...messages] });
            assert.equal(r.error, null, `run ${run} turn ${i + 1}: ${r.error?.message}`);
            assert.ok(tokens > 0, 'tokens were streamed');
            hashes.add(r.prefixHash);
            const tm = r.timings;
            turns[i].push({ ttft, tps: tm.predicted_per_second, reuse: (100 * tm.cache_n) / (tm.cache_n + tm.prompt_n) });
            if (i < 2) messages.push({ role: 'assistant', content: ASSIST[i] });
          }
          assert.equal(hashes.size, 1, 'one prefixHash for the whole conversation');
        }
        const report = turns.map((rows, i) => ({
          turn: i + 1, ttft_ms: stat(rows.map((x) => x.ttft)), tok_s: stat(rows.map((x) => x.tps)), reuse_pct: stat(rows.map((x) => x.reuse)),
        }));
        for (const line of report) t.diagnostic(JSON.stringify({ model: m.id, ...line }));
        assert.ok(report[1].reuse_pct.mean >= 97 && report[2].reuse_pct.mean >= 97, `KV reuse turns 2-3 >= 97 %: ${JSON.stringify(report)}`);
        assert.ok(report[1].ttft_ms.mean <= m.ttftBarMs, `turn-2 TTFT ${report[1].ttft_ms.mean} ms <= v1 max ${m.ttftBarMs} ms`);

        let good = 0;
        for (let i = 0; i < N; i++) {
          const { r } = await timedCall(provider, { system: SYSTEM, messages: [{ role: 'user', content: 'Use the recall tool to search my memories for "Pixel".' }] });
          const call = r.toolCalls.find((c) => c.name === 'recall');
          if (call) {
            assert.ok(call.error === 'bad_tool_json' || (call.args && typeof call.args === 'object'), 'parsed args or an honest error');
            if (call.error) t.diagnostic(`bad_tool_json: ${call.raw}`);
            else if (typeof call.args.query === 'string') good++;
            else t.diagnostic(`recall without a query: ${JSON.stringify(call.args)}`);
          }
        }
        t.diagnostic(`tool-call prompts with a recall call: ${good}/${N}`);
        assert.ok(good >= 4, `>= 4/${N} tool-call prompts give a recall call, got ${good}`);
      });
    });
  });
}

describe('live CPU-fight check (gemma + the S2.4 embedder)', () => {
  const { EMBEDDING_MODEL, TRANSFORMERS_CACHE, EMBEDDING_THREADS } = readConfig({}).values;
  const embedCache = TRANSFORMERS_CACHE.replace(/^~(?=\/|$)/, homedir());
  const g = gate(MODELS[0].id);
  const opts = !g.skip && !existsSync(join(embedCache, EMBEDDING_MODEL, 'onnx'))
    ? { skip: `SKIPPED: ${EMBEDDING_MODEL} is not cached. Run: npm run model:fetch` } : g;

  test('gemma keeps >= 80 % of its idle tok/s while the embedder runs', opts, async (t) => {
    await withServer(MODELS[0].id, async (llama) => {
      const provider = createChatProvider({ baseURL: llama.baseURL, tools: TOOLS, capabilities: llama.capabilities });
      const ask = { system: SYSTEM, messages: [{ role: 'user', content: 'Write about 120 words about dogs. Do not use tools.' }] };
      const tps = async () => (await timedCall(provider, ask)).r.timings.predicted_per_second;

      const idle = [];
      for (let i = 0; i < N; i++) idle.push(await tps());

      const embedder = await createEmbedder({ model: EMBEDDING_MODEL, cacheDir: embedCache, threads: EMBEDDING_THREADS, log: { warn() {}, info() {} } });
      let running = true;
      const busy = (async () => { let i = 0; while (running) await embedder.embed(`memory number ${i++}: the user likes long walks with the dog.`); })();
      const loaded = [];
      try {
        for (let i = 0; i < N; i++) loaded.push(await tps());
      } finally {
        running = false;
        await busy;
        await embedder.close();
      }
      const a = stat(idle);
      const b = stat(loaded);
      t.diagnostic(JSON.stringify({ idle_tok_s: a, with_embedder_tok_s: b, threads: llama.threads }));
      assert.ok(b.mean >= 0.8 * a.mean, `with embedder ${b.mean} tok/s >= 80 % of idle ${a.mean}`);
    });
  });
});
