// tests/lib/helpers/specs.test.js
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getSpecs } from "../../../lib/helpers/specs.js";

// A minimal GGUF header the shared inspector can parse (same shape as the
// ggufModelFacts fixtures) so a cached-but-non-catalog model reports a real
// on-disk size.
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = s => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
function kv(key, type, value) {
  const encoded = type === 8 ? str(value) : u32(value);
  return Buffer.concat([str(key), u32(type), encoded]);
}
function writeGguf(path) {
  const entries = [
    kv("general.architecture", 8, "custom"),
    kv("custom.block_count", 4, 24),
    kv("custom.context_length", 4, 32768),
    kv("custom.embedding_length", 4, 2048),
    kv("custom.attention.head_count", 4, 16),
    kv("custom.attention.head_count_kv", 4, 2),
    kv("custom.attention.key_length", 4, 128),
    kv("custom.attention.value_length", 4, 128),
  ];
  // Pad the body so statSync reports a non-trivial weight size.
  writeFileSync(path, Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length), ...entries, Buffer.alloc(4 * 1024 * 1024)]));
}

const ENV_KEYS = ["LLAMA_CACHE", "LLAMACPP_MODEL", "LLAMACPP_MODEL_TIER_8", "LLAMACPP_MODEL_TIER_16", "LLAMACPP_MODEL_TIER_24", "LLAMACPP_MODEL_TIER_32", "APERIO_LOCAL_PERF_PROFILE"];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const roots = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// Point every RAM tier at `repoId` so getRecommendedModel() picks it regardless
// of the test host's real RAM, and cache-root at `cache` so resolveModelFacts()
// can inspect its GGUF.
function useCustomTier(repoId, cache) {
  process.env.LLAMA_CACHE = cache;
  for (const k of ["LLAMACPP_MODEL_TIER_8", "LLAMACPP_MODEL_TIER_16", "LLAMACPP_MODEL_TIER_24", "LLAMACPP_MODEL_TIER_32"]) {
    process.env[k] = repoId;
  }
}

// Build a Hugging Face snapshot cache holding one custom (non-catalog) GGUF.
function cacheWithModel(repoId) {
  const [org, name] = repoId.split(":")[0].split("/");
  const cache = mkdtempSync(join(tmpdir(), "aperio-specs-")); roots.push(cache);
  const repo = join(cache, `models--${org}--${name}`);
  const snap = join(repo, "snapshots", "abc");
  mkdirSync(join(repo, "refs"), { recursive: true });
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(repo, "refs", "main"), "abc");
  const blob = join(cache, "blob.gguf"); writeGguf(blob);
  symlinkSync(blob, join(snap, `${name}-Q4_K_M.gguf`));
  return cache;
}

describe("getSpecs — custom / non-catalog tier model", () => {
  test("uses an explicit first-install model instead of a larger RAM-tier recommendation", () => {
    const model = "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL";
    process.env.LLAMACPP_MODEL = model;
    for (const k of ["LLAMACPP_MODEL_TIER_8", "LLAMACPP_MODEL_TIER_16", "LLAMACPP_MODEL_TIER_24", "LLAMACPP_MODEL_TIER_32"]) {
      process.env[k] = "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL";
    }

    assert.equal(getSpecs().recommendedModelHf, model);
  });

  test("reports a real on-disk size for a cached custom model (resolveModelFacts, not factsForHf)", () => {
    const repoId = "org/Custom-GGUF:Q4_K_M";
    const cache = cacheWithModel(repoId);
    useCustomTier(repoId, cache);

    const specs = getSpecs();
    assert.equal(specs.recommendedModelHf, repoId, "recommends the configured custom tier model");
    // factsForHf() alone returned null here (not in MODEL_FACTS) → modelSizeGB
    // was null and the disk check silently passed. resolveModelFacts() inspects
    // the cached GGUF and reports its actual size.
    assert.equal(typeof specs.modelSizeGB, "number");
    assert.ok(specs.modelSizeGB > 0, `expected a positive model size, got ${specs.modelSizeGB}`);
  });

  test("enoughDisk is computed from the resolved size, not defaulted true on a missing size", () => {
    const repoId = "org/Custom-GGUF:Q4_K_M";
    const cache = cacheWithModel(repoId);
    useCustomTier(repoId, cache);

    const specs = getSpecs();
    // diskGB is the real free space on the test host; whatever it is, enoughDisk
    // must be the boolean result of comparing it against the resolved size + 2,
    // never a blanket true from an unknown size.
    if (specs.diskGB != null) {
      assert.equal(specs.enoughDisk, specs.diskGB > specs.modelSizeGB + 2);
    }
  });
});
