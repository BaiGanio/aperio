import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice } from "./backends.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`model facts store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("returns the curated catalog with one normalized shape", async () => {
      const rows = await store.getModelFacts();
      assert.equal(rows.length, 5);
      const qwen = rows.find(row => row.alias === "qwen3.6:35b-a3b-mtp");
      assert.ok(qwen);
      assert.deepEqual(qwen, {
        alias: "qwen3.6:35b-a3b-mtp",
        hf: "unsloth/Qwen3.6-35B-A3B-MTP-GGUF:UD-Q4_K_XL",
        sizeGB: 21.3,
        maxContext: 262144,
        kvBytesPerToken: 22528,
        architecture: "moe",
        activeParams: 3,
        mmproj: null,
      });
    });
  });
}
