import os from "node:os";
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  llamacppContextWindow,
  llamacppCtxStatus,
  recommendContextLength,
  estimateKvBytesPerToken,
  resolveProvider,
  MODEL_FACTS,
  factsForHf,
  resolveModelFacts,
  isLocalProvider,
  isCloudProvider,
  resolvePerfProfile,
  getRecommendedModel,
  defaultLocalModel,
  PERF_PROFILES,
  recommendPerfFix,
  SLOW_GEN_TPS,
  machineCapacityPct,
  residentFootprintGB,
  MODEL_TIER_DEFAULTS,
  modelDisplayName,
} from "../../lib/providers/index.js";

mock.method(os, "totalmem", () => 32 * 1024 ** 3);

function minimalGgufHeader() {
  const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = value => Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const entry = (key, type, value) => Buffer.concat([str(key), u32(type), type === 8 ? str(value) : u32(value)]);
  const entries = [
    entry("general.architecture", 8, "test"),
    entry("test.block_count", 4, 2),
    entry("test.context_length", 4, 2048),
    entry("test.embedding_length", 4, 8),
    entry("test.attention.head_count", 4, 2),
    entry("test.attention.head_count_kv", 4, 1),
    entry("test.attention.key_length", 4, 4),
    entry("test.attention.value_length", 4, 4),
  ];
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length), ...entries]);
}

// Per-model context sizing: pick the largest num_ctx that fits RAM with headroom,
// so it can be passed as options.num_ctx on the native /api/chat call.
describe("estimateKvBytesPerToken", () => {
  test("computes layers × kv_heads × (k+v) × 2 from GGUF fields", () => {
    // qwen3-vl:8b — 36 × 8 × (128+128) × 2 = 147456
    assert.equal(estimateKvBytesPerToken({
      "general.architecture": "qwen3vl",
      "qwen3vl.block_count": 36,
      "qwen3vl.attention.head_count": 32,
      "qwen3vl.attention.head_count_kv": 8,
      "qwen3vl.attention.key_length": 128,
      "qwen3vl.attention.value_length": 128,
    }), 147456);
  });

  test("falls back to full head count when head_count_kv is missing", () => {
    // gemma4:12b — head_kv absent → 16 heads; 48 × 16 × (512+512) × 2
    assert.equal(estimateKvBytesPerToken({
      "general.architecture": "gemma4",
      "gemma4.block_count": 48,
      "gemma4.attention.head_count": 16,
      "gemma4.attention.key_length": 512,
      "gemma4.attention.value_length": 512,
    }), 48 * 16 * 1024 * 2);
  });

  test("derives head dim from embedding/head_count when key_length is missing", () => {
    // qwen2.5:3b — head_dim = 2048/16 = 128; 36 × 2 × (128+128) × 2 = 36864
    assert.equal(estimateKvBytesPerToken({
      "general.architecture": "qwen2",
      "qwen2.block_count": 36,
      "qwen2.attention.head_count": 16,
      "qwen2.attention.head_count_kv": 2,
      "qwen2.embedding_length": 2048,
    }), 36864);
  });

  test("returns null when there is not enough to estimate", () => {
    assert.equal(estimateKvBytesPerToken({}), null);
    assert.equal(estimateKvBytesPerToken({ "general.architecture": "x" }), null);
  });
});

describe("recommendContextLength", () => {
  test("caps at the model's trained max when the budget could fit more", () => {
    // 32 GB box, tiny 3B model (36 KB/token), model max only 32768 → max wins.
    assert.equal(recommendContextLength({
      modelMaxContext: 32768, weightsGB: 1.9, bytesPerToken: 36864, totalRamGB: 32,
    }), 32768);
  });

  test("targets the 82% policy when model max and budget are both larger", () => {
    // 32 GB, big-context model: neither the model max nor the hard ceiling binds,
    // so the window is the fit-fraction of the RAM budget (headroom kept below the
    // physical fit). With the conservative fallback reserve this snaps to 88064.
    assert.equal(recommendContextLength({
      modelMaxContext: 262144, weightsGB: 6.1, bytesPerToken: 147456, totalRamGB: 32,
    }, { ceiling: 131072 }), 88064);
  });

  test("small machines keep their full RAM fit — no headroom shave", () => {
    // Same model + budget, only the fit-fraction threshold differs. Below it the
    // window is the full RAM fit; at/above it, ~82% of it.
    const args = { modelMaxContext: 262144, weightsGB: 6.1, bytesPerToken: 147456, totalRamGB: 32 };
    const full   = recommendContextLength(args, { minFitRamGB: 64, ceiling: 262144 }); // 32 < 64 → full fit
    const shaved = recommendContextLength(args, { minFitRamGB: 16, ceiling: 262144 }); // 32 ≥ 16 → ~82%
    assert.ok(shaved < full, `expected fraction (${shaved}) < full fit (${full})`);
    assert.ok(shaved / full > 0.8 && shaved / full <= 0.83, `~82% of fit, got ${(shaved / full).toFixed(3)}`);
  });

  test("is bounded by the RAM budget for a heavy per-token model", () => {
    // gemma4:12b worst-case estimate (~1.5 MB/token): budget, not max/ceiling, binds.
    const n = recommendContextLength({
      modelMaxContext: 262144, weightsGB: 7.6, bytesPerToken: 48 * 16 * 1024 * 2, totalRamGB: 32,
    });
    assert.ok(n >= 2048 && n < 16384, `expected a small RAM-bound window, got ${n}`);
    assert.equal(n % 1024, 0);
  });

  test("returns the floor when there is no room to breathe", () => {
    assert.equal(recommendContextLength({
      modelMaxContext: 262144, weightsGB: 30, bytesPerToken: 147456, totalRamGB: 16,
    }), 2048);
  });

  test("uses the conservative default when bytesPerToken is unknown", () => {
    const n = recommendContextLength({ modelMaxContext: 262144, weightsGB: 6, totalRamGB: 32 });
    assert.ok(n >= 2048 && n % 1024 === 0);
  });

  test("knobs are tunable — a larger ceiling lets more context through", () => {
    const base = recommendContextLength(
      { modelMaxContext: 262144, weightsGB: 6.1, bytesPerToken: 147456, totalRamGB: 64 },
      { ceiling: 65536 },
    );
    const wide = recommendContextLength(
      { modelMaxContext: 262144, weightsGB: 6.1, bytesPerToken: 147456, totalRamGB: 64 },
      { ceiling: 131072 },
    );
    assert.equal(base, 65536);
    assert.ok(wide > base);
  });

  test("hybrid qwen3.5:9b reaches the balanced 131K ceiling on a 32 GB baseline", () => {
    const f = MODEL_FACTS["qwen3.5:9b"];
    assert.equal(recommendContextLength({
      modelMaxContext: f.maxContext,
      weightsGB: f.sizeGB,
      bytesPerToken: f.kvBytesPerToken,
      totalRamGB: 32,
    }), 131072);
  });
});

describe("residentFootprintGB", () => {
  test("adds weights, KV cache, fixed KV, and overhead", () => {
    const footprint = residentFootprintGB({
      sizeGB: 6,
      kvFixedGB: 0.5,
      kvBytesPerToken: 172032,
    }, 24576);
    assert.equal(footprint, 11.4375);
  });

  test("uses the conservative fallback KV cost for invalid facts", () => {
    assert.equal(residentFootprintGB({ sizeGB: 2, kvBytesPerToken: 0 }, 1024), 3.140625);
  });
});

// ── Provider locality classification ──────────────────────────────────────────
describe("isLocalProvider / isCloudProvider", () => {
  test("llamacpp is local", () => { assert.ok(isLocalProvider("llamacpp")); });
  test("llamacpp is NOT cloud", () => { assert.ok(!isCloudProvider("llamacpp")); });
  test("ollama is no longer local (removed llamacpp.md Phase 6)", () => { assert.ok(!isLocalProvider("ollama")); });
  test("anthropic is cloud", () => { assert.ok(isCloudProvider("anthropic")); });
  test("anthropic is NOT local", () => { assert.ok(!isLocalProvider("anthropic")); });
  test("deepseek is cloud", () => { assert.ok(isCloudProvider("deepseek")); });
  test("gemini is cloud", () => { assert.ok(isCloudProvider("gemini")); });
  test("claude-code is cloud", () => { assert.ok(isCloudProvider("claude-code")); });
  test("codex is cloud", () => { assert.ok(isCloudProvider("codex")); });
  test("case-insensitive: LLAMACPP is local", () => { assert.ok(isLocalProvider("LLAMACPP")); });
  test("empty string is not local", () => { assert.ok(!isLocalProvider("")); });
  test("null is not local", () => { assert.ok(!isLocalProvider(null)); });
  test("undefined is not local", () => { assert.ok(!isLocalProvider(undefined)); });
});

// ── machineCapacityPct — estimated model + KV footprint as % of RAM ───────────
describe("machineCapacityPct", () => {
  test("returns null when the served window is unknown", () => {
    assert.equal(machineCapacityPct("qwen2.5:3b", {}), null);
  });

  test("computes a percentage for a MODEL_FACTS tag key", () => {
    const pct = machineCapacityPct("qwen2.5:3b", { LLAMACPP_SERVE_CTX: "16384" });
    assert.equal(pct, 11);
  });

  test("resolves an hf repo[:quant] string via factsForHf", () => {
    const byTag = machineCapacityPct("qwen2.5:3b", { LLAMACPP_SERVE_CTX: "16384" });
    const byHf  = machineCapacityPct("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M", { LLAMACPP_SERVE_CTX: "16384" });
    assert.equal(byHf, byTag);
  });

  test("falls back to default facts for an unknown model", () => {
    const pct = machineCapacityPct("someone/custom-GGUF", { LLAMACPP_SERVE_CTX: "16384" });
    assert.equal(typeof pct, "number");
  });

  test("includes weights, so a larger model reports higher RAM at the same context", () => {
    const small = machineCapacityPct("qwen3.5:9b", { LLAMACPP_SERVE_CTX: "131072" });
    const large = machineCapacityPct("qwen3.6:35b-a3b-mtp", { LLAMACPP_SERVE_CTX: "131072" });
    assert.equal(small, 32);
    assert.equal(large, 78);
  });
});

// ── llamacppContextWindow / llamacppCtxStatus ──────────────────────────────────
// Mirrors the OLLAMA_NUM_CTX/OLLAMA_CONTEXT_LENGTH clamp-and-warn semantics for
// the successor env pair (LLAMACPP_CTX / LLAMACPP_SERVE_CTX), sharing the same
// genericCtxStatus/genericContextWindow implementation under the hood.
describe("llamacppContextWindow", () => {
  test("defaults to 32768 when nothing is set", () => {
    assert.equal(llamacppContextWindow({}), 32768);
  });

  test("uses LLAMACPP_CTX when no real window is known", () => {
    assert.equal(llamacppContextWindow({ LLAMACPP_CTX: "98304" }), 98304);
  });

  test("clamps to LLAMACPP_SERVE_CTX when the assumption is too large", () => {
    assert.equal(
      llamacppContextWindow({ LLAMACPP_CTX: "98304", LLAMACPP_SERVE_CTX: "32768" }),
      32768,
    );
  });

  test("keeps the smaller assumption when it already fits the real window", () => {
    assert.equal(
      llamacppContextWindow({ LLAMACPP_CTX: "16384", LLAMACPP_SERVE_CTX: "32768" }),
      16384,
    );
  });
});

describe("llamacppCtxStatus", () => {
  test("flags a mismatch and reports the clamped effective window", () => {
    assert.deepEqual(
      llamacppCtxStatus({ LLAMACPP_CTX: "98304", LLAMACPP_SERVE_CTX: "32768" }),
      { assumed: 98304, real: 32768, mismatch: true, effective: 32768 },
    );
  });

  test("no mismatch when the real window is unknown", () => {
    assert.deepEqual(
      llamacppCtxStatus({ LLAMACPP_CTX: "98304" }),
      { assumed: 98304, real: 0, mismatch: false, effective: 98304 },
    );
  });
});

// ── resolveProvider — llamacpp branch ──────────────────────────────────────────
describe("resolveProvider — llamacpp", () => {
  test("resolves llamacpp with defaults", () => {
    const p = resolveProvider({ name: "llamacpp" });
    assert.equal(p.name, "llamacpp");
    // When LLAMACPP_MODEL is unset the provider model must be the SAME RAM-tier
    // model the preset serves, not a fixed Qwen — otherwise capability detection
    // and alias routing (wiki refresh) key off a model the server never loaded.
    assert.equal(p.model, defaultLocalModel());
    assert.equal(p.requestModel, "aperio-main");
    assert.equal(p.baseURL, "http://127.0.0.1:8080/v1");
    assert.equal(p.llamacppBaseURL, "http://127.0.0.1:8080");
    assert.equal(typeof p.contextWindow, "number");
  });

  test("provider model matches the configured tier when LLAMACPP_MODEL is unset", () => {
    const saved = process.env.LLAMACPP_MODEL_TIER_32;
    const savedModel = process.env.LLAMACPP_MODEL;
    delete process.env.LLAMACPP_MODEL;
    process.env.LLAMACPP_MODEL_TIER_32 = "custom/tier32-GGUF:Q4_K_M";
    try {
      // os.totalmem is mocked to 32 GB at module scope → top tier.
      const p = resolveProvider({ name: "llamacpp" });
      assert.equal(p.model, "custom/tier32-GGUF:Q4_K_M");
      assert.equal(p.model, defaultLocalModel());
    } finally {
      if (saved === undefined) delete process.env.LLAMACPP_MODEL_TIER_32;
      else process.env.LLAMACPP_MODEL_TIER_32 = saved;
      if (savedModel === undefined) delete process.env.LLAMACPP_MODEL;
      else process.env.LLAMACPP_MODEL = savedModel;
    }
  });

  test("model override wins over the default", () => {
    const p = resolveProvider({ name: "llamacpp", model: "unsloth/Qwen3.5-4B-GGUF" });
    assert.equal(p.model, "unsloth/Qwen3.5-4B-GGUF");
  });

  test("LLAMACPP_MODEL env wins over the tier fallback", () => {
    const saved = process.env.LLAMACPP_MODEL;
    process.env.LLAMACPP_MODEL = "explicit/pinned-GGUF:Q4_K_M";
    try {
      assert.equal(resolveProvider({ name: "llamacpp" }).model, "explicit/pinned-GGUF:Q4_K_M");
    } finally {
      if (saved === undefined) delete process.env.LLAMACPP_MODEL;
      else process.env.LLAMACPP_MODEL = saved;
    }
  });
});

describe("defaultLocalModel — shared LLAMACPP_MODEL fallback", () => {
  test("returns the configured tier model (env wins over the registry default)", () => {
    const env = { LLAMACPP_MODEL_TIER_16: "custom/tier16-GGUF:Q4_K_M" };
    assert.equal(defaultLocalModel("balanced", { totalRamGB: 12 }, env), "custom/tier16-GGUF:Q4_K_M");
  });

  test("matches getRecommendedModel for the same inputs", () => {
    for (const gb of [4, 12, 20, 40]) {
      assert.equal(
        defaultLocalModel("balanced", { totalRamGB: gb }),
        getRecommendedModel("balanced", { totalRamGB: gb }),
      );
    }
  });
});

// ── MODEL_FACTS — hf-repo mapping (llamacpp.md Phase 3) ────────────────────────
describe("MODEL_FACTS — hf mapping", () => {
  test("every entry declares an hf repo[:quant] id and a dense|moe architecture", () => {
    for (const [key, facts] of Object.entries(MODEL_FACTS)) {
      assert.equal(typeof facts.hf, "string", `${key} is missing an hf id`);
      assert.match(facts.hf, /^[\w.-]+\/[\w.-]+(:[\w.-]+)?$/, `${key}'s hf id looks malformed: ${facts.hf}`);
      assert.ok(["dense", "moe"].includes(facts.architecture), `${key} has an unexpected architecture: ${facts.architecture}`);
    }
  });

  test("MoE models declare activeParams", () => {
    assert.equal(MODEL_FACTS["qwen3:30b-a3b"].architecture, "moe");
    assert.equal(MODEL_FACTS["qwen3:30b-a3b"].activeParams, 3);
    for (const [key, facts] of Object.entries(MODEL_FACTS)) {
      if (facts.architecture === "moe") assert.ok(facts.activeParams > 0, `${key} should declare its active parameter count`);
      else assert.equal(facts.activeParams, undefined, `${key} should not declare activeParams (dense)`);
    }
  });

  test("qwen2.5vl:7b matches the facts startLlamaCpp.js's DEFAULT_VLM_MODEL used pre-Phase-3", () => {
    const f = MODEL_FACTS["qwen2.5vl:7b"];
    assert.equal(f.hf, "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF");
    assert.equal(f.sizeGB, 6);
    assert.equal(f.maxContext, 32768);
    assert.equal(f.kvBytesPerToken, 172032);
  });
});

test("hybrid Qwen facts count only full-attention layers in per-token KV", () => {
  assert.equal(MODEL_FACTS["qwen3.5:9b"].kvBytesPerToken, 32768);
  assert.equal(MODEL_FACTS["qwen3.6:35b-a3b-mtp"].kvBytesPerToken, 22528);
  assert.equal(MODEL_FACTS["qwen3.6:35b-a3b-mtp"].sizeGB, 21.3);
});

describe("factsForHf", () => {
  test("finds the facts entry whose hf id matches", () => {
    const f = factsForHf("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");
    assert.equal(f, MODEL_FACTS["qwen2.5:3b"]);
  });

  test("returns null for an hf id not in MODEL_FACTS (custom user model)", () => {
    assert.equal(factsForHf("someone/custom-GGUF"), null);
  });
});

// ── resolvePerfProfile / getRecommendedModel — profiles (llamacpp.md Phase 4) ──
describe("resolvePerfProfile", () => {
  test("defaults to balanced when unset", () => {
    assert.equal(resolvePerfProfile({}), "balanced");
  });

  test("accepts every declared profile, case-insensitively and trimmed", () => {
    for (const p of PERF_PROFILES) {
      assert.equal(resolvePerfProfile({ APERIO_LOCAL_PERF_PROFILE: p.toUpperCase() }), p);
      assert.equal(resolvePerfProfile({ APERIO_LOCAL_PERF_PROFILE: ` ${p} ` }), p);
    }
  });

  test("falls back to balanced for an unrecognized value", () => {
    assert.equal(resolvePerfProfile({ APERIO_LOCAL_PERF_PROFILE: "ultra-turbo" }), "balanced");
  });
});

describe("getRecommendedModel — configurable RAM tiers", () => {
  const defaults = [
    "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    "unsloth/Qwen3.5-9B-GGUF:Q4_K_M",
    "unsloth/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL",
    "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL",
  ];

  test("maps RAM boundaries to the configured HF model string", () => {
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 8 }), defaults[0]);
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 12 }), defaults[1]);
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 16 }), defaults[1]);
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 20 }), defaults[2]);
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 24 }), defaults[2]);
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 40 }), "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL");
  });

  test("long-context uses the same model ladder as balanced (only ctx sizing differs)", () => {
    for (const gb of [64, 32, 16, 4]) {
      assert.equal(
        getRecommendedModel("long-context", { totalRamGB: gb }),
        getRecommendedModel("balanced", { totalRamGB: gb }),
      );
    }
  });

  test("profiles do not change the configured model choice", () => {
    for (const p of PERF_PROFILES) assert.equal(getRecommendedModel(p, { totalRamGB: 20 }), defaults[2]);
  });

  test("uses env overrides and treats RAM above 24 GB as the top tier", () => {
    const env = { LLAMACPP_MODEL_TIER_16: "custom/model-GGUF:Q4_K_M" };
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 12 }, env), "custom/model-GGUF:Q4_K_M");
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 0 }, env), defaults[0]);
    assert.equal(getRecommendedModel("balanced", { totalRamGB: 40 }, env), defaults[3]);
  });

  test("tier defaults come from the config registry", () => {
    assert.deepEqual(MODEL_TIER_DEFAULTS, {
      LLAMACPP_MODEL_TIER_8: defaults[0],
      LLAMACPP_MODEL_TIER_16: defaults[1],
      LLAMACPP_MODEL_TIER_24: defaults[2],
      LLAMACPP_MODEL_TIER_32: defaults[3],
    });
  });

  test("defaults profile to resolvePerfProfile() and hardware to the real host when omitted", (t) => {
    // t.mock (not the bare module-level `mock`) auto-restores after this test,
    // so it doesn't leak into other tests relying on the file's 32GB default.
    t.mock.method(os, "totalmem", () => 64 * 1024 ** 3);
    assert.equal(getRecommendedModel(), defaults[3]);
  });
});

test("modelDisplayName maps curated HF ids to short catalog names", () => {
  assert.equal(modelDisplayName("unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL"), "qwen3.6:35b-a3b-mtp");
  assert.equal(modelDisplayName("someone/Custom-GGUF:Q4_K_M"), "Custom-GGUF");
});

describe("resolveModelFacts", () => {
  test("falls back from unknown model to conservative generic facts", () => {
    const facts = resolveModelFacts("someone/custom-GGUF", { LLAMA_CACHE: "/definitely/not/a/cache" });
    assert.equal(facts.sizeGB, 8);
    assert.equal(facts.kvBytesPerToken, 524288);
  });

  test("uses the catalog for a curated HF model before download", () => {
    const facts = resolveModelFacts("unsloth/Qwen3.5-9B-GGUF:Q4_K_M", { LLAMA_CACHE: "/definitely/not/a/cache" });
    assert.equal(facts, MODEL_FACTS["qwen3.5:9b"]);
  });

  test("does not poison a later GGUF lookup with an earlier generic miss", () => {
    const root = mkdtempSync(join(tmpdir(), "aperio-facts-"));
    const model = "test-org/test-model-GGUF:Q4_K_M";
    const repoDir = join(root, "models--test-org--test-model-GGUF");
    const snapshotDir = join(repoDir, "snapshots", "revision");
    mkdirSync(snapshotDir, { recursive: true });
    mkdirSync(join(repoDir, "refs"), { recursive: true });
    writeFileSync(join(repoDir, "refs", "main"), "revision");
    // The first call is intentionally before the GGUF exists.
    const before = resolveModelFacts(model, { LLAMA_CACHE: root });
    assert.equal(before.source, undefined);
    writeFileSync(join(snapshotDir, "test-model-Q4_K_M.gguf"), minimalGgufHeader());
    const after = resolveModelFacts(model, { LLAMA_CACHE: root });
    assert.equal(after.source, "gguf");
    assert.equal(after.kvBytesPerToken, 32);
    rmSync(root, { recursive: true, force: true });
  });
});

// ── recommendPerfFix (llamacpp.md Phase 5 / issue #222) ─────────────────────
// Shared by the runtime slow-turn diagnostic (lib/agent/index.js) and
// `npm run local:bench` — both must agree on what "slow" means and which
// recommendation string to emit.
describe("recommendPerfFix", () => {
  test("returns null when there is no timings signal to judge", () => {
    assert.equal(recommendPerfFix({}), null);
    assert.equal(recommendPerfFix({ genTps: null }), null);
    assert.equal(recommendPerfFix({ genTps: NaN }), null);
  });

  test("acceptable throughput reports 'Throughput is acceptable.'", () => {
    assert.equal(recommendPerfFix({ genTps: SLOW_GEN_TPS }), "Throughput is acceptable.");
    assert.equal(recommendPerfFix({ genTps: SLOW_GEN_TPS + 20 }), "Throughput is acceptable.");
  });

  test("slow on a non-fast-low-vram profile suggests switching profile", () => {
    assert.equal(recommendPerfFix({ genTps: 2, profile: "balanced" }), "Try the fast-low-vram profile.");
    assert.equal(recommendPerfFix({ genTps: 2, profile: "quality" }), "Try the fast-low-vram profile.");
    assert.equal(recommendPerfFix({ genTps: 2 }), "Try the fast-low-vram profile.", "profile defaults to balanced");
  });

  test("slow on fast-low-vram with a large served context points at context size", () => {
    const hint = recommendPerfFix({ genTps: 2, profile: "fast-low-vram", servedCtx: 65536 });
    assert.match(hint, /context window is likely too high/i);
  });

  test("slow on fast-low-vram with a modest served context suggests a smaller model", () => {
    const hint = recommendPerfFix({ genTps: 2, profile: "fast-low-vram", servedCtx: 8192 });
    assert.match(hint, /smaller/i);
  });

  test("slow on fast-low-vram with no servedCtx signal falls to the smaller-model hint (never crashes on missing data)", () => {
    const hint = recommendPerfFix({ genTps: 2, profile: "fast-low-vram" });
    assert.match(hint, /smaller/i);
  });
});
