import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { checkLlamaCppModelServed, refreshRequestModel, regenerateArticle } from "../../lib/handlers/wiki/regenerate.js";

const originalFetch = globalThis.fetch;
const originalRefreshProvider = process.env.WIKI_REFRESH_PROVIDER;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalRefreshProvider === undefined) delete process.env.WIKI_REFRESH_PROVIDER;
  else process.env.WIKI_REFRESH_PROVIDER = originalRefreshProvider;
});

test("routes a DB-configured main model through the resident alias", () => {
  assert.equal(
    refreshRequestModel("db-configured-main", {
      name: "llamacpp",
      model: "db-configured-main",
      requestModel: "aperio-main",
    }),
    "aperio-main",
  );
});

test("keeps a distinct refresh model as its configured model", () => {
  assert.equal(
    refreshRequestModel("separate-refresh-model", {
      name: "llamacpp",
      model: "db-configured-main",
      requestModel: "aperio-main",
    }),
    "separate-refresh-model",
  );
});

test("reports a friendly error when the requested wiki model is not served", async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "served/model", aliases: ["aperio-main"] }] }),
  });

  assert.equal(
    await checkLlamaCppModelServed("missing/model"),
    "model not served: missing/model; loaded: served/model, aperio-main. Restart Aperio to pick up the preset.",
  );
});

test("regeneration stops before recall when the requested wiki model is not served", async () => {
  process.env.WIKI_REFRESH_PROVIDER = "llamacpp:missing/model";
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "served/model" }] }),
  });
  let recallCalled = false;
  const result = await regenerateArticle({
    store: {
      wiki: { get: async () => ({ slug: "topic", title: "Topic", body_md: "Old", source_memory_ids: [] }) },
      recall: async () => { recallCalled = true; return []; },
      cache: [],
    },
    generateEmbedding: async () => null,
  }, "topic");

  assert.equal(result.ok, false);
  assert.match(result.reason, /^model not served: missing\/model; loaded: served\/model\./);
  assert.equal(recallCalled, false);
});

test("preserves the existing unreachable-server path when loaded models cannot be read", async () => {
  globalThis.fetch = async () => { throw new Error("unreachable"); };
  assert.equal(await checkLlamaCppModelServed("missing/model"), null);
});
