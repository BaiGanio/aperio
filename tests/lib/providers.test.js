import os from "node:os";
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  ollamaContextWindow,
  ollamaCtxStatus,
  llamacppContextWindow,
  llamacppCtxStatus,
  recommendContextLength,
  estimateKvBytesPerToken,
  recommendServeContextLength,
  resolveProvider,
  MODEL_FACTS,
  factsForHf,
  isLocalProvider,
  isCloudProvider,
} from "../../lib/providers/index.js";

mock.method(os, "totalmem", () => 32 * 1024 ** 3);

// #2 — the app talks to Ollama over /v1 (which can't set num_ctx), so
// OLLAMA_NUM_CTX is only the trim-math assumption. When it exceeds Ollama's real
// serving window (OLLAMA_CONTEXT_LENGTH), capToolResults over-keeps and the
// prompt is silently truncated. ollamaContextWindow clamps to the real window.

describe("ollamaContextWindow", () => {
  test("defaults to 32768 when nothing is set", () => {
    assert.equal(ollamaContextWindow({}), 32768);
  });

  test("uses OLLAMA_NUM_CTX when no real window is known", () => {
    assert.equal(ollamaContextWindow({ OLLAMA_NUM_CTX: "98304" }), 98304);
  });

  test("clamps to OLLAMA_CONTEXT_LENGTH when the assumption is too large", () => {
    assert.equal(
      ollamaContextWindow({ OLLAMA_NUM_CTX: "98304", OLLAMA_CONTEXT_LENGTH: "32768" }),
      32768,
    );
  });

  test("keeps the smaller assumption when it already fits the real window", () => {
    assert.equal(
      ollamaContextWindow({ OLLAMA_NUM_CTX: "16384", OLLAMA_CONTEXT_LENGTH: "32768" }),
      16384,
    );
  });
});

// #182 — ollamaCtxStatus is the shared report used by both the clamp warning and
// the config diagnostics; ollamaContextWindow returns its `effective` value.
describe("ollamaCtxStatus", () => {
  test("flags a mismatch and reports the clamped effective window", () => {
    assert.deepEqual(
      ollamaCtxStatus({ OLLAMA_NUM_CTX: "98304", OLLAMA_CONTEXT_LENGTH: "32768" }),
      { assumed: 98304, real: 32768, mismatch: true, effective: 32768 },
    );
  });

  test("no mismatch when the real window is unknown", () => {
    assert.deepEqual(
      ollamaCtxStatus({ OLLAMA_NUM_CTX: "98304" }),
      { assumed: 98304, real: 0, mismatch: false, effective: 98304 },
    );
  });
});

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
    // physical fit). fit ≈ 108.5k → 82% ≈ 89.0k → snapped down to 88064.
    assert.equal(recommendContextLength({
      modelMaxContext: 262144, weightsGB: 6.1, bytesPerToken: 147456, totalRamGB: 32,
    }, { ceiling: 131072 }), 88064);
  });

  test("small machines keep their full RAM fit — no headroom shave", () => {
    // Same model + budget, only the fit-fraction threshold differs. Below it the
    // window is the full RAM fit; at/above it, ~82% of it.
    const args = { modelMaxContext: 262144, weightsGB: 6.1, bytesPerToken: 147456, totalRamGB: 32 };
    const full   = recommendContextLength(args, { minFitRamGB: 64, ceiling: 131072 }); // 32 < 64 → full fit
    const shaved = recommendContextLength(args, { minFitRamGB: 16, ceiling: 131072 }); // 32 ≥ 16 → ~82%
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

  test("uses the 82% budget for qwen3.5:9b on a 32 GB baseline", () => {
    const f = MODEL_FACTS["qwen3.5:9b"];
    assert.equal(recommendContextLength({
      modelMaxContext: f.maxContext,
      weightsGB: f.sizeGB,
      bytesPerToken: f.kvBytesPerToken,
      totalRamGB: 32,
    }), 23552);
  });
});

// recommendServeContextLength picks the OLLAMA_CONTEXT_LENGTH the server is
// spawned with, before Ollama is up, from the selected model's static facts.
describe("recommendServeContextLength", () => {
  test("an explicit OLLAMA_CONTEXT_LENGTH always wins", () => {
    assert.equal(recommendServeContextLength({ OLLAMA_CONTEXT_LENGTH: "12345", OLLAMA_MODEL: "gemma4:12b" }), "12345");
  });

  test("falls back to OLLAMA_NUM_CTX when the server window is not pinned", () => {
    assert.equal(recommendServeContextLength({ OLLAMA_NUM_CTX: "4096", OLLAMA_MODEL: "gemma4:12b" }), "4096");
  });

  test("computes a tidy token count for a known model when nothing is set", () => {
    const n = Number(recommendServeContextLength({ OLLAMA_MODEL: "qwen2.5:3b" }));
    assert.ok(Number.isInteger(n) && n >= 2048 && n % 1024 === 0, `got ${n}`);
  });

  test("uses the qwen3.5:9b model facts when nothing is set", () => {
    const n = Number(recommendServeContextLength({ OLLAMA_MODEL: "qwen3.5:9b" }));
    assert.equal(n, 23552);
  });

  test("sizes a dense-cache model smaller than a light one on the same machine", () => {
    // gemma4:12b is ~1.5 MB/token vs qwen2.5:3b at ~36 KB — the heavy model
    // must get the smaller (or equal) server window, never a larger one.
    const heavy = Number(recommendServeContextLength({ OLLAMA_MODEL: "gemma4:12b" }));
    const light = Number(recommendServeContextLength({ OLLAMA_MODEL: "qwen2.5:3b" }));
    assert.ok(heavy <= light, `expected heavy(${heavy}) <= light(${light})`);
  });
});

// ── Provider locality classification ──────────────────────────────────────────
describe("isLocalProvider / isCloudProvider", () => {
  test("ollama is local", () => { assert.ok(isLocalProvider("ollama")); });
  test("ollama is NOT cloud", () => { assert.ok(!isCloudProvider("ollama")); });
  test("llamacpp is local", () => { assert.ok(isLocalProvider("llamacpp")); });
  test("llamacpp is NOT cloud", () => { assert.ok(!isCloudProvider("llamacpp")); });
  test("anthropic is cloud", () => { assert.ok(isCloudProvider("anthropic")); });
  test("anthropic is NOT local", () => { assert.ok(!isLocalProvider("anthropic")); });
  test("deepseek is cloud", () => { assert.ok(isCloudProvider("deepseek")); });
  test("gemini is cloud", () => { assert.ok(isCloudProvider("gemini")); });
  test("claude-code is cloud", () => { assert.ok(isCloudProvider("claude-code")); });
  test("codex is cloud", () => { assert.ok(isCloudProvider("codex")); });
  test("case-insensitive: OLLAMA is local", () => { assert.ok(isLocalProvider("OLLAMA")); });
  test("case-insensitive: LLAMACPP is local", () => { assert.ok(isLocalProvider("LLAMACPP")); });
  test("empty string is not local", () => { assert.ok(!isLocalProvider("")); });
  test("null is not local", () => { assert.ok(!isLocalProvider(null)); });
  test("undefined is not local", () => { assert.ok(!isLocalProvider(undefined)); });
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
    assert.equal(p.model, "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");
    assert.equal(p.baseURL, "http://127.0.0.1:8080/v1");
    assert.equal(p.llamacppBaseURL, "http://127.0.0.1:8080");
    assert.equal(typeof p.contextWindow, "number");
  });

  test("model override wins over the default", () => {
    const p = resolveProvider({ name: "llamacpp", model: "unsloth/Qwen3.5-4B-GGUF" });
    assert.equal(p.model, "unsloth/Qwen3.5-4B-GGUF");
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

  test("only the MoE model declares activeParams", () => {
    assert.equal(MODEL_FACTS["qwen3:30b-a3b"].architecture, "moe");
    assert.equal(MODEL_FACTS["qwen3:30b-a3b"].activeParams, 3);
    for (const [key, facts] of Object.entries(MODEL_FACTS)) {
      if (key === "qwen3:30b-a3b") continue;
      assert.equal(facts.activeParams, undefined, `${key} should not declare activeParams (dense)`);
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

describe("factsForHf", () => {
  test("finds the facts entry whose hf id matches", () => {
    const f = factsForHf("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M");
    assert.equal(f, MODEL_FACTS["qwen2.5:3b"]);
  });

  test("returns null for an hf id not in MODEL_FACTS (custom user model)", () => {
    assert.equal(factsForHf("someone/custom-GGUF"), null);
  });
});
