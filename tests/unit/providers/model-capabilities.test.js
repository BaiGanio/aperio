// tests/unit/providers/model-capabilities.test.js
//
// Coverage for lib/providers/model-capabilities.js and the two ggufModelFacts.js
// helpers it builds on (hasCachedMmproj, hasToolCallingTemplate). Companion to
// trash/plans/model-vision-autodetect/model-vision-autodetect-tests.md (G1-G4).
//
// This replaces isVisionModel/isToollessVLM's name-regex tests: vision and
// tool-calling are now measured from the model file itself (a cached mmproj
// sibling, and the GGUF's own chat template), never matched against a name.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { hasCachedMmproj, hasToolCallingTemplate } from "../../../lib/helpers/ggufModelFacts.js";
import { modelCapabilities, modelCapabilitiesSync } from "../../../lib/providers/model-capabilities.js";

// ─── Fixture helpers ────────────────────────────────────────────────────────

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function fakeCache() {
  const root = mkdtempSync(join(tmpdir(), "aperio-modelcaps-"));
  roots.push(root);
  return root;
}

function fakeRepoDir(cacheRoot, repo, rev = "abc") {
  const dir = join(cacheRoot, "models--" + repo.replaceAll("/", "--"));
  const snap = join(dir, "snapshots", rev);
  mkdirSync(join(dir, "refs"), { recursive: true });
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(dir, "refs", "main"), rev);
  return snap;
}

// Minimal GGUF header writer (same shape as tests/integration/helpers/
// ggufModelFacts.test.js's fixture()), extended with an optional
// tokenizer.chat_template string KV for the G2 tool-calling probe.
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = s => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
function kv(key, type, value) {
  const encoded = type === 8 ? str(value) : u32(value);
  return Buffer.concat([str(key), u32(type), encoded]);
}
function writeGguf(path, { chatTemplate } = {}) {
  const entries = [
    kv("general.architecture", 8, "test"),
    kv("test.block_count", 4, 2),
    kv("test.context_length", 4, 2048),
    kv("test.embedding_length", 4, 8),
    kv("test.attention.head_count", 4, 2),
    kv("test.attention.head_count_kv", 4, 1),
    kv("test.attention.key_length", 4, 4),
    kv("test.attention.value_length", 4, 4),
  ];
  if (chatTemplate !== undefined) entries.push(kv("tokenizer.chat_template", 8, chatTemplate));
  writeFileSync(path, Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(entries.length), ...entries]));
}

// ─── G1 — hasCachedMmproj() ─────────────────────────────────────────────────

describe("hasCachedMmproj()", () => {
  test("G1.1 finds mmproj alongside the weights file", () => {
    const cache = fakeCache();
    const snap = fakeRepoDir(cache, "org/Vision-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"));
    writeFileSync(join(snap, "mmproj-BF16.gguf"), Buffer.alloc(16));
    assert.equal(hasCachedMmproj("org/Vision-GGUF", cache), join(snap, "mmproj-BF16.gguf"));
  });

  test("G1.2 no mmproj present", () => {
    const cache = fakeCache();
    const snap = fakeRepoDir(cache, "org/Blind-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"));
    assert.equal(hasCachedMmproj("org/Blind-GGUF", cache), null);
  });

  test("G1.3 matches an mmproj filename case-insensitively", () => {
    const cache = fakeCache();
    const snap = fakeRepoDir(cache, "org/Vision-GGUF");
    writeFileSync(join(snap, "MMPROJ-F16.GGUF"), Buffer.alloc(16));
    assert.equal(hasCachedMmproj("org/Vision-GGUF", cache), join(snap, "MMPROJ-F16.GGUF"));
  });

  test("G1.4 repo not cached at all — returns null, no throw", () => {
    const cache = fakeCache();
    assert.doesNotThrow(() => hasCachedMmproj("org/Nowhere-GGUF", cache));
    assert.equal(hasCachedMmproj("org/Nowhere-GGUF", cache), null);
  });

  test("G1.5 broken refs/main — returns null, no throw", () => {
    const cache = fakeCache();
    const dir = join(cache, "models--org--Broken-GGUF");
    mkdirSync(join(dir, "snapshots", "abc"), { recursive: true }); // refs/main deliberately missing
    assert.doesNotThrow(() => hasCachedMmproj("org/Broken-GGUF", cache));
    assert.equal(hasCachedMmproj("org/Broken-GGUF", cache), null);
  });

  test("G1.6 a bare .gguf path scans its own directory", () => {
    const cache = fakeCache();
    writeGguf(join(cache, "model.gguf"));
    writeFileSync(join(cache, "mmproj-F16.gguf"), Buffer.alloc(16));
    assert.equal(hasCachedMmproj(join(cache, "model.gguf"), cache), join(cache, "mmproj-F16.gguf"));
  });

  test("G1.7 a bare .gguf path does NOT claim an unrelated model's mmproj when multiple models share the directory", () => {
    // Regression: unlike an HF cache snapshot dir (exclusively one repo's own
    // files), a bare-file directory can hold several unrelated models. A
    // text-only model sitting beside another model's mmproj must not be
    // marked vision-capable — that would route raw images to a model that
    // cannot process them.
    const cache = fakeCache();
    writeGguf(join(cache, "text-only-model.gguf"));
    writeGguf(join(cache, "vision-model.gguf"));
    writeFileSync(join(cache, "mmproj-F16.gguf"), Buffer.alloc(16)); // belongs to vision-model, not text-only-model
    assert.equal(hasCachedMmproj(join(cache, "text-only-model.gguf"), cache), null,
      "ambiguous directory (2+ weight files) must not guess a pairing");
  });

  test("edge: an alias (no '/') returns null without touching disk", () => {
    assert.equal(hasCachedMmproj("gemma4:e4b", "/definitely/not/a/cache"), null);
  });
});

// ─── G2 — hasToolCallingTemplate() ──────────────────────────────────────────

describe("hasToolCallingTemplate()", () => {
  test("G2.1 a tool-calling chat template → true", () => {
    const cache = fakeCache();
    const path = join(cache, "model.gguf");
    writeGguf(path, { chatTemplate: "{% if tools %}{{ tool_call }}{% endif %}" });
    assert.equal(hasToolCallingTemplate(path), true);
  });

  test("G2.2 a llava-shaped template (no tools/tool_call) → false", () => {
    const cache = fakeCache();
    const path = join(cache, "model.gguf");
    // A real minimal llava-style template: plain USER/ASSISTANT turns, no
    // tool-calling constructs anywhere.
    writeGguf(path, { chatTemplate:
      "{{ bos_token }}{% for message in messages %}{% if message['role'] == 'user' %}USER: {{ message['content'] }}\n" +
      "{% else %}ASSISTANT: {{ message['content'] }}{{ eos_token }}\n{% endif %}{% endfor %}ASSISTANT:" });
    assert.equal(hasToolCallingTemplate(path), false);
  });

  test("G2.3 no template key present → true (permissive default)", () => {
    const cache = fakeCache();
    const path = join(cache, "model.gguf");
    writeGguf(path);
    assert.equal(hasToolCallingTemplate(path), true);
  });

  test("G2.4 a large template is read but not retained", () => {
    const cache = fakeCache();
    const path = join(cache, "model.gguf");
    const bigTemplate = "tool_call " + "x".repeat(50 * 1024);
    writeGguf(path, { chatTemplate: bigTemplate });
    // The function returns a plain boolean, never the template string itself
    // — nothing here for a caller to retain. modelCapabilities' own cache
    // (G3, below) proves the wider claim: a cached capabilities result never
    // carries the raw string either.
    assert.equal(hasToolCallingTemplate(path), true);
  });

  test("unreadable/unparseable file → true (permissive default, no throw)", () => {
    const cache = fakeCache();
    const path = join(cache, "not-a-gguf.gguf");
    writeFileSync(path, "definitely not a GGUF file");
    assert.doesNotThrow(() => hasToolCallingTemplate(path));
    assert.equal(hasToolCallingTemplate(path), true);
  });
});

// ─── G3 — modelCapabilities() / modelCapabilitiesSync() resolution order ────

describe("modelCapabilities() resolution order", () => {
  test("G3.1 a cloud provider wins outright — no disk access", () => {
    const result = modelCapabilitiesSync("claude-opus-5", { LLAMA_CACHE: "/definitely/not/a/cache" }, { provider: "anthropic" });
    assert.deepEqual(result, { vision: true, tools: true, source: "provider" });
  });

  test("G3.2 deepseek is a provider-level blind, any model name", () => {
    for (const model of ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-coder"]) {
      const result = modelCapabilitiesSync(model, {}, { provider: "deepseek" });
      assert.deepEqual(result, { vision: false, tools: true, source: "provider" });
    }
  });

  test("G3.3 a cached model resolves from disk alone — the Hub is never called", async () => {
    const cache = fakeCache();
    const snap = fakeRepoDir(cache, "org/Cached-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"));
    writeFileSync(join(snap, "mmproj-BF16.gguf"), Buffer.alloc(16));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => assert.fail("the Hub must never be called for an already-cached repo");
    try {
      const result = await modelCapabilities("org/Cached-GGUF", { LLAMA_CACHE: cache });
      assert.equal(result.vision, true);
      assert.equal(result.source, "cache");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("G3.4 an uncached repo falls back to one Hub lookup", async () => {
    const cache = fakeCache();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (url) => {
      calls++;
      assert.match(String(url), /^https:\/\/huggingface\.co\/api\/models\/org\/Uncached-GGUF\/tree\/main$/);
      return { ok: true, json: async () => [{ path: "model.gguf" }, { path: "mmproj-BF16.gguf" }] };
    };
    try {
      const result = await modelCapabilities("org/Uncached-GGUF", { LLAMA_CACHE: cache });
      assert.deepEqual(result, { vision: true, tools: true, source: "hub" });
      assert.equal(calls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("G3.5 a failed Hub lookup is safe — vision: false, source: unknown, no throw", async () => {
    const cache = fakeCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("network unreachable"); };
    try {
      const result = await modelCapabilities("org/AnotherUncached-GGUF", { LLAMA_CACHE: cache });
      assert.deepEqual(result, { vision: false, tools: true, source: "unknown" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("G3.6 the answer is memoised — the Hub fires at most once per repo", async () => {
    const cache = fakeCache();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => [{ path: "mmproj-BF16.gguf" }] };
    };
    try {
      const env = { LLAMA_CACHE: cache };
      const first = await modelCapabilities("org/Memoised-GGUF", env);
      const second = await modelCapabilities("org/Memoised-GGUF", env);
      assert.deepEqual(first, second);
      assert.equal(calls, 1, "the second call must be served from the in-process cache");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("G3.7 the cache key includes the cache root — two roots answer independently", async () => {
    const visionCache = fakeCache();
    const blindCache = fakeCache();
    const snap = fakeRepoDir(visionCache, "org/RootDependent-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"));
    writeFileSync(join(snap, "mmproj-BF16.gguf"), Buffer.alloc(16));
    fakeRepoDir(blindCache, "org/RootDependent-GGUF"); // no mmproj here

    const withVision = await modelCapabilities("org/RootDependent-GGUF", { LLAMA_CACHE: visionCache });
    const blind = await modelCapabilities("org/RootDependent-GGUF", { LLAMA_CACHE: blindCache });
    assert.equal(withVision.vision, true);
    assert.equal(blind.vision, false);
  });

  test("G3.8 a hub-sourced guess is replaced by disk facts once the weights actually download", async () => {
    // Regression: a repo resolved via the Hub before download is cached
    // tools:true (the permissive guess) at source:"hub". If the real GGUF
    // (once downloaded) has a tool-less chat template, that stale guess must
    // not survive — the next call has to notice the weights landed and
    // re-derive from disk, same as a repo that was cached from the start.
    const cache = fakeCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => [] }); // no mmproj listed
    const env = { LLAMA_CACHE: cache };
    try {
      const before = await modelCapabilities("org/LateDownload-GGUF", env);
      assert.deepEqual(before, { vision: false, tools: true, source: "hub" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The download completes: weights land on disk with a tool-less template.
    const snap = fakeRepoDir(cache, "org/LateDownload-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"), {
      chatTemplate: "{{ bos_token }}{% for m in messages %}{{ m['content'] }}{% endfor %}",
    });

    const after = modelCapabilitiesSync("org/LateDownload-GGUF", env);
    assert.equal(after.tools, false, "disk-derived facts must override the earlier hub guess");
    assert.equal(after.source, "cache");
  });

  test("G3.9 a cache-derived vision:false is re-checked, not permanent — the projector can land after the main weights", () => {
    // Regression: llama.cpp's -hf downloader fetches a repo's main GGUF and
    // its mmproj companion independently, so they can finish at different
    // times. A vision:false read while only the main GGUF exists must not be
    // pinned forever — the next call has to notice the projector once it
    // lands, without a process restart.
    const cache = fakeCache();
    const env = { LLAMA_CACHE: cache };
    const snap = fakeRepoDir(cache, "org/StaggeredDownload-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"), { chatTemplate: "{% if tools %}{{ tool_call }}{% endif %}" });

    const beforeProjector = modelCapabilitiesSync("org/StaggeredDownload-GGUF", env);
    assert.deepEqual(beforeProjector, { vision: false, tools: true, source: "cache" });

    // A second read before the projector arrives must still be false (not
    // flip spuriously) — re-checking disk is not the same as always saying yes.
    assert.equal(modelCapabilitiesSync("org/StaggeredDownload-GGUF", env).vision, false);

    writeFileSync(join(snap, "mmproj-BF16.gguf"), Buffer.alloc(16));

    const afterProjector = modelCapabilitiesSync("org/StaggeredDownload-GGUF", env);
    assert.equal(afterProjector.vision, true, "the newly-landed projector must be picked up without a restart");
    assert.equal(afterProjector.tools, true, "tools (baked into the already-measured main weights) must be preserved across the recheck");
    assert.equal(afterProjector.source, "cache");
  });

  test("G3.10 a hub-sourced vision:TRUE guess still gets its tools re-measured once the GGUF downloads (a tool-less VLM)", async () => {
    // Regression: the Hub API's file-tree listing can say vision:true just
    // from seeing an mmproj*.gguf filename upstream — before any download —
    // but its tools:true is always a permissive, unmeasured guess (see
    // hubVisionLookup). A prior fix made vision:true short-circuit ALL
    // further disk checks (correct for a disk-derived "cache" result), which
    // had the side effect of also freezing a "hub" result's unmeasured
    // tools:true forever, even after the real GGUF proved tool-less.
    const cache = fakeCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ path: "mmproj-BF16.gguf" }] }); // vision:true guess
    const env = { LLAMA_CACHE: cache };
    try {
      const before = await modelCapabilities("org/VisionButToolless-GGUF", env);
      assert.deepEqual(before, { vision: true, tools: true, source: "hub" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    // The download completes: the projector really did land (vision stays
    // true), but the real chat template turns out not to render tools.
    const snap = fakeRepoDir(cache, "org/VisionButToolless-GGUF");
    writeGguf(join(snap, "model-Q4_K_M.gguf"), {
      chatTemplate: "{{ bos_token }}{% for m in messages %}{{ m['content'] }}{% endfor %}",
    });
    writeFileSync(join(snap, "mmproj-BF16.gguf"), Buffer.alloc(16));

    const after = modelCapabilitiesSync("org/VisionButToolless-GGUF", env);
    assert.equal(after.vision, true);
    assert.equal(after.tools, false, "the hub guess's permissive tools:true must not survive real disk measurement");
    assert.equal(after.source, "cache");
  });

  test("edge: an empty/undefined model returns a safe blind result without throwing", async () => {
    assert.doesNotThrow(() => modelCapabilitiesSync(undefined));
    assert.doesNotThrow(() => modelCapabilitiesSync(""));
    assert.deepEqual(modelCapabilitiesSync(undefined), { vision: false, tools: true, source: "unknown" });
    assert.deepEqual(modelCapabilitiesSync(""), { vision: false, tools: true, source: "unknown" });
    await assert.doesNotReject(() => modelCapabilities(undefined));
  });

  test("modelCapabilitiesSync never touches the network for an uncached repo", () => {
    const cache = fakeCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => assert.fail("modelCapabilitiesSync must never call fetch");
    try {
      const result = modelCapabilitiesSync("org/NeverFetched-GGUF", { LLAMA_CACHE: cache });
      assert.deepEqual(result, { vision: false, tools: true, source: "unknown" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── G4 — real-cache oracle ─────────────────────────────────────────────────
// Independent ground truth, computed here (not via hasCachedMmproj) against
// whatever the developer's real ~/.cache/huggingface/hub actually holds.
// Skips cleanly in CI or any environment with no such cache.

function realCacheGroundTruth(root) {
  const results = [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("models--")) continue;
    const repo = entry.name.slice("models--".length).replace("--", "/");
    let revision;
    try { revision = readdirSync(join(root, entry.name, "snapshots"))[0]; } catch { continue; }
    if (!revision) continue;
    const snap = join(root, entry.name, "snapshots", revision);
    let files;
    try { files = readdirSync(snap); } catch { continue; }
    const vision = files.some(f => /^mmproj.*\.gguf$/i.test(f));
    results.push({ repo, vision });
  }
  return results;
}

describe("G4 — real HF cache oracle", () => {
  const HF_HUB = join(homedir(), ".cache", "huggingface", "hub");
  const groundTruth = existsSync(HF_HUB) ? realCacheGroundTruth(HF_HUB) : null;

  test("modelCapabilitiesSync().vision matches independently-computed disk truth for every real cached repo", { skip: !groundTruth || groundTruth.length === 0 }, () => {
    for (const { repo, vision } of groundTruth) {
      const result = modelCapabilitiesSync(repo, { LLAMA_CACHE: HF_HUB });
      assert.equal(result.vision, vision, `mismatch for ${repo}: expected vision=${vision}, got ${result.vision}`);
    }
  });
});
