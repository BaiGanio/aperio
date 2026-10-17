import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  factsForHf,
  getModelFactsCatalog,
  hydrateModelFacts,
  installModelFacts,
  modelDisplayName,
  resolveModelFacts,
} from "../../../lib/providers/model-facts.js";

const rows = [{
  alias: "test:7b",
  hf: "example/Test-7B-GGUF:Q4_K_M",
  sizeGB: 4.2,
  maxContext: 65536,
  kvBytesPerToken: 4096,
  architecture: "dense",
  activeParams: null,
  mmproj: null,
}];

afterEach(() => installModelFacts([]));

describe("database-backed model facts snapshot", () => {
  test("hydrates once from the store for synchronous consumers", async () => {
    let reads = 0;
    await hydrateModelFacts({
      async getModelFacts() {
        reads++;
        return rows;
      },
    });

    assert.equal(reads, 1);
    assert.deepEqual(getModelFactsCatalog(), { "test:7b": {
      hf: rows[0].hf,
      sizeGB: 4.2,
      maxContext: 65536,
      kvBytesPerToken: 4096,
      architecture: "dense",
    } });
    assert.equal(factsForHf("example/Test-7B-GGUF"), getModelFactsCatalog()["test:7b"]);
    assert.equal(modelDisplayName(rows[0].hf), "test:7b");
    assert.equal(resolveModelFacts("TEST:7B", { LLAMA_CACHE: "/definitely/not/a/cache" }),
      getModelFactsCatalog()["test:7b"]);
  });

  test("DB-configured JSON overrides win before catalog facts", () => {
    installModelFacts(rows);
    const override = { sizeGB: 1, maxContext: 2048, kvBytesPerToken: 128 };
    const facts = resolveModelFacts(rows[0].hf, {
      LLAMA_CACHE: "/definitely/not/a/cache",
      APERIO_MODEL_FACTS_OVERRIDES: JSON.stringify({ "example/Test-7B-GGUF": override }),
    });
    assert.deepEqual(facts, override);
  });

  test("an empty snapshot falls back conservatively", () => {
    installModelFacts([]);
    const facts = resolveModelFacts("example/Unknown-GGUF", {
      LLAMA_CACHE: "/definitely/not/a/cache",
    });
    assert.equal(facts.sizeGB, 8);
    assert.equal(facts.kvBytesPerToken, 524288);
  });
});
