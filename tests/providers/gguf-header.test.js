// T2.5 - GGUF header + model-cache lookup (spec S2.5, launcher 1-2).
//
// New tests: v1 had no unit test for lib/helpers/ggufModelFacts.js. The cache
// layout cases come from v1 findCachedGguf (refs/main -> snapshots/<rev>, quant
// substring, mmproj excluded, largest file wins). v1's KV-per-token math is NOT
// ported: measured 10x too high for gemma-4-E4B (spec §1), so v2 reads only
// what it uses: arch, context length, block count, chat template.
//
// Every file is built in a throwaway temp dir (no stray state, L-P02). The two
// real-model checks read only the header and skip when the model is not cached.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGgufHeader, capabilitiesFromHeader, GgufError } from '../../src/providers/gguf-header.js';
import { findCachedGguf, resolveCacheRoot } from '../../src/providers/gguf-cache.js';

// --- a tiny GGUF writer (v3 header, KV section only; no tensors) -------------
const T = { U32: 4, STRING: 8, ARRAY: 9, U64: 10 };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => { const v = Buffer.from(s, 'utf8'); return Buffer.concat([u64(v.length), v]); };
const kv = {
  str: (k, v) => Buffer.concat([str(k), u32(T.STRING), str(v)]),
  u32: (k, v) => Buffer.concat([str(k), u32(T.U32), u32(v)]),
  u64: (k, v) => Buffer.concat([str(k), u32(T.U64), u64(v)]),
  strArray: (k, items) => Buffer.concat([str(k), u32(T.ARRAY), u32(T.STRING), u64(items.length), ...items.map(str)]),
  u32Array: (k, items) => Buffer.concat([str(k), u32(T.ARRAY), u32(T.U32), u64(items.length), ...items.map(u32)]),
};
function gguf(kvs, { magic = 'GGUF', version = 3 } = {}) {
  return Buffer.concat([Buffer.from(magic, 'ascii'), u32(version), u64(0), u64(kvs.length), ...kvs]);
}

async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aperio-gguf-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const TEMPLATE_TOOLS = '{% if tools %}{{ tools | tojson }}{% endif %}{% if enable_thinking %}<think>{% endif %}';

describe('readGgufHeader', () => {
  test('reads arch, context length, block count and the chat template', () => withTemp(async (dir) => {
    const p = join(dir, 'm.gguf');
    await writeFile(p, gguf([
      kv.str('general.architecture', 'gemma4'),
      kv.u32('gemma4.block_count', 42),
      kv.u32('gemma4.context_length', 131072),
      kv.strArray('tokenizer.ggml.tokens', Array.from({ length: 300 }, (_, i) => `tok${i}`)),
      kv.u32Array('tokenizer.ggml.token_type', Array.from({ length: 300 }, () => 1)),
      kv.str('tokenizer.chat_template', TEMPLATE_TOOLS),
    ]));
    const h = await readGgufHeader(p);
    assert.equal(h.arch, 'gemma4');
    assert.equal(h.contextLength, 131072);
    assert.equal(h.blockCount, 42);
    assert.equal(h.chatTemplate, TEMPLATE_TOOLS);
  }));

  test('a u64 context length is read too', () => withTemp(async (dir) => {
    const p = join(dir, 'm.gguf');
    await writeFile(p, gguf([kv.str('general.architecture', 'qwen35'), kv.u64('qwen35.context_length', 262144)]));
    assert.equal((await readGgufHeader(p)).contextLength, 262144);
  }));

  test('no context length in the header -> null, not a guess', () => withTemp(async (dir) => {
    const p = join(dir, 'm.gguf');
    await writeFile(p, gguf([kv.str('general.architecture', 'llama')]));
    const h = await readGgufHeader(p);
    assert.equal(h.contextLength, null);
    assert.equal(h.chatTemplate, null);
  }));

  test('not a GGUF file -> GgufError', () => withTemp(async (dir) => {
    const p = join(dir, 'm.gguf');
    await writeFile(p, gguf([], { magic: 'GGML' }));
    await assert.rejects(readGgufHeader(p), (e) => e instanceof GgufError && /not a GGUF/.test(e.message));
  }));

  test('an unsupported version -> GgufError', () => withTemp(async (dir) => {
    const p = join(dir, 'm.gguf');
    await writeFile(p, gguf([], { version: 1 }));
    await assert.rejects(readGgufHeader(p), (e) => e instanceof GgufError && /version/.test(e.message));
  }));

  test('a truncated header -> GgufError, never a half-read result', () => withTemp(async (dir) => {
    const p = join(dir, 'm.gguf');
    const full = gguf([kv.str('general.architecture', 'gemma4'), kv.u32('gemma4.context_length', 4096)]);
    await writeFile(p, full.subarray(0, full.length - 3));
    await assert.rejects(readGgufHeader(p), (e) => e instanceof GgufError && /truncated/.test(e.message));
  }));

  test('a missing file -> GgufError naming the path', async () => {
    await assert.rejects(readGgufHeader('/nonexistent/aperio/m.gguf'), (e) => e instanceof GgufError && /nonexistent/.test(e.message));
  });
});

describe('capabilitiesFromHeader (AP2: capabilities, never a model name)', () => {
  test('tools and thinking from the chat template', () => {
    assert.deepEqual(capabilitiesFromHeader({ chatTemplate: TEMPLATE_TOOLS }), { tools: true, thinking: true });
    assert.deepEqual(capabilitiesFromHeader({ chatTemplate: '{{ messages }}' }), { tools: false, thinking: false });
  });

  test('no template -> tools assumed (permissive, v1), thinking false', () => {
    assert.deepEqual(capabilitiesFromHeader({ chatTemplate: null }), { tools: true, thinking: false });
  });
});

describe('resolveCacheRoot', () => {
  test('empty LLAMA_CACHE -> the Hugging Face hub cache', () => {
    assert.equal(resolveCacheRoot('', '/home/u'), '/home/u/.cache/huggingface/hub');
  });
  test('a set value wins, with ~ expanded', () => {
    assert.equal(resolveCacheRoot('~/models', '/home/u'), '/home/u/models');
    assert.equal(resolveCacheRoot('/data/hf', '/home/u'), '/data/hf');
  });
});

describe('findCachedGguf (HF cache layout)', () => {
  /** Build models--org--repo/{refs/main, snapshots/<rev>/<files>}; returns the snapshot dir. */
  async function repo(root, id, files, rev = 'abc123') {
    const base = join(root, `models--${id.replace('/', '--')}`);
    const snap = join(base, 'snapshots', rev);
    await mkdir(join(base, 'refs'), { recursive: true });
    await mkdir(snap, { recursive: true });
    await writeFile(join(base, 'refs', 'main'), `${rev}\n`);
    for (const [name, size] of Object.entries(files)) await writeFile(join(snap, name), Buffer.alloc(size));
    return snap;
  }

  test('repo:quant finds the weights file by quant substring, case-insensitive; mmproj and mtp side files are skipped', () => withTemp(async (root) => {
    const snap = await repo(root, 'unsloth/gemma-4-E4B-it-qat-GGUF', {
      'gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf': 400, 'mmproj-BF16.gguf': 900, 'mtp-gemma-4-E4B-it.gguf': 50,
    });
    assert.equal(await findCachedGguf('unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', root), join(snap, 'gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf'));
  }));

  test('no quant: the largest weights file wins (mmproj and mtp draft files never count)', () => withTemp(async (root) => {
    const snap = await repo(root, 'org/m-GGUF', { 'm-Q4_K_M.gguf': 300, 'm-Q8_0.gguf': 600, 'mmproj-F16.gguf': 5000, 'mtp-m.gguf': 7000 });
    assert.equal(await findCachedGguf('org/m-GGUF', root), join(snap, 'm-Q8_0.gguf'));
  }));

  test('snapshot entries that are symlinks to blobs are followed (real HF layout)', () => withTemp(async (root) => {
    const snap = await repo(root, 'org/m-GGUF', {});
    const blobs = join(root, 'models--org--m-GGUF', 'blobs');
    await mkdir(blobs, { recursive: true });
    await writeFile(join(blobs, 'sha-big'), Buffer.alloc(800));
    await writeFile(join(blobs, 'sha-small'), Buffer.alloc(100));
    await symlink(join(blobs, 'sha-big'), join(snap, 'm-Q8_0.gguf'));
    await symlink(join(blobs, 'sha-small'), join(snap, 'm-Q4_0.gguf'));
    assert.equal(await findCachedGguf('org/m-GGUF', root), join(snap, 'm-Q8_0.gguf'));
  }));

  test('a quant with no matching file -> null (never a silent different quant)', () => withTemp(async (root) => {
    await repo(root, 'org/m-GGUF', { 'm-Q8_0.gguf': 600 });
    assert.equal(await findCachedGguf('org/m-GGUF:Q4_K_M', root), null);
  }));

  test('not cached, broken refs, or a name without org/ -> null', () => withTemp(async (root) => {
    assert.equal(await findCachedGguf('org/missing-GGUF:Q4_K_M', root), null);
    await mkdir(join(root, 'models--org--broken-GGUF'), { recursive: true });
    assert.equal(await findCachedGguf('org/broken-GGUF', root), null);
    assert.equal(await findCachedGguf('justaname', root), null);
  }));

  test('an absolute .gguf path that exists is used as is', () => withTemp(async (root) => {
    const p = join(root, 'local.gguf');
    await writeFile(p, Buffer.alloc(10));
    assert.equal(await findCachedGguf(p, '/unused'), p);
    assert.equal(await findCachedGguf(join(root, 'nope.gguf'), '/unused'), null);
  }));
});

describe('real model headers (skip when not cached)', () => {
  const root = resolveCacheRoot('', homedir());
  const cases = [
    { model: 'unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL', arch: 'gemma4', ctx: 131072 },
    { model: 'protoLabsAI/Ornith-1.0-9B-MTP-GGUF:Q4_K_M', arch: 'qwen35', ctx: 262144 },
  ];
  for (const c of cases) {
    const cached = existsSync(join(root, `models--${c.model.split(':')[0].replace('/', '--')}`));
    test(`${c.model}: arch ${c.arch}, context ${c.ctx}, tool template`, cached ? {} : { skip: `SKIPPED: ${c.model} is not in ${root}` }, async () => {
      const path = await findCachedGguf(c.model, root);
      assert.ok(path, 'weights file found');
      const h = await readGgufHeader(path);
      assert.equal(h.arch, c.arch);
      assert.equal(h.contextLength, c.ctx);
      assert.equal(capabilitiesFromHeader(h).tools, true);
    });
  }
});
