import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync, existsSync, writeFileSync } from "fs";
import { EventEmitter } from "events";
import net from "net";

// =============================================================================
// bootstrap.js — exported constants, state, and utilities
// =============================================================================
describe("bootstrap.js exports", () => {
  let bootstrapEvents, STEPS, stepState, isBootstrapped, getBootstrapMeta;

  before(async () => {
    const mod = await import("../../bootstrap.js");
    bootstrapEvents = mod.bootstrapEvents;
    STEPS            = mod.STEPS;
    stepState        = mod.stepState;
    isBootstrapped   = mod.isBootstrapped;
    getBootstrapMeta = mod.getBootstrapMeta;
  });

  test("STEPS has the expected 5-step structure", () => {
    assert.ok(Array.isArray(STEPS));
    assert.equal(STEPS.length, 5);
    const ids = STEPS.map(s => s.id);
    assert.deepEqual(ids, ["node", "deps", "engine", "model", "sqlite"]);
    for (const step of STEPS) {
      assert.ok(typeof step.id === "string" && step.id.length > 0);
      assert.ok(typeof step.label === "string" && step.label.length > 0);
      assert.ok(typeof step.icon === "string" && step.icon.length > 0);
    }
  });

  test("stepState has one entry per step, all initialised to 'idle'", () => {
    for (const step of STEPS) {
      assert.ok(step.id in stepState);
      assert.equal(stepState[step.id], "idle");
    }
  });

  test("stepState has no extra keys beyond STEPS", () => {
    const expected = new Set(STEPS.map(s => s.id));
    const actualKeys = Object.keys(stepState);
    for (const key of actualKeys) {
      assert.ok(expected.has(key), `stepState has unexpected key: ${key}`);
    }
  });

  test("bootstrapEvents is an EventEmitter with maxListeners > 10", () => {
    assert.ok(bootstrapEvents instanceof EventEmitter);
    assert.equal(typeof bootstrapEvents.emit, "function");
    assert.equal(typeof bootstrapEvents.on, "function");
    assert.ok(bootstrapEvents.getMaxListeners() > 10);
  });
});

// =============================================================================
// getEphemeralPort — find a free OS-assigned port
// =============================================================================
describe("getEphemeralPort", () => {
  test("returns a positive integer port number", async () => {
    const { getEphemeralPort } = await import("../../bootstrap.js");
    const port = await getEphemeralPort();
    assert.ok(Number.isInteger(port));
    assert.ok(port > 0 && port < 65536);
  });

  test("the returned port can actually be bound", async () => {
    const { getEphemeralPort } = await import("../../bootstrap.js");
    const port = await getEphemeralPort();
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.close(); resolve(); });
    });
  });

  test("two consecutive calls return different ports", async () => {
    const { getEphemeralPort } = await import("../../bootstrap.js");
    const [a, b] = await Promise.all([getEphemeralPort(), getEphemeralPort()]);
    assert.notEqual(a, b);
  });
});

// =============================================================================
// isBootstrapped / getBootstrapMeta — lock file interactions
// =============================================================================
describe("isBootstrapped / getBootstrapMeta", () => {
  test("isBootstrapped returns false when no lock file exists", async () => {
    // Ensure no lock file
    if (existsSync("var/bootstrap.lock")) unlinkSync("var/bootstrap.lock");

    const { isBootstrapped } = await import("../../bootstrap.js");
    assert.equal(isBootstrapped(), false);
  });

  test("getBootstrapMeta returns null when no lock file exists", async () => {
    const { getBootstrapMeta } = await import("../../bootstrap.js");
    assert.strictEqual(getBootstrapMeta(), null);
  });

  test("isBootstrapped returns true after creating the lock file", async () => {
    writeFileSync("var/bootstrap.lock", JSON.stringify({
      completedAt: new Date().toISOString(),
      model: "test-model",
      engine: "llamacpp",
    }));

    const { isBootstrapped, getBootstrapMeta } = await import("../../bootstrap.js");
    assert.equal(isBootstrapped(), true);

    const meta = getBootstrapMeta();
    assert.notStrictEqual(meta, null);
    assert.equal(meta.model, "test-model");
    assert.equal(meta.engine, "llamacpp");
  });

  test("restore: remove test lock file", () => {
    if (existsSync("var/bootstrap.lock")) unlinkSync("var/bootstrap.lock");
  });
});

// =============================================================================
// runBootstrap — exports the function (smoke test only; full run is e2e)
// =============================================================================
describe("runBootstrap export", () => {
  test("runBootstrap and killActivePriming are exported as functions", async () => {
    const { runBootstrap, killActivePriming } = await import("../../bootstrap.js");
    assert.equal(typeof runBootstrap, "function");
    assert.equal(typeof killActivePriming, "function");
  });
});
