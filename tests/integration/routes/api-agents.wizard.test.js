// tests/integration/routes/api-agents.wizard.test.js
//
// POST /agents/wizard needs a stubbable `complete()` call, which apiRouter()
// doesn't thread through (it always uses the live helpers/completion.js).
// Exercised here against mountAgentRoutes directly, mirroring the invoke()
// helper in api.test.js.

import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { mountAgentRoutes } from "../../../lib/routes/api-agents.js";
import logger from "../../../lib/helpers/logger.js";

before(() => {
  mock.method(logger, "error", () => {});
});

after(() => mock.restoreAll());

function invoke(router, method, url, { body = {} } = {}) {
  return new Promise((resolve) => {
    const req = { method: method.toUpperCase(), url, path: url, body, query: {}, params: {}, headers: {} };
    const res = {
      _status: 200,
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

const TOOLS = [{
  name: "backfill_embeddings",
  description: "Backfill",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", minimum: 1, maximum: 100 } },
    required: [],
    additionalProperties: false,
  },
}];

function makeRouter({ agent = { mcpTools: TOOLS }, complete } = {}) {
  const router = Router();
  mountAgentRoutes(router, { store: {}, agent, complete });
  return router;
}

describe("POST /agents/wizard", () => {
  test("400 without a description", async () => {
    const router = makeRouter({ complete: async () => "" });
    const { status, body } = await invoke(router, "POST", "/agents/wizard", { body: {} });
    assert.strictEqual(status, 400);
    assert.match(body.error, /description/);
  });

  test("turns a steps suggestion into a draft job, id slugified", async () => {
    const complete = mock.fn(async () => JSON.stringify({
      id: "Nightly Cleanup!",
      mode: "steps",
      trigger: { kind: "interval", everyMs: 3600000 },
      steps: [{ tool: "backfill_embeddings", input: { limit: 20 } }],
    }));
    const router = makeRouter({ complete });
    const { status, body } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "every hour, backfill embeddings" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.job.id, "nightly-cleanup");
    assert.strictEqual(body.job.enabled, false);
    assert.deepStrictEqual(body.job.trigger, { kind: "interval", everyMs: 3600000 });
    assert.deepStrictEqual(body.job.steps, [{ tool: "backfill_embeddings", input: { limit: 20 } }]);
    assert.deepStrictEqual(body.warnings, []);
    assert.strictEqual(complete.mock.callCount(), 1);
  });

  test("turns a freeform suggestion into a draft job", async () => {
    const complete = async () => "```json\n" + JSON.stringify({
      id: "weekly-digest",
      mode: "freeform",
      trigger: { kind: "interval", everyMs: 604800000 },
      prompt: "Summarise recent memories in 3 bullets.",
      timeoutMs: 120000,
    }) + "\n```";
    const router = makeRouter({ complete });
    const { status, body } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "every week, summarise my memories" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.job.prompt, "Summarise recent memories in 3 bullets.");
    assert.strictEqual(body.job.timeoutMs, 120000);
    assert.strictEqual(body.job.steps, undefined);
  });

  test("surfaces validation warnings without failing the suggestion", async () => {
    const complete = async () => JSON.stringify({
      id: "bad-steps",
      mode: "steps",
      steps: [{ tool: "imaginary_tool", input: {} }],
    });
    const router = makeRouter({ complete });
    const { status, body } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "do something imaginary" },
    });
    assert.strictEqual(status, 200);
    assert.match(body.warnings[0], /imaginary_tool.*not registered/);
  });

  test("502 when the model does not return usable JSON", async () => {
    const router = makeRouter({ complete: async () => "sorry, I can't help with that" });
    const { status, body } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "do a thing" },
    });
    assert.strictEqual(status, 502);
    assert.match(body.error, /try rephrasing/);
  });

  test("502 when steps/prompt are both missing from an otherwise valid object", async () => {
    const router = makeRouter({ complete: async () => JSON.stringify({ id: "empty" }) });
    const { status, body } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "do a thing" },
    });
    assert.strictEqual(status, 502);
    assert.match(body.error, /try rephrasing/);
  });

  test("503 while the agent is still warming up", async () => {
    const router = makeRouter({ agent: null, complete: async () => "{}" });
    const { status } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "do a thing" },
    });
    assert.strictEqual(status, 503);
  });

  test("defaults an unrecognized trigger kind to manual", async () => {
    const complete = async () => JSON.stringify({
      id: "manual-job",
      mode: "freeform",
      trigger: { kind: "whenever" },
      prompt: "do a thing",
    });
    const router = makeRouter({ complete });
    const { body } = await invoke(router, "POST", "/agents/wizard", {
      body: { description: "whenever I feel like it" },
    });
    assert.deepStrictEqual(body.job.trigger, { kind: "manual" });
  });
});
