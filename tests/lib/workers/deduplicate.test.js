import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { deduplicateMemories } from "../../../lib/workers/deduplicate.js";

const INITIAL_DELAY = 30_000;
const INTERVAL      = 10 * 60 * 1000;

// Drain the microtask queue so async callTool callbacks can settle
// after fake-timer callbacks fire synchronously.
const drain = () => new Promise(resolve => setImmediate(resolve));

describe("deduplicateMemories", () => {
  test("does not call callTool immediately on registration", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const calls = [];
    deduplicateMemories(async (name) => { calls.push(name); return "No result"; });

    assert.strictEqual(calls.length, 0);
  });

  test("calls callTool with correct args after the initial delay", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const calls = [];
    deduplicateMemories(async (name, args) => {
      calls.push({ name, args });
      return "No result";
    });

    t.mock.timers.tick(INITIAL_DELAY);
    await drain();
    await drain();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].name, "deduplicate_memories");
    assert.deepStrictEqual(calls[0].args, { threshold: 0.97, dry_run: true });
  });

  test("repeats on every interval tick after the initial run", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const calls = [];
    deduplicateMemories(async (name, args) => {
      calls.push({ name, args });
      return "No result";
    });

    t.mock.timers.tick(INITIAL_DELAY);
    await drain(); await drain();
    assert.strictEqual(calls.length, 1);

    t.mock.timers.tick(INTERVAL);
    await drain(); await drain();
    assert.strictEqual(calls.length, 2);

    t.mock.timers.tick(INTERVAL);
    await drain(); await drain();
    assert.strictEqual(calls.length, 3);
  });

  test("does not fire before the initial delay has elapsed", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const calls = [];
    deduplicateMemories(async () => { calls.push(1); return "No result"; });

    t.mock.timers.tick(INITIAL_DELAY - 1);
    assert.strictEqual(calls.length, 0);
  });

  test("silently swallows errors thrown by callTool", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    deduplicateMemories(async () => { throw new Error("network failure"); });

    t.mock.timers.tick(INITIAL_DELAY);
    await drain(); await drain();
    // reaching here without an unhandled rejection means the error was swallowed
    assert.ok(true);
  });

  test("logs when the result has more than one non-empty line", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const logged = [];
    t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));

    deduplicateMemories(async () => "duplicate pair found\nid: aaa\nid: bbb");

    t.mock.timers.tick(INITIAL_DELAY);
    await drain(); await drain();

    assert.ok(logged.some(l => l.includes("Deduplication")));
  });

  test("does not log when the result is a single non-empty line", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const logged = [];
    t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));

    deduplicateMemories(async () => "No duplicates found.");

    t.mock.timers.tick(INITIAL_DELAY);
    await drain(); await drain();

    assert.strictEqual(logged.length, 0);
  });

  test("does not log when the result is blank / empty", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });

    const logged = [];
    t.mock.method(console, "log", (...args) => logged.push(args.join(" ")));

    deduplicateMemories(async () => "");

    t.mock.timers.tick(INITIAL_DELAY);
    await drain(); await drain();

    assert.strictEqual(logged.length, 0);
  });
});
