// tests/lib/helpers/startLlamaCpp.test.js
import { describe, test, afterEach, before, after } from "node:test";
import { createHash } from "crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync, appendFileSync, utimesSync } from "fs";
import assert from "node:assert/strict";
import {
  buildModelsPreset,
  collectExtraLlamaCppModels,
  mainPlusVlmFit,
  vlmPresetMode,
  ensureLlamaCpp,
  presetModelIds,
  getLlamaCppPid,
  killByPid,
  stopLlamaCpp,
  beginSessionLog,
  endSessionLog,
  appendSessionLog,
  pumpServerLogTee,
  deleteServerLog,
  pruneServerLogs,
} from "../../../lib/helpers/startLlamaCpp.js";
import { recommendContextLength, MODEL_FACTS, resolveModelFacts } from "../../../lib/providers/index.js";

// ensureLlamaCpp() takes an injectable _spawn (default: the real
// child_process.spawn) instead of relying on mock.method() interception —
// unlike Ollama, llama-server IS commonly installed on this project's dev
// machines (it's the whole point of this module), so a missed mock here would
// silently launch a real background server during `npm test`.
function fakeSpawn(pid = 99999) {
  return () => ({ on: () => {}, unref: () => {}, pid });
}

test("preset ownership includes aliases and underlying hf repos", () => {
  const ids = presetModelIds(buildModelsPreset({ LLAMACPP_MODEL: DEFAULT_MODEL }, {}));
  assert.ok(ids.has("aperio-main"));
  assert.ok(ids.has("Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M"));
  assert.ok(ids.has("aperio-vlm"));
  assert.ok(ids.has("ggml-org/Qwen2.5-VL-7B-Instruct-GGUF"));
});

// A fake kill that returns the given value (true = killed, false = failed).
function fakeKill(result) {
  return async () => result;
}

const originalFetch = globalThis.fetch;
const ENV_KEYS = ["LLAMACPP_MODEL", "LLAMACPP_VLM_MODEL", "LLAMACPP_VLM_MMPROJ", "LLAMACPP_SERVE_CTX", "LLAMACPP_CTX",
  "LLAMACPP_MODEL_TIER_8", "LLAMACPP_MODEL_TIER_16", "LLAMACPP_MODEL_TIER_24", "LLAMACPP_MODEL_TIER_32"];
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
const STATE_FILE = "./var/llamacpp/state.json";

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Clean up state file so reconciliation tests don't pollute each other
  try { if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE); } catch {}
});

function mockFetchSequence(...responses) {
  let i = 0;
  globalThis.fetch = async () => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return res;
  };
}

// Return a fetch mock whose json() method returns the given data.
function jsonResponse(data) {
  return { ok: true, json: async () => data };
}

const DEFAULT_MODEL = "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M";

// =============================================================================
describe("buildModelsPreset", () => {

  test("collects the configured llama.cpp wiki refresh model", () => {
    assert.deepEqual(
      collectExtraLlamaCppModels({ WIKI_REFRESH_PROVIDER: "llamacpp:foo/bar-GGUF:Q4_K_M" }),
      ["foo/bar-GGUF:Q4_K_M"],
    );
  });

  test("ignores unset, empty, and non-llama.cpp wiki refresh providers", () => {
    assert.deepEqual(collectExtraLlamaCppModels({}), []);
    assert.deepEqual(collectExtraLlamaCppModels({ WIKI_REFRESH_PROVIDER: "llamacpp:" }), []);
    assert.deepEqual(collectExtraLlamaCppModels({ WIKI_REFRESH_PROVIDER: "anthropic:claude-x" }), []);
  });

  test("appends one extra wiki model section with model facts", () => {
    const model = "foo/bar-GGUF:Q4_K_M";
    const ini = buildModelsPreset({ LLAMACPP_MODEL: DEFAULT_MODEL, WIKI_REFRESH_PROVIDER: `llamacpp:${model}` }, { totalRamGB: 64 });
    assert.match(ini, /\[foo\/bar-GGUF:Q4_K_M\]/);
    assert.match(ini, /\[foo\/bar-GGUF:Q4_K_M\]\nhf-repo = foo\/bar-GGUF:Q4_K_M\nctx-size = \d+/);
    assert.equal(ini.match(/^\[[^*].*\]$/gm)?.length, 3);
  });

  test("dedupes a wiki refresh model already served as the main model", () => {
    const ini = buildModelsPreset({
      LLAMACPP_MODEL: DEFAULT_MODEL,
      WIKI_REFRESH_PROVIDER: `llamacpp:${DEFAULT_MODEL}`,
    }, { totalRamGB: 64 });
    assert.equal(ini.match(/^\[[^*].*\]$/gm)?.length, 2);
    assert.equal(ini.match(new RegExp(`hf-repo = ${DEFAULT_MODEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "g"))?.length, 1);
  });

  test("fast-low-vram keeps models-max at 1 and applies cache settings to an extra model", () => {
    const model = "foo/bar-GGUF:Q4_K_M";
    const ini = buildModelsPreset({
      APERIO_LOCAL_PERF_PROFILE: "fast-low-vram",
      LLAMACPP_MODEL: DEFAULT_MODEL,
      WIKI_REFRESH_PROVIDER: `llamacpp:${model}`,
    }, { totalRamGB: 64 });
    assert.equal(ini.match(/models-max = 1/g)?.length, 1);
    assert.match(ini, /\[foo\/bar-GGUF:Q4_K_M\][\s\S]*?cache-type-k = q8_0\ncache-type-v = q8_0/);
  });

  test("emits a [*] global section with jinja enabled", () => {
    const ini = buildModelsPreset({}, {});
    assert.match(ini, /^\[\*\]\njinja = true\nparallel = 1/);
  });

  test("defaults to the curated main + VLM models", () => {
    const ini = buildModelsPreset({}, {});
    assert.match(ini, /\[aperio-main\]/);
    assert.match(ini, /hf-repo = unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL/);
    assert.match(ini, /\[aperio-vlm\]/);
    assert.match(ini, /hf-repo = ggml-org\/Qwen2\.5-VL-7B-Instruct-GGUF/);
  });

  test("LLAMACPP_MODEL / LLAMACPP_VLM_MODEL keep stable aliases and override hf-repo names", () => {
    const ini = buildModelsPreset({
      LLAMACPP_MODEL: "my-org/my-model-GGUF:Q8_0",
      LLAMACPP_VLM_MODEL: "my-org/my-vlm-GGUF",
    }, {});
    assert.match(ini, /\[aperio-main\]/);
    assert.match(ini, /hf-repo = my-org\/my-model-GGUF:Q8_0/);
    assert.match(ini, /\[aperio-vlm\]/);
    assert.match(ini, /hf-repo = my-org\/my-vlm-GGUF/);
  });

  test("tier overrides supplied to buildModelsPreset flow into the default model pick", () => {
    const ini = buildModelsPreset({
      LLAMACPP_MODEL_TIER_16: "custom/tier-model-GGUF:Q4_K_M",
    }, { totalRamGB: 12, modelCacheDir: "/definitely/not/a/cache" });
    assert.match(ini, /hf-repo = custom\/tier-model-GGUF:Q4_K_M/);
  });

  test("omits mmproj when LLAMACPP_VLM_MMPROJ is unset (llama-server auto-detects it)", () => {
    const ini = buildModelsPreset({}, {});
    assert.doesNotMatch(ini, /mmproj/);
  });

  test("emits mmproj on the VLM entry only when LLAMACPP_VLM_MMPROJ is set", () => {
    const ini = buildModelsPreset({ LLAMACPP_VLM_MMPROJ: "mmproj-file.gguf" }, {});
    const mmprojMatches = ini.match(/mmproj = mmproj-file\.gguf/g);
    assert.equal(mmprojMatches?.length, 1, "mmproj should appear exactly once");
    const vlmHeaderIdx = ini.indexOf("[aperio-vlm]");
    const mainHeaderIdx = ini.indexOf("[aperio-main]");
    const mmprojIdx = ini.indexOf("mmproj = mmproj-file.gguf");
    assert.ok(mmprojIdx > vlmHeaderIdx && vlmHeaderIdx > mainHeaderIdx, "mmproj line should fall within the VLM section, after the main section");
  });

  test("LLAMACPP_SERVE_CTX pins ctx-size for both models, skipping RAM-based sizing", () => {
    const ini = buildModelsPreset({ LLAMACPP_MODEL: DEFAULT_MODEL, LLAMACPP_SERVE_CTX: "4096" }, { totalRamGB: 4 });
    const ctxLines = ini.match(/ctx-size = \d+/g);
    assert.deepEqual(ctxLines, ["ctx-size = 4096", "ctx-size = 4096"]);
  });

  test("ctx-size never exceeds each model's max context regardless of RAM", () => {
    const ini = buildModelsPreset({}, { totalRamGB: 512 });
    const ctxLines = ini.match(/ctx-size = (\d+)/g).map(l => parseInt(l.split(" = ")[1], 10));
    for (const ctx of ctxLines) assert.ok(ctx <= 262144, `ctx-size ${ctx} should be capped at model max context`);
  });

  test("small RAM sizes down toward the floor", () => {
    const ini = buildModelsPreset({}, { totalRamGB: 4 });
    const ctxLines = ini.match(/ctx-size = (\d+)/g).map(l => parseInt(l.split(" = ")[1], 10));
    for (const ctx of ctxLines) assert.ok(ctx <= 4096, `expected a small window on a 4GB machine, got ${ctx}`);
  });

  test("uses curated hybrid facts conservatively when no inspectable cache is supplied", () => {
    const noCache = { totalRamGB: 32, modelCacheDir: "/definitely/not/a/cache" };
    const q35 = buildModelsPreset({ LLAMACPP_MODEL: "unsloth/Qwen3.5-9B-GGUF:Q4_K_M" }, noCache);
    const q36 = buildModelsPreset({ LLAMACPP_MODEL: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:Q4_K_XL" }, noCache);
    assert.match(q35, /\[aperio-main\][\s\S]*?ctx-size = 131072/);
    assert.match(q36, /\[aperio-main\][\s\S]*?ctx-size = 2048/);
  });

  test("VLM alias caps at 24576 even on a huge machine that would otherwise RAM-fit it much larger", () => {
    // A custom VLM model with no curated entry falls to GENERIC_MODEL_FACTS
    // (maxContext 131072) — without the bridge ceiling, 512GB of RAM would
    // fit it right up near that, reproducing the two-large-models-resident
    // Metal OOM this test guards against.
    const ini = buildModelsPreset({ LLAMACPP_VLM_MODEL: "my-org/custom-vlm-GGUF" }, { totalRamGB: 512 });
    const vlmSection = ini.slice(ini.indexOf("[aperio-vlm]"));
    assert.match(vlmSection, /ctx-size = 24576/);
  });

  test("VLM alias still sizes down below the bridge ceiling on a genuinely tight machine", () => {
    const ini = buildModelsPreset({ LLAMACPP_MODEL: DEFAULT_MODEL }, { totalRamGB: 4 });
    const vlmSection = ini.slice(ini.indexOf("[aperio-vlm]"));
    const ctx = parseInt(vlmSection.match(/ctx-size = (\d+)/)[1], 10);
    assert.ok(ctx < 24576, `expected the VLM window to shrink below the bridge ceiling on 4GB RAM, got ${ctx}`);
  });

  test("main-model role is unaffected by the VLM bridge ceiling: pointing LLAMACPP_MODEL at the VLM's own hf id gets the full RAM-fit window", () => {
    const ini = buildModelsPreset({ LLAMACPP_MODEL: "my-org/custom-vlm-GGUF" }, { totalRamGB: 512 });
    const mainSection = ini.slice(ini.indexOf("[aperio-main]"), ini.indexOf("[aperio-vlm]"));
    assert.doesNotMatch(mainSection, /ctx-size = 24576/);
  });

  test("omits the bridge when the main model has native vision", () => {
    const ini = buildModelsPreset({
      LLAMACPP_MODEL: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
    }, { totalRamGB: 64 });
    assert.match(ini, /\[aperio-main\]/);
    assert.doesNotMatch(ini, /\[aperio-vlm\]/);
    assert.doesNotMatch(ini, /models-max/);
  });

  test("caps the router at one resident model when the measured pair does not fit", () => {
    const env = {
      LLAMACPP_MODEL: MODEL_FACTS["qwen3.6:35b-a3b-mtp"].hf,
      LLAMACPP_VLM_MODEL: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
    };
    const ini = buildModelsPreset(env, { totalRamGB: 16 });
    assert.match(ini, /^\[\*\][\s\S]*models-max = 1/m);
    assert.equal(ini.match(/models-max = 1/g)?.length, 1);
    assert.match(ini, /\[aperio-main\]/);
    assert.match(ini, /\[aperio-vlm\]/);
    assert.equal(vlmPresetMode(env.LLAMACPP_MODEL, env.LLAMACPP_VLM_MODEL, env, { totalRamGB: 16 }), "swap mode (main+VLM exceed RAM)");
  });

  test("keeps both models resident when their served footprints fit", () => {
    const env = {
      LLAMACPP_MODEL: MODEL_FACTS["qwen3.6:35b-a3b-mtp"].hf,
      LLAMACPP_VLM_MODEL: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
    };
    assert.equal(mainPlusVlmFit(env.LLAMACPP_MODEL, env.LLAMACPP_VLM_MODEL, env, { totalRamGB: 64 }), true);
    const ini = buildModelsPreset(env, { totalRamGB: 64 });
    assert.doesNotMatch(ini, /models-max/);
    assert.match(ini, /\[aperio-main\][\s\S]*\[aperio-vlm\]/);
  });
});

// =============================================================================
// Perf profiles (llamacpp.md Phase 4) — APERIO_LOCAL_PERF_PROFILE flows
// through env into buildModelsPreset via resolvePerfProfile.
describe("buildModelsPreset — perf profiles", () => {

  test("balanced (default, no env var set): identical to pre-Phase-4 output", () => {
    const ini = buildModelsPreset({}, { totalRamGB: 64 });
    assert.doesNotMatch(ini, /models-max|flash-attn|cache-type|n-cpu-moe/);
    assert.match(ini, /hf-repo = unsloth\/Qwen3\.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL/, "balanced uses the configured RAM-tier model");
  });

  test("fast-low-vram: emits models-max=1 and flash-attn in the global section", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 64 });
    assert.match(ini, /^\[\*\]\njinja = true\nparallel = 1\nmodels-max = 1\nflash-attn = true\n/);
  });

  test("fast-low-vram: emits quantized KV cache flags on every model section", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 64 });
    const kMatches = ini.match(/cache-type-k = q8_0/g);
    const vMatches = ini.match(/cache-type-v = q8_0/g);
    assert.equal(kMatches?.length, 2, "both main + VLM sections should quantize the K cache");
    assert.equal(vMatches?.length, 2, "both main + VLM sections should quantize the V cache");
  });

  test("fast-low-vram: keeps Flash Attention enabled for Gemma 4 with quantized KV cache", () => {
    const ini = buildModelsPreset({
      APERIO_LOCAL_PERF_PROFILE: "fast-low-vram",
      LLAMACPP_MODEL: "unsloth/gemma-4-E4B-it-qat-GGUF:Q4_K_XL",
    }, { totalRamGB: 16 });
    const mainSection = ini.slice(ini.indexOf("[aperio-main]"), ini.indexOf("[aperio-vlm]"));
    assert.match(ini, /^flash-attn = true$/m, "fast profile keeps the global optimization enabled");
    assert.doesNotMatch(mainSection, /flash-attn = false/, "Gemma 4 must not disable Flash Attention with q8 V-cache");
    assert.match(mainSection, /cache-type-v = q8_0/, "Gemma 4 uses the compatible quantized V-cache");
  });

  test("fast-low-vram: prefers the MoE model by default at 24GB RAM (below balanced's 48GB rung) and emits n-cpu-moe on it", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 24 });
    assert.match(ini, /hf-repo = unsloth\/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL/);
    assert.match(ini, /n-cpu-moe = 999/);
    // Only one n-cpu-moe line: the VLM model (dense) must not get it.
    assert.equal(ini.match(/n-cpu-moe/g)?.length, 1);
  });

  test("fast-low-vram: an explicit LLAMACPP_MODEL still wins over the MoE-preferred default", () => {
    const ini = buildModelsPreset(
      { APERIO_LOCAL_PERF_PROFILE: "fast-low-vram", LLAMACPP_MODEL: "my-org/pinned-GGUF" },
      { totalRamGB: 24 },
    );
    assert.match(ini, /hf-repo = my-org\/pinned-GGUF/);
    assert.doesNotMatch(ini, /Qwen3-30B-A3B/);
  });

  test("fast-low-vram: ctx ceiling is lower than balanced's on a huge-RAM machine", () => {
    const fast = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram", LLAMACPP_MODEL: "x/y" }, { totalRamGB: 512 });
    const balanced = buildModelsPreset({ LLAMACPP_MODEL: "x/y" }, { totalRamGB: 512 });
    const fastCtx = parseInt(fast.match(/ctx-size = (\d+)/)[1], 10);
    const balancedCtx = parseInt(balanced.match(/ctx-size = (\d+)/)[1], 10);
    assert.ok(fastCtx <= 16384, `fast-low-vram ctx ${fastCtx} should be capped at 16384`);
    assert.ok(fastCtx < balancedCtx);
  });

  test("long-context: raises the ctx ceiling above balanced's on a huge-RAM machine (model with a 262144 max context)", () => {
    // A generic/unrecognized model's own maxContext (131072, GENERIC_MODEL_FACTS)
    // would cap both profiles at the same value regardless of ceiling — use a
    // curated model whose trained max (262144) is actually big enough for the
    // raised ceiling to matter.
    const model = MODEL_FACTS["qwen3.5:9b"].hf; // curated, trained max 262144
    const long = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "long-context", LLAMACPP_MODEL: model }, { totalRamGB: 512 });
    const balanced = buildModelsPreset({ LLAMACPP_MODEL: model }, { totalRamGB: 512 });
    const longCtx = parseInt(long.match(/ctx-size = (\d+)/)[1], 10);
    const balancedCtx = parseInt(balanced.match(/ctx-size = (\d+)/)[1], 10);
    assert.ok(longCtx > balancedCtx, `expected long-context (${longCtx}) > balanced (${balancedCtx})`);
    assert.doesNotMatch(long, /models-max|flash-attn|cache-type|n-cpu-moe/, "long-context stays on f16 after the b9938 Metal q8 matrix failed the throughput gate");
  });

  test("long-context keeps a native-vision main model on the default f16 cache", () => {
    const ini = buildModelsPreset({
      APERIO_LOCAL_PERF_PROFILE: "long-context",
      LLAMACPP_MODEL: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF",
    }, { totalRamGB: 64 });
    assert.doesNotMatch(ini, /flash-attn|cache-type/);
    assert.doesNotMatch(ini, /\[aperio-vlm\]/);
  });

  test("all profiles omit speculative cache and context-shifting flags", () => {
    for (const profile of ["balanced", "fast-low-vram", "long-context", "quality"]) {
      const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: profile }, { totalRamGB: 64 });
      assert.doesNotMatch(ini, /shift-kv|context-shift|paged|cache-reuse/i, profile);
    }
  });

  test("long-context sizes with the same f16 policy it emits", () => {
    const model = MODEL_FACTS["qwen3.5:9b"].hf;
    const facts = resolveModelFacts(model, { LLAMA_CACHE: "/definitely/not/a/cache" });
    for (const totalRamGB of [8, 16, 24, 32, 64]) {
      const ini = buildModelsPreset(
        { APERIO_LOCAL_PERF_PROFILE: "long-context", LLAMACPP_MODEL: model },
        { totalRamGB, modelCacheDir: "/definitely/not/a/cache" },
      );
      const actual = parseInt(ini.match(/ctx-size = (\d+)/)[1], 10);
      const expected = recommendContextLength({
        modelMaxContext: facts.maxContext,
        weightsGB: facts.sizeGB,
        fixedKvGB: facts.kvFixedGB ?? 0,
        bytesPerToken: facts.kvBytesPerToken,
        totalRamGB,
      }, { ceiling: 262144, fitFraction: 0.90 });
      assert.equal(actual, expected, `mismatch at totalRamGB=${totalRamGB}`);
    }
  });

  test("long-context keeps the f16 co-residency decision while fast-low-vram uses q8", () => {
    const main = MODEL_FACTS["qwen3.6:35b-a3b-mtp"].hf;
    const vlm = MODEL_FACTS["qwen2.5vl:7b"].hf;
    const base = { LLAMACPP_SERVE_CTX: "24576" };
    assert.equal(mainPlusVlmFit(main, vlm, { ...base, APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 46 }), true);
    assert.equal(mainPlusVlmFit(main, vlm, { ...base, APERIO_LOCAL_PERF_PROFILE: "long-context" }, { totalRamGB: 46 }), false);
  });

  test("long-context: model pick is unchanged from balanced (only ctx sizing differs)", () => {
    const long = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "long-context" }, { totalRamGB: 24 });
    assert.match(long, /hf-repo = unsloth\/gemma-4-26B-A4B-it-GGUF:UD-Q4_K_XL/, "long-context keeps the configured model, same as balanced");
  });

  test("quality: picks a bigger default model where the plain fixed default (used unchanged by balanced) would not", () => {
    // balanced's own buildModelsPreset fallback is a fixed small model
    // regardless of RAM (RAM-tiering normally happens once, at wizard time,
    // via getRecommendedModel() writing LLAMACPP_MODEL into .env) — quality is
    // the profile that reaches into that ladder itself, so it diverges from
    // the fixed default at a RAM tier where the ladder recommends something bigger.
    const quality = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "quality" }, { totalRamGB: 16 });
    assert.match(quality, /hf-repo = unsloth\/Qwen3\.5-9B-GGUF:Q4_K_M/);
    // Gemma 4 is natively vision-capable, so the preset omits the dedicated
    // VLM rather than putting two resident models into swap mode.
    assert.doesNotMatch(quality, /\[aperio-vlm\]/, "native-vision Gemma 4 does not need a dedicated VLM");
    assert.doesNotMatch(quality, /flash-attn|cache-type|n-cpu-moe/, "quality has no fast-low-vram-style flags");
  });

  test("quality: an explicit LLAMACPP_MODEL still wins over the bigger-model default", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "quality", LLAMACPP_MODEL: "my-org/pinned-GGUF" }, { totalRamGB: 16 });
    assert.match(ini, /hf-repo = my-org\/pinned-GGUF/);
  });

  test("an unrecognized profile value falls back to balanced behavior", () => {
    const bogus    = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "ultra-turbo" }, { totalRamGB: 64 });
    const balanced = buildModelsPreset({}, { totalRamGB: 64 });
    assert.equal(bogus, balanced);
  });
});

// =============================================================================
// Sizing parity: buildModelsPreset must size the main model exactly the way
// recommendContextLength would when given the same facts — it's the same pure
// function underneath, just fed llama.cpp's local facts table instead of
// providers/index.js's Ollama-tag-keyed MODEL_FACTS.
describe("buildModelsPreset — sizing parity with recommendContextLength", () => {

  test("main model ctx-size matches a direct recommendContextLength call at several RAM sizes", () => {
    // Derive the expected window from the SAME facts serveCtxFor resolves, so the
    // parity holds regardless of the current default roster or whether the GGUF
    // is cached locally (gguf facts carry the reserveGB:4/0.15 override that a
    // curated-only entry does not). balanced profile => cacheScale 1, no ceiling.
    const hf = MODEL_FACTS["gemma4:e4b-qat"].hf;
    for (const totalRamGB of [4, 8, 16, 24, 48, 64]) {
      const facts = resolveModelFacts(hf, {});
      const ini = buildModelsPreset({ LLAMACPP_MODEL: hf }, { totalRamGB });
      const mainCtx = parseInt(ini.match(/ctx-size = (\d+)/)[1], 10);
      const expected = recommendContextLength({
        modelMaxContext: facts.maxContext,
        weightsGB: facts.sizeGB,
        fixedKvGB: facts.kvFixedGB ?? 0,
        bytesPerToken: facts.kvBytesPerToken,
        totalRamGB,
      }, facts.source === "gguf" ? { reserveGB: 4, reserveFraction: 0.15 } : {});
      assert.equal(mainCtx, expected, `mismatch at totalRamGB=${totalRamGB}`);
    }
  });

  test("an unrecognized custom model falls back to the generic facts recommendServeContextLength used", () => {
    const ini = buildModelsPreset({ LLAMACPP_MODEL: "someone/custom-GGUF" }, { totalRamGB: 64 });
    const mainCtx = parseInt(ini.match(/ctx-size = (\d+)/)[1], 10);
    // GENERIC_MODEL_FACTS carries a conservative kvBytesPerToken (a modern
    // 9B-class KV cost) so an unknown model sizes down rather than OOMing at
    // inference — see the comment on GENERIC_MODEL_FACTS in startLlamaCpp.js.
    const expected = recommendContextLength({
      modelMaxContext: 131072,
      weightsGB: 8,
      bytesPerToken: 524288,
      totalRamGB: 64,
    });
    assert.equal(mainCtx, expected);
  });
});

// =============================================================================
describe("ensureLlamaCpp", () => {

  test("resolves immediately when llama-server is already running", async () => {
    globalThis.fetch = async () => ({ ok: true });
    await ensureLlamaCpp(); // should not throw
  });

  test("publishes LLAMACPP_SERVE_CTX and LLAMACPP_CTX (~92%/-512 of served window) even on the already-running path", async () => {
    delete process.env.LLAMACPP_SERVE_CTX;
    delete process.env.LLAMACPP_CTX;
    globalThis.fetch = async () => ({ ok: true });
    await ensureLlamaCpp();

    const serveCtx = parseInt(process.env.LLAMACPP_SERVE_CTX, 10);
    const appCtx = parseInt(process.env.LLAMACPP_CTX, 10);
    assert.ok(serveCtx > 0);
    assert.equal(appCtx, Math.max(1, Math.min(Math.floor(serveCtx * 0.92), serveCtx - 512)));
  });

  test("does not overwrite an explicit LLAMACPP_SERVE_CTX / LLAMACPP_CTX", async () => {
    process.env.LLAMACPP_SERVE_CTX = "9999";
    process.env.LLAMACPP_CTX = "1234";
    globalThis.fetch = async () => ({ ok: true });
    await ensureLlamaCpp();

    assert.equal(process.env.LLAMACPP_SERVE_CTX, "9999");
    assert.equal(process.env.LLAMACPP_CTX, "1234");
  });

  test("getLlamaCppPid returns null before ensureLlamaCpp spawns anything new (attached to an already-running server)", async () => {
    globalThis.fetch = async () => ({ ok: true });
    await ensureLlamaCpp();
    assert.equal(getLlamaCppPid(), null);
  });

  test("adopts a listener discovered on the configured port so shutdown can clean it up", async () => {
    mockFetchSequence(
      { ok: true },
      jsonResponse({ data: [{ id: "aperio-main" }, { id: "aperio-vlm" }] }),
    );
    await ensureLlamaCpp(fakeSpawn(88888), fakeKill(false), () => 42424, () => true);
    assert.equal(getLlamaCppPid(), 42424);
    await stopLlamaCpp(fakeKill(true), () => null);
    assert.equal(getLlamaCppPid(), null);
  });

  test("spawns llama-server and reports the child PID when nothing is running yet, then health comes up", async () => {
    mockFetchSequence({ ok: false }, { ok: true });
    await ensureLlamaCpp(fakeSpawn(99999));
    assert.equal(getLlamaCppPid(), 99999);
  });

  test("routes spawned server stdout/stderr to a log file (not silenced) so runtime failures are diagnosable", async () => {
    mockFetchSequence({ ok: false }, { ok: true });
    let capturedOpts = null;
    const trackerSpawn = (_cmd, _args, opts) => { capturedOpts = opts; return { on: () => {}, unref: () => {}, pid: 91234 }; };

    await ensureLlamaCpp(trackerSpawn);

    assert.ok(capturedOpts, "spawn should have been called");
    assert.equal(capturedOpts.detached, true);
    // stdio must NOT be the old "ignore" — stdout+stderr go to one log fd so the
    // real reason for a failed turn (Compute error, OOM) is recoverable.
    assert.notEqual(capturedOpts.stdio, "ignore");
    assert.ok(Array.isArray(capturedOpts.stdio), `stdio should be an fd array, got ${JSON.stringify(capturedOpts.stdio)}`);
    assert.equal(capturedOpts.stdio[0], "ignore");        // stdin ignored
    assert.equal(typeof capturedOpts.stdio[1], "number");  // stdout → log fd
    assert.equal(capturedOpts.stdio[1], capturedOpts.stdio[2]); // stderr shares the same fd
    // The log file was actually created at the documented path.
    assert.ok(existsSync("./var/llamacpp/server.log"));
  });

  test("throws when llama-server does not start within timeout", { timeout: 20_000 }, async (t) => {
    globalThis.fetch = async () => ({ ok: false });

    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });

    const p = ensureLlamaCpp(fakeSpawn()).catch(e => e);

    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    t.mock.timers.tick(31_000);

    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    const err = await p;
    assert.ok(err instanceof Error, `Expected Error, got: ${err}`);
    assert.match(err.message, /30 s/);
  });
});

// =============================================================================
describe("ensureLlamaCpp — preset reconciliation", () => {

  // helper: write a state file with the given preset hash and PID
  function writeStoredState(pid, preset) {
    const hash = createHash("sha256").update(preset).digest("hex");
    mkdirSync("./var/llamacpp", { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ pid, hash, at: Date.now() }));
  }

  test("fast return when server is up, preset hash matches, and models match", async () => {
    const preset = buildModelsPreset({}, {});
    writeStoredState(99999, preset);

    // fetch #1: /health → ok (server up)
    // fetch #2: /v1/models → contains the expected model
    mockFetchSequence(
      { ok: true },
      jsonResponse({ data: [{ id: DEFAULT_MODEL }, { id: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF" }] }),
    );

    let spawnCalled = false;
    const trackerSpawn = () => { spawnCalled = true; return { on: () => {}, unref: () => {}, pid: 88888 }; };

    await ensureLlamaCpp(trackerSpawn, fakeKill(false));
    assert.equal(spawnCalled, false);
  });

  test("fast path does not throw when stored pid is null (known-unmanaged server, still matching)", async () => {
    // Regression: writeState(null, preset) is how ensureLlamaCpp records an
    // "unowned" server (see the "already running... cannot manage it" branch
    // below). A prior bug used pid=0 for this sentinel, which is a valid
    // process.kill() target with special "whole process group" semantics on
    // POSIX — calling process.kill(0, 0) in the fast-path liveness probe was
    // unintended. pid=null must be skipped instead of probed.
    const preset = buildModelsPreset({}, {});
    writeStoredState(null, preset);

    // fetch #1: /health → ok (server up)
    // fetch #2: /v1/models → contains the expected models
    mockFetchSequence(
      { ok: true },
      jsonResponse({ data: [{ id: DEFAULT_MODEL }, { id: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF" }] }),
    );

    let spawnCalled = false;
    const trackerSpawn = () => { spawnCalled = true; return { on: () => {}, unref: () => {}, pid: 88888 }; };

    await assert.doesNotReject(() => ensureLlamaCpp(trackerSpawn, fakeKill(false)));
    assert.equal(spawnCalled, false);
  });

  test("kills and restarts when server model set is stale (models in preset not in server)", async () => {
    const preset = buildModelsPreset({}, {});
    writeStoredState(99999, preset);

    // fetch #1: /health → ok
    // fetch #2: /v1/models → server only has VLM, NOT the main model
    // after kill: fetch #3: /health → false (port freed)
    // spawn poll: fetch #4: /health → true
    mockFetchSequence(
      { ok: true },
      jsonResponse({ data: [{ id: "ggml-org/Qwen2.5-VL-7B-Instruct-GGUF" }] }),
      { ok: false },
      { ok: true },
    );

    await ensureLlamaCpp(fakeSpawn(77777), fakeKill(true));
    assert.equal(getLlamaCppPid(), 77777);
  });

  test("kills and restarts when preset hash differs from stored state", async () => {
    // Write a state with a WRONG hash (hash of an empty string)
    const wrongHash = createHash("sha256").update("old-preset").digest("hex");
    mkdirSync("./var/llamacpp", { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ pid: 99999, hash: wrongHash, at: Date.now() }));

    // fetch #1: /health → ok
    // after kill: fetch #2: /health → false
    // spawn poll: fetch #3: /health → true
    mockFetchSequence(
      { ok: true },
      { ok: false },
      { ok: true },
    );

    await ensureLlamaCpp(fakeSpawn(77777), fakeKill(true));
    assert.equal(getLlamaCppPid(), 77777);
  });

  test("returns without spawning when kill fails (different user)", async () => {
    const wrongHash = createHash("sha256").update("old-preset").digest("hex");
    mkdirSync("./var/llamacpp", { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ pid: 55555, hash: wrongHash, at: Date.now() }));

    // Server is up
    mockFetchSequence({ ok: true });

    let spawnCalled = false;
    const trackerSpawn = () => { spawnCalled = true; return { on: () => {}, unref: () => {}, pid: 88888 }; };

    assert.equal(await ensureLlamaCpp(trackerSpawn, fakeKill(false)), false);
    // Should NOT have spawned — stale server cannot be reconciled.
    assert.equal(spawnCalled, false);
  });

  test("reaps a stale still-recorded router group before overwriting state on a fresh spawn", async () => {
    // Down-server leak path: state.json still names a previous engine PID (e.g.
    // a router that lost its listener but not its worker group). Because the
    // server is down, the reconcile block above is skipped and writeState is
    // about to overwrite that PID — orphaning its resident workers forever.
    // ensureLlamaCpp must group-kill the prior PID before recording the new one.
    writeStoredState(31313, buildModelsPreset({}, {}));

    // fetch #1: /health → false (server down) → straight to spawn
    // spawn poll: fetch #2: /health → true
    mockFetchSequence({ ok: false }, { ok: true });

    const killed = [];
    await ensureLlamaCpp(fakeSpawn(42424), async pid => { killed.push(pid); return true; });

    assert.ok(killed.includes(31313), "the stale prior router group was reaped before state was overwritten");
    assert.equal(getLlamaCppPid(), 42424, "the new engine is now owned");
  });

  test("does not kill a recycled stale PID whose ownership cannot be verified", async () => {
    writeStoredState(31314, buildModelsPreset({}, {}));
    mockFetchSequence({ ok: false }, { ok: true });
    const killed = [];
    await ensureLlamaCpp(fakeSpawn(42425), async pid => { killed.push(pid); return true; }, undefined, () => false);
    assert.deepEqual(killed, [], "an unrelated process group must not be killed");
    assert.equal(getLlamaCppPid(), 42425);
  });

  test("refuses to group-kill an unmanaged process merely discovered on the port (no stored PID, not our spawn)", async () => {
    // Reset module ownership: spawn then cleanly stop so llamaCppProc is null and
    // the only PID reconciliation can find comes from the injected port scanner.
    mockFetchSequence({ ok: false }, { ok: true });
    await ensureLlamaCpp(fakeSpawn(80001));
    await stopLlamaCpp(fakeKill(true), () => null);
    assert.equal(getLlamaCppPid(), null);

    // No state file → no stored PID. Server is UP, so reconciliation runs; the
    // only PID available is from _findPid (a port scan), but _isOwnedPid reports
    // it is NOT an llama-server. It must NOT be adopted or group-killed.
    globalThis.fetch = async () => ({ ok: true });
    const killed = [];
    const result = await ensureLlamaCpp(
      fakeSpawn(80002),
      async pid => { killed.push(pid); return true; }, // _kill — must never be called
      () => 42999,   // _findPid — an unmanaged PID holds the port
      () => false,   // _isOwnedPid — not an llama-server
    );
    assert.equal(result, false, "fails closed instead of killing an unowned port holder");
    assert.deepEqual(killed, [], "a non-Aperio process must not be group-killed");
    assert.equal(getLlamaCppPid(), null, "the unmanaged PID is never adopted as owned");
  });

  test("sizes LLAMACPP_SERVE_CTX for the configured tier model when LLAMACPP_MODEL is unset", async () => {
    // Reset ownership so both sizing runs take the clean unowned-return branch.
    mockFetchSequence({ ok: false }, { ok: true });
    await ensureLlamaCpp(fakeSpawn(81001));
    await stopLlamaCpp(fakeKill(true), () => null);
    assert.equal(getLlamaCppPid(), null);

    // A curated model with a distinctly small max context, so sizing for it
    // differs from the (larger) registry-default tier on this host.
    const TIER = "Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M";
    delete process.env.LLAMACPP_MODEL;
    // Pin every RAM tier to TIER so the choice is deterministic regardless of the
    // test host's real RAM.
    for (const k of ["LLAMACPP_MODEL_TIER_8", "LLAMACPP_MODEL_TIER_16", "LLAMACPP_MODEL_TIER_24", "LLAMACPP_MODEL_TIER_32"]) {
      process.env[k] = TIER;
    }

    // Run A: LLAMACPP_MODEL unset → sizing must resolve the configured tier model.
    delete process.env.LLAMACPP_SERVE_CTX; delete process.env.LLAMACPP_CTX;
    globalThis.fetch = async () => ({ ok: true });
    await ensureLlamaCpp(fakeSpawn(81002), fakeKill(true));
    const serveTier = parseInt(process.env.LLAMACPP_SERVE_CTX, 10);

    // Run B: LLAMACPP_MODEL pinned to the SAME model explicitly → identical sizing.
    delete process.env.LLAMACPP_SERVE_CTX; delete process.env.LLAMACPP_CTX;
    process.env.LLAMACPP_MODEL = TIER;
    await ensureLlamaCpp(fakeSpawn(81003), fakeKill(true));
    const servePinned = parseInt(process.env.LLAMACPP_SERVE_CTX, 10);

    assert.ok(serveTier > 0, "a served window was computed");
    assert.equal(serveTier, servePinned,
      "an unset LLAMACPP_MODEL must size the served window for the configured tier model, exactly as pinning it would");
  });

  test("returns without spawning when server is up but unowned (not our spawn, no stored PID)", async () => {
    // No state file, and we need llamaCppProc to be null too (no prior spawn
    // in this module's lifetime). Since the module variable persists across
    // tests, we can't guarantee this. Instead: store an explicit PID=0 to
    // force the "unowned" branch.
    mkdirSync("./var/llamacpp", { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ pid: 0, hash: "x".repeat(64), at: Date.now() }));

    // Server is UP (fetch returns ok)
    mockFetchSequence({ ok: true });

    let spawnCalled = false;
    const trackerSpawn = () => { spawnCalled = true; return { on: () => {}, unref: () => {}, pid: 88888 }; };

    assert.equal(await ensureLlamaCpp(trackerSpawn, fakeKill(false)), false);
    // Should NOT have spawned — an unknown preset is unsafe to use.
    assert.equal(spawnCalled, false);

    // State should exist (writeState was called with pid=0 to suppress
    // repeated logging). It may have been overwritten by writeState.
    assert.ok(existsSync(STATE_FILE));
  });
});
describe("killByPid — process-group teardown", () => {
  // llama-server's router forks a child model worker into its own process group
  // (we spawn the router detached). killByPid must signal the GROUP (negative
  // PID) so the worker dies too; signaling only the router PID orphans the
  // worker, which keeps its multi-GB model resident and starves RAM across
  // restarts — the whole bug this guards against.
  test("signals the negative PID (whole group), not just the router", async (t) => {
    const signals = [];
    t.mock.method(process, "kill", (pid, sig) => {
      signals.push([pid, sig]);
      // Report the leader dead on the first liveness probe so we don't wait out
      // the grace period.
      if (sig === 0) { const e = new Error("no such process"); e.code = "ESRCH"; throw e; }
      return true;
    });

    const ok = await killByPid(4242);
    assert.equal(ok, true, "leader confirmed gone → true");

    const term = signals.find(([, s]) => s === "SIGTERM");
    assert.ok(term, "sent a SIGTERM");
    assert.equal(term[0], -4242, "SIGTERM must target the process GROUP (negative PID)");
  });

  test("returns true when the group is already gone (ESRCH on SIGTERM)", async (t) => {
    t.mock.method(process, "kill", () => { const e = new Error("gone"); e.code = "ESRCH"; throw e; });
    assert.equal(await killByPid(4242), true);
  });

  test("ignores invalid PIDs without signaling", async (t) => {
    let called = false;
    t.mock.method(process, "kill", () => { called = true; return true; });
    assert.equal(await killByPid(0), false);
    assert.equal(await killByPid(-1), false);
    assert.equal(called, false, "never signals for a non-positive PID");
  });
});

describe("stopLlamaCpp — owner + preset guard", () => {
  // "Always stop llama on exit if we've started it and no other (non-preset)
  // models are running." Ownership = getLlamaCppPid() (the PID we spawned this
  // session); safety = no resident worker outside our preset. Uses a fake PID
  // with no real child workers, so loadedWorkerModels() is empty (all-clear).
  test("stops the server we spawned when only preset models are resident, then reports unowned", async () => {
    mockFetchSequence({ ok: false }, { ok: true });
    await ensureLlamaCpp(fakeSpawn(90001));
    assert.equal(getLlamaCppPid(), 90001, "we now own the spawned router PID");

    let killedPid = null;
    const stopped = await stopLlamaCpp(async (pid) => { killedPid = pid; return true; });
    assert.equal(stopped, true, "owned + no foreign model resident → stops");
    assert.equal(killedPid, 90001, "tears down the router PID we own");
    assert.equal(getLlamaCppPid(), null, "ownership cleared after stopping");

    // Second call: we no longer own anything → must not signal.
    let calledAgain = false;
    const again = await stopLlamaCpp(async () => { calledAgain = true; return true; });
    assert.equal(again, false, "no-op once we no longer own a server");
    assert.equal(calledAgain, false, "never signals when we don't own the server");
  });

  test("no-op (never signals) when we never spawned a server", async () => {
    globalThis.fetch = async () => ({ ok: true }); // attach to an already-running one
    await ensureLlamaCpp();                         // does not spawn → we don't own it
    assert.equal(getLlamaCppPid(), null);

    let called = false;
    const stopped = await stopLlamaCpp(async () => { called = true; return true; });
    assert.equal(stopped, false);
    assert.equal(called, false, "an attached (not-spawned) server is left running");
  });

  // Reporting a failed teardown as success is how a leaked router+worker group
  // (multi-GB resident) went unnoticed and piled up across restarts. stopLlamaCpp
  // must surface the real kill result and keep ownership so a later stop/reconcile
  // can retry the still-live process instead of forgetting it.
  test("reports a failed teardown instead of masking it as success, and keeps ownership", async () => {
    mockFetchSequence({ ok: false }, { ok: true });
    await ensureLlamaCpp(fakeSpawn(90777));
    assert.equal(getLlamaCppPid(), 90777, "we own the spawned router PID");

    const stopped = await stopLlamaCpp(fakeKill(false), () => null);
    assert.equal(stopped, false, "a kill that did not confirm the process gone must not report success");
    assert.equal(getLlamaCppPid(), 90777, "ownership is retained so the leaked group can be retried");

    // A subsequent successful kill relinquishes ownership.
    assert.equal(await stopLlamaCpp(fakeKill(true), () => null), true);
    assert.equal(getLlamaCppPid(), null);
  });
});

// =============================================================================
describe("session-scoped server log tee", () => {
  const DIR = "./var/llamacpp";
  const SERVER_LOG = `${DIR}/server.log`;
  // v4-shaped ids that can never collide with a real randomUUID session log
  const ID_OLD   = "00000000-0000-4000-8000-000000000001";
  const ID_FRESH = "00000000-0000-4000-8000-000000000002";

  // These tests exercise the real var/llamacpp dir (same pattern as the rest of
  // this file) — preserve and restore the developer's live server.log.
  let originalServerLog = null;
  before(() => {
    mkdirSync(DIR, { recursive: true });
    try { originalServerLog = readFileSync(SERVER_LOG); } catch { originalServerLog = null; }
  });
  after(() => {
    if (originalServerLog !== null) writeFileSync(SERVER_LOG, originalServerLog);
    else { try { unlinkSync(SERVER_LOG); } catch { /* never existed */ } }
  });
  afterEach(() => {
    // Unenroll any session the test left active, so its timer/state doesn't
    // bleed into the next test, then remove its file.
    for (const id of [ID_OLD, ID_FRESH]) {
      endSessionLog(id);
      try { unlinkSync(`${DIR}/${id}.log`); } catch { /* not created */ }
    }
  });

  test("beginSessionLog creates the session log immediately (visible from session start)", () => {
    writeFileSync(SERVER_LOG, "");
    beginSessionLog(ID_OLD);
    assert.ok(existsSync(`${DIR}/${ID_OLD}.log`), "log file exists as soon as the session starts");
    assert.equal(readFileSync(`${DIR}/${ID_OLD}.log`, "utf8"), "", "starts empty");
  });

  test("the tee appends server output written during the session, not before it", () => {
    writeFileSync(SERVER_LOG, "boot output before any session\n");
    beginSessionLog(ID_OLD); // catches teePos up past the boot output

    appendFileSync(SERVER_LOG, "during-session line 1\n");
    pumpServerLogTee();
    appendFileSync(SERVER_LOG, "during-session line 2\n");
    pumpServerLogTee();

    assert.equal(
      readFileSync(`${DIR}/${ID_OLD}.log`, "utf8"),
      "during-session line 1\nduring-session line 2\n",
      "session log holds only what llama-server logged during the session",
    );
  });

  test("concurrent sessions each capture output from their own start point", () => {
    writeFileSync(SERVER_LOG, "");
    beginSessionLog(ID_OLD);
    appendFileSync(SERVER_LOG, "seen only by OLD\n");
    pumpServerLogTee();

    beginSessionLog(ID_FRESH); // starts after the first line
    appendFileSync(SERVER_LOG, "seen by both\n");
    pumpServerLogTee();

    assert.equal(readFileSync(`${DIR}/${ID_OLD}.log`, "utf8"), "seen only by OLD\nseen by both\n");
    assert.equal(readFileSync(`${DIR}/${ID_FRESH}.log`, "utf8"), "seen by both\n");
  });

  test("a server restart mid-session (server.log truncated) keeps the captured log and appends the new boot output", () => {
    writeFileSync(SERVER_LOG, "old server line\n");
    beginSessionLog(ID_OLD);
    appendFileSync(SERVER_LOG, "old server work\n");
    pumpServerLogTee();

    // Server restarts: spawn reopens server.log with "w" → truncated + shorter.
    writeFileSync(SERVER_LOG, "new server boot\n");
    pumpServerLogTee();

    assert.equal(
      readFileSync(`${DIR}/${ID_OLD}.log`, "utf8"),
      "old server work\nnew server boot\n",
      "already-captured output survives the truncation; new output is appended",
    );
  });

  test("the tee strips NUL bytes so a holed server.log never yields a binary session log", () => {
    // Reproduces the real corruption: server.log with a zero-fill hole (a
    // truncation left under a stale child fd) must not turn the session log
    // binary. The tee drops the NULs; only the readable text survives.
    writeFileSync(SERVER_LOG, "");
    beginSessionLog(ID_OLD);
    const holed = Buffer.concat([Buffer.alloc(2048, 0), Buffer.from("Compute error.\n")]);
    appendFileSync(SERVER_LOG, holed);
    pumpServerLogTee();

    const out = readFileSync(`${DIR}/${ID_OLD}.log`);
    assert.equal(out.includes(0), false, "no NUL bytes reach the session log");
    assert.equal(out.toString("utf8"), "Compute error.\n");
  });

  test("endSessionLog removes an empty session log and reports false", () => {
    writeFileSync(SERVER_LOG, "unrelated\n");
    beginSessionLog(ID_OLD);        // cloud-provider session: nothing gets teed
    const kept = endSessionLog(ID_OLD);
    assert.equal(kept, false, "reports no log was kept");
    assert.equal(existsSync(`${DIR}/${ID_OLD}.log`), false);
  });

  test("endSessionLog keeps a non-empty session log and reports true", () => {
    writeFileSync(SERVER_LOG, "");
    beginSessionLog(ID_OLD);
    appendFileSync(SERVER_LOG, "a diagnostic line\n");
    const kept = endSessionLog(ID_OLD);          // drains before closing
    assert.equal(kept, true, "reports a non-empty log was kept — pairs session-keeping with real server work");
    assert.ok(existsSync(`${DIR}/${ID_OLD}.log`), "kept for the 24h retention window");
    assert.equal(readFileSync(`${DIR}/${ID_OLD}.log`, "utf8"), "a diagnostic line\n");
  });

  test("appendSessionLog records provider-side diagnostics in the active session log", () => {
    writeFileSync(SERVER_LOG, "");
    beginSessionLog(ID_OLD);
    appendSessionLog(ID_OLD, "[llamacpp] llama.cpp streamed error: Compute error.");
    assert.match(readFileSync(`${DIR}/${ID_OLD}.log`, "utf8"), /streamed error: Compute error\./);
  });

  test("appendSessionLog ignores inactive sessions", () => {
    writeFileSync(`${DIR}/${ID_FRESH}.log`, "");
    appendSessionLog(ID_FRESH, "should not be written");
    assert.equal(readFileSync(`${DIR}/${ID_FRESH}.log`, "utf8"), "");
  });

  test("deleteServerLog removes the session log and tolerates a missing one", () => {
    writeFileSync(`${DIR}/${ID_OLD}.log`, "x");
    deleteServerLog(ID_OLD);
    assert.equal(existsSync(`${DIR}/${ID_OLD}.log`), false);
    deleteServerLog(ID_OLD); // second call must not throw
  });

  test("pruneServerLogs removes only expired uuid logs, never the server's own files", () => {
    writeFileSync(SERVER_LOG, "live server log\n");
    writeFileSync(`${DIR}/${ID_OLD}.log`, "expired");
    writeFileSync(`${DIR}/${ID_FRESH}.log`, "fresh");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(`${DIR}/${ID_OLD}.log`, twoDaysAgo, twoDaysAgo);

    const removed = pruneServerLogs(1);

    assert.equal(removed, 1);
    assert.equal(existsSync(`${DIR}/${ID_OLD}.log`), false, "expired session log is pruned");
    assert.equal(existsSync(`${DIR}/${ID_FRESH}.log`), true, "fresh session log survives");
    assert.equal(existsSync(SERVER_LOG), true, "server.log is never pruned");
  });

  test("pruneServerLogs clamps retention below one day to the 1-day floor", () => {
    writeFileSync(`${DIR}/${ID_FRESH}.log`, "written just now");
    const removed = pruneServerLogs(0); // 0 would otherwise expire everything instantly
    assert.equal(removed, 0);
    assert.equal(existsSync(`${DIR}/${ID_FRESH}.log`), true);
  });
});
