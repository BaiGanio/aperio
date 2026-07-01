// tests/lib/helpers/startOllama.test.js
import { describe, test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import child_process from "node:child_process";
import { ensureOllama } from "../../../lib/helpers/startOllama.js";

// Prevent real ollama binary from being spawned in any environment
mock.method(child_process, "spawn", () => ({
  on: mock.fn(),
  unref: mock.fn(),
}));

// fetch is a global in the module under test — we can replace it directly
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetchSequence(...responses) {
  let i = 0;
  globalThis.fetch = async () => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return res;
  };
}

// =============================================================================
describe("ensureOllama", () => {

  test("resolves immediately when Ollama is already running", async () => {
    globalThis.fetch = async () => ({ ok: true });
    await ensureOllama(); // should not throw
  });

  test("resolves when Ollama is already running regardless of other fields", async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200 });
    await ensureOllama();
  });

  test("returns when isOllamaUp returns true on first check", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return { ok: true };
    };
    await ensureOllama();
    assert.equal(fetchCallCount, 1);
  });

  test("throws when Ollama does not start within timeout", { timeout: 20_000 }, async (t) => {
    // Mock fetch to always return not-ok so the poll loop never exits
    globalThis.fetch = async () => ({ ok: false });

    // Enable fake Date and setTimeout to avoid a real 15-second wait
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });

    const p = ensureOllama().catch(e => e);

    // Let the initial isOllamaUp fetch complete (real microtask)
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    // Advance fake time past MAX_WAIT_MS (15 000 ms) and fire the poll setTimeout
    t.mock.timers.tick(16_000);

    // Let the poll loop's isOllamaUp fetch + while-condition check complete
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    const err = await p;
    assert.ok(err instanceof Error, `Expected Error, got: ${err}`);
    assert.match(err.message, /15 s/);
  });
});
