// tests/lib/helpers/startLlamaCpp.test.js
import { describe, test, afterEach } from "node:test";
import { createHash } from "crypto";
import { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import assert from "node:assert/strict";
import {
  buildModelsPreset,
  ensureLlamaCpp,
  getLlamaCppPid,
  killByPid,
  stopLlamaCpp,
} from "../../../lib/helpers/startLlamaCpp.js";
import { recommendContextLength } from "../../../lib/providers/index.js";

// ensureLlamaCpp() takes an injectable _spawn (default: the real
// child_process.spawn) instead of relying on mock.method() interception —
// unlike Ollama, llama-server IS commonly installed on this project's dev
// machines (it's the whole point of this module), so a missed mock here would
// silently launch a real background server during `npm test`.
function fakeSpawn(pid = 99999) {
  return () => ({ on: () => {}, unref: () => {}, pid });
}

// A fake kill that returns the given value (true = killed, false = failed).
function fakeKill(result) {
  return async () => result;
}

const originalFetch = globalThis.fetch;
const ENV_KEYS = ["LLAMACPP_MODEL", "LLAMACPP_VLM_MODEL", "LLAMACPP_VLM_MMPROJ", "LLAMACPP_SERVE_CTX", "LLAMACPP_CTX"];
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

  test("emits a [*] global section with jinja enabled", () => {
    const ini = buildModelsPreset({}, {});
    assert.match(ini, /^\[\*\]\njinja = true/);
  });

  test("defaults to the curated main + VLM models", () => {
    const ini = buildModelsPreset({}, {});
    assert.match(ini, /\[Qwen\/Qwen2\.5-3B-Instruct-GGUF:Q4_K_M\]/);
    assert.match(ini, /hf-repo = Qwen\/Qwen2\.5-3B-Instruct-GGUF:Q4_K_M/);
    assert.match(ini, /\[ggml-org\/Qwen2\.5-VL-7B-Instruct-GGUF\]/);
    assert.match(ini, /hf-repo = ggml-org\/Qwen2\.5-VL-7B-Instruct-GGUF/);
  });

  test("LLAMACPP_MODEL / LLAMACPP_VLM_MODEL override the section + hf-repo names", () => {
    const ini = buildModelsPreset({
      LLAMACPP_MODEL: "my-org/my-model-GGUF:Q8_0",
      LLAMACPP_VLM_MODEL: "my-org/my-vlm-GGUF",
    }, {});
    assert.match(ini, /\[my-org\/my-model-GGUF:Q8_0\]/);
    assert.match(ini, /hf-repo = my-org\/my-model-GGUF:Q8_0/);
    assert.match(ini, /\[my-org\/my-vlm-GGUF\]/);
    assert.match(ini, /hf-repo = my-org\/my-vlm-GGUF/);
  });

  test("omits mmproj when LLAMACPP_VLM_MMPROJ is unset (llama-server auto-detects it)", () => {
    const ini = buildModelsPreset({}, {});
    assert.doesNotMatch(ini, /mmproj/);
  });

  test("emits mmproj on the VLM entry only when LLAMACPP_VLM_MMPROJ is set", () => {
    const ini = buildModelsPreset({ LLAMACPP_VLM_MMPROJ: "mmproj-file.gguf" }, {});
    const mmprojMatches = ini.match(/mmproj = mmproj-file\.gguf/g);
    assert.equal(mmprojMatches?.length, 1, "mmproj should appear exactly once");
    const vlmHeaderIdx = ini.indexOf("[ggml-org/Qwen2.5-VL-7B-Instruct-GGUF]");
    const mainHeaderIdx = ini.indexOf("[Qwen/Qwen2.5-3B-Instruct-GGUF:Q4_K_M]");
    const mmprojIdx = ini.indexOf("mmproj = mmproj-file.gguf");
    assert.ok(mmprojIdx > vlmHeaderIdx && vlmHeaderIdx > mainHeaderIdx, "mmproj line should fall within the VLM section, after the main section");
  });

  test("LLAMACPP_SERVE_CTX pins ctx-size for both models, skipping RAM-based sizing", () => {
    const ini = buildModelsPreset({ LLAMACPP_SERVE_CTX: "4096" }, { totalRamGB: 4 });
    const ctxLines = ini.match(/ctx-size = \d+/g);
    assert.deepEqual(ctxLines, ["ctx-size = 4096", "ctx-size = 4096"]);
  });

  test("ctx-size never exceeds each model's max context regardless of RAM", () => {
    const ini = buildModelsPreset({}, { totalRamGB: 512 });
    const ctxLines = ini.match(/ctx-size = (\d+)/g).map(l => parseInt(l.split(" = ")[1], 10));
    for (const ctx of ctxLines) assert.ok(ctx <= 32768, `ctx-size ${ctx} should be capped at maxContext 32768`);
  });

  test("small RAM sizes down toward the floor", () => {
    const ini = buildModelsPreset({}, { totalRamGB: 4 });
    const ctxLines = ini.match(/ctx-size = (\d+)/g).map(l => parseInt(l.split(" = ")[1], 10));
    for (const ctx of ctxLines) assert.ok(ctx <= 4096, `expected a small window on a 4GB machine, got ${ctx}`);
  });
});

// =============================================================================
// Perf profiles (llamacpp.md Phase 4) — APERIO_LOCAL_PERF_PROFILE flows
// through env into buildModelsPreset via resolvePerfProfile.
describe("buildModelsPreset — perf profiles", () => {

  test("balanced (default, no env var set): identical to pre-Phase-4 output", () => {
    const ini = buildModelsPreset({}, { totalRamGB: 64 });
    assert.doesNotMatch(ini, /models-max|flash-attn|cache-type|n-cpu-moe/);
    assert.match(ini, /\[Qwen\/Qwen2\.5-3B-Instruct-GGUF:Q4_K_M\]/, "balanced keeps the fixed curated default model");
  });

  test("fast-low-vram: emits models-max=1 and flash-attn in the global section", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 64 });
    assert.match(ini, /^\[\*\]\njinja = true\nmodels-max = 1\nflash-attn = true\n/);
  });

  test("fast-low-vram: emits quantized KV cache flags on every model section", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 64 });
    const kMatches = ini.match(/cache-type-k = q8_0/g);
    const vMatches = ini.match(/cache-type-v = q8_0/g);
    assert.equal(kMatches?.length, 2, "both main + VLM sections should quantize the K cache");
    assert.equal(vMatches?.length, 2, "both main + VLM sections should quantize the V cache");
  });

  test("fast-low-vram: prefers the MoE model by default at 24GB RAM (below balanced's 48GB rung) and emits n-cpu-moe on it", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "fast-low-vram" }, { totalRamGB: 24 });
    assert.match(ini, /\[Qwen\/Qwen3-30B-A3B-GGUF:Q4_K_M\]/);
    assert.match(ini, /n-cpu-moe = 999/);
    // Only one n-cpu-moe line: the VLM model (dense) must not get it.
    assert.equal(ini.match(/n-cpu-moe/g)?.length, 1);
  });

  test("fast-low-vram: an explicit LLAMACPP_MODEL still wins over the MoE-preferred default", () => {
    const ini = buildModelsPreset(
      { APERIO_LOCAL_PERF_PROFILE: "fast-low-vram", LLAMACPP_MODEL: "my-org/pinned-GGUF" },
      { totalRamGB: 24 },
    );
    assert.match(ini, /\[my-org\/pinned-GGUF\]/);
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
    const model = "ggml-org/gemma-4-12B-it-GGUF:Q4_K_M";
    const long = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "long-context", LLAMACPP_MODEL: model }, { totalRamGB: 512 });
    const balanced = buildModelsPreset({ LLAMACPP_MODEL: model }, { totalRamGB: 512 });
    const longCtx = parseInt(long.match(/ctx-size = (\d+)/)[1], 10);
    const balancedCtx = parseInt(balanced.match(/ctx-size = (\d+)/)[1], 10);
    assert.ok(longCtx > balancedCtx, `expected long-context (${longCtx}) > balanced (${balancedCtx})`);
    assert.doesNotMatch(long, /models-max|flash-attn|cache-type|n-cpu-moe/, "long-context is a ctx-only profile, no fast-low-vram flags");
  });

  test("long-context: model pick is unchanged from balanced (only ctx sizing differs)", () => {
    const long = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "long-context" }, { totalRamGB: 24 });
    assert.match(long, /\[Qwen\/Qwen2\.5-3B-Instruct-GGUF:Q4_K_M\]/, "long-context keeps the fixed curated default model, same as balanced");
  });

  test("quality: picks a bigger default model where the plain fixed default (used unchanged by balanced) would not", () => {
    // balanced's own buildModelsPreset fallback is a fixed small model
    // regardless of RAM (RAM-tiering normally happens once, at wizard time,
    // via getRecommendedModel() writing LLAMACPP_MODEL into .env) — quality is
    // the profile that reaches into that ladder itself, so it diverges from
    // the fixed default at a RAM tier where the ladder recommends something bigger.
    const quality = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "quality" }, { totalRamGB: 16 });
    assert.match(quality, /\[ggml-org\/gemma-4-12B-it-GGUF:Q4_K_M\]/);
    assert.doesNotMatch(quality, /models-max|flash-attn|cache-type|n-cpu-moe/, "quality has no fast-low-vram-style flags");
  });

  test("quality: an explicit LLAMACPP_MODEL still wins over the bigger-model default", () => {
    const ini = buildModelsPreset({ APERIO_LOCAL_PERF_PROFILE: "quality", LLAMACPP_MODEL: "my-org/pinned-GGUF" }, { totalRamGB: 16 });
    assert.match(ini, /\[my-org\/pinned-GGUF\]/);
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
    for (const totalRamGB of [4, 8, 16, 24, 48, 64]) {
      const ini = buildModelsPreset({}, { totalRamGB });
      const mainCtx = parseInt(ini.match(/ctx-size = (\d+)/)[1], 10);
      const expected = recommendContextLength({
        modelMaxContext: 32768,
        weightsGB: 1.9,
        bytesPerToken: 36864,
        totalRamGB,
      });
      assert.equal(mainCtx, expected, `mismatch at totalRamGB=${totalRamGB}`);
    }
  });

  test("an unrecognized custom model falls back to the generic facts recommendServeContextLength used", () => {
    const ini = buildModelsPreset({ LLAMACPP_MODEL: "someone/custom-GGUF" }, { totalRamGB: 64 });
    const mainCtx = parseInt(ini.match(/ctx-size = (\d+)/)[1], 10);
    const expected = recommendContextLength({
      modelMaxContext: 131072,
      weightsGB: 8,
      bytesPerToken: undefined,
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

    await ensureLlamaCpp(trackerSpawn, fakeKill(false));
    // Should NOT have spawned — kill failed, returned early
    assert.equal(spawnCalled, false);
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

    await ensureLlamaCpp(trackerSpawn, fakeKill(false));
    // Should NOT have spawned — returned early with error log
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

  test("returns false when the group is already gone (ESRCH on SIGTERM)", async (t) => {
    t.mock.method(process, "kill", () => { const e = new Error("gone"); e.code = "ESRCH"; throw e; });
    assert.equal(await killByPid(4242), false);
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
});
