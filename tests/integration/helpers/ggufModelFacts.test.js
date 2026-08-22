import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { factsFromGguf, findCachedGguf, inspectCachedModel, readGgufMetadata } from "../../../lib/helpers/ggufModelFacts.js";
import { buildModelsPreset } from "../../../lib/helpers/startLlamaCpp.js";

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = s => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
function kv(key, type, value) {
  const encoded = type === 8 ? str(value) : u32(value);
  return Buffer.concat([str(key), u32(type), encoded]);
}
function fixture(path) {
  const entries = [
    kv("general.architecture", 8, "qwen35"),
    kv("qwen35.block_count", 4, 40),
    kv("qwen35.context_length", 4, 262144),
    kv("qwen35.embedding_length", 4, 2048),
    kv("qwen35.attention.head_count", 4, 16),
    kv("qwen35.attention.head_count_kv", 4, 2),
    kv("qwen35.attention.key_length", 4, 256),
    kv("qwen35.attention.value_length", 4, 256),
    kv("qwen35.full_attention_interval", 4, 4),
    kv("qwen35.expert_count", 4, 256),
  ];
  writeFileSync(path, Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length), ...entries, Buffer.alloc(1024)]));
}

describe("GGUF model facts", () => {
  test("derives hybrid KV layers, context, architecture, and actual file size", () => {
    const root = mkdtempSync(join(tmpdir(), "aperio-gguf-")); roots.push(root);
    const path = join(root, "model.gguf"); fixture(path);
    const meta = readGgufMetadata(path);
    assert.equal(meta["qwen35.full_attention_interval"], 4);
    const facts = factsFromGguf(path);
    assert.equal(facts.kvLayers, 10);
    assert.equal(facts.kvBytesPerToken, 20480);
    assert.equal(facts.maxContext, 262144);
    assert.equal(facts.architecture, "moe");
    assert.ok(facts.sizeGB > 0);
  });

  test("finds the requested quant in the Hugging Face snapshot cache", () => {
    const cache = mkdtempSync(join(tmpdir(), "aperio-cache-")); roots.push(cache);
    const repo = join(cache, "models--org--Model-GGUF");
    const snap = join(repo, "snapshots", "abc");
    mkdirSync(join(repo, "refs"), { recursive: true }); mkdirSync(snap, { recursive: true });
    writeFileSync(join(repo, "refs", "main"), "abc");
    const blob = join(cache, "blob.gguf"); fixture(blob);
    symlinkSync(blob, join(snap, "Model-Q4_K_M.gguf"));
    assert.equal(findCachedGguf("org/Model-GGUF:Q4_K_M", cache), join(snap, "Model-Q4_K_M.gguf"));
    assert.equal(inspectCachedModel("org/Model-GGUF:Q4_K_M", cache)?.kvBytesPerToken, 20480);
    const preset = buildModelsPreset({ LLAMACPP_MODEL: "org/Model-GGUF:Q4_K_M" }, { totalRamGB: 32, modelCacheDir: cache });
    assert.match(preset, /\[aperio-main\][\s\S]*?ctx-size = 131072/);
  });

  test("sums every shard when estimating split GGUF weight RAM", () => {
    const cache = mkdtempSync(join(tmpdir(), "aperio-cache-")); roots.push(cache);
    const repo = join(cache, "models--org--Split-GGUF");
    const snap = join(repo, "snapshots", "abc");
    mkdirSync(join(repo, "refs"), { recursive: true }); mkdirSync(snap, { recursive: true });
    writeFileSync(join(repo, "refs", "main"), "abc");
    const first = join(snap, "Split-Q4_K_M-00001-of-00002.gguf");
    const second = join(snap, "Split-Q4_K_M-00002-of-00002.gguf");
    fixture(first); fixture(second);
    const facts = inspectCachedModel("org/Split-GGUF:Q4_K_M", cache);
    const expected = (statSync(first).size + statSync(second).size) / 1024 ** 3;
    assert.equal(facts.sizeGB, expected);
  });
});
