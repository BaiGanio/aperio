// tests/lib/helpers/localBench.test.js
//
// llamacpp.md Phase 5: `npm run local:bench`'s pure logic. All fetch calls are
// mocked — no live llama-server needed (matches the doctrine startLlamaCpp.test.js
// already uses for injectable I/O).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeLoadMs, buildMediumPrompt, runBenchmark, formatReport } from "../../lib/helpers/localBench.js";

describe("computeLoadMs", () => {
  test("wall time minus prompt_ms+predicted_ms accounts for the one-time load cost", () => {
    assert.equal(computeLoadMs(3000, { prompt_ms: 200, predicted_ms: 300 }), 2500);
  });

  test("never goes negative on a warm request where timing accounts for ~all wall time", () => {
    assert.equal(computeLoadMs(100, { prompt_ms: 80, predicted_ms: 40 }), 0);
  });

  test("treats missing timings as fully unaccounted (whole wall time is 'load')", () => {
    assert.equal(computeLoadMs(500, null), 500);
    assert.equal(computeLoadMs(500, {}), 500);
  });
});

describe("buildMediumPrompt", () => {
  test("produces a prompt roughly at the target word count", () => {
    const p = buildMediumPrompt(600);
    const words = p.trim().split(/\s+/).length;
    assert.ok(words >= 600, `expected >= 600 words, got ${words}`);
    assert.ok(words < 900, `expected a reasonably tight overshoot, got ${words}`);
  });

  test("always ends with the summarization instruction", () => {
    assert.match(buildMediumPrompt(50), /Summarize the above in one sentence\.$/);
  });
});

describe("runBenchmark", () => {
  test("requires baseURL and model", async () => {
    await assert.rejects(() => runBenchmark({ model: "m" }), /baseURL/);
    await assert.rejects(() => runBenchmark({ baseURL: "http://x" }), /model/);
  });

  test("issues 3 requests (cold warmup, short, medium) and reports genTps + recommendation", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      const body = {
        usage: { prompt_tokens: 8, completion_tokens: 20 },
        timings: { prompt_ms: 50, prompt_per_second: 100, predicted_ms: 150, predicted_per_second: 40 },
      };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };

    const result = await runBenchmark({ fetchImpl, baseURL: "http://127.0.0.1:8080", model: "m", profile: "balanced", servedCtx: 16384 });

    assert.equal(calls.length, 3, "cold warmup + short + medium");
    assert.equal(result.model, "m");
    assert.equal(result.profile, "balanced");
    assert.equal(result.servedCtx, 16384);
    assert.equal(result.genTps, 40);
    assert.equal(result.recommendation, "Throughput is acceptable.");
    assert.ok(result.loadMs >= 0);
    // The medium prompt should carry a materially longer message than short.
    const mediumBody = calls[2];
    assert.ok(mediumBody.messages[0].content.length > calls[1].messages[0].content.length);
  });

  test("propagates an HTTP error from the server", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "boom" });
    await assert.rejects(
      () => runBenchmark({ fetchImpl, baseURL: "http://127.0.0.1:8080", model: "m" }),
      /HTTP 500/,
    );
  });

  test("recommendation reflects a slow gen tok/s", async () => {
    const fetchImpl = async () => {
      const body = {
        usage: { prompt_tokens: 8, completion_tokens: 20 },
        timings: { prompt_ms: 50, prompt_per_second: 100, predicted_ms: 4000, predicted_per_second: 2 },
      };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    const result = await runBenchmark({ fetchImpl, baseURL: "http://127.0.0.1:8080", model: "m", profile: "balanced" });
    assert.equal(result.genTps, 2);
    assert.equal(result.recommendation, "Try the fast-low-vram profile.");
  });
});

describe("formatReport", () => {
  test("renders every field, including a missing-timings fallback", () => {
    const report = formatReport({
      model: "m", profile: "balanced", servedCtx: null, loadMs: 1234,
      short: { usage: { prompt_tokens: 8, completion_tokens: 10 }, timings: null },
      medium: { usage: { prompt_tokens: 600, completion_tokens: 20 }, timings: { prompt_per_second: 90, predicted_per_second: 30 } },
      genTps: 30, recommendation: null,
    });
    assert.match(report, /llama\.cpp local benchmark/);
    assert.match(report, /model:\s+m/);
    assert.match(report, /ctx \(served\):\s+unknown/);
    assert.match(report, /load overhead:\s+1234 ms/);
    assert.match(report, /gen tok\/s:\s+30\.0/);
    assert.match(report, /recommendation unavailable/);
  });
});
