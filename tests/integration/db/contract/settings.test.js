// tests/integration/db/contract/settings.test.js
// Shared contract: the settings k/v store surface, run identically against a
// real SqliteStore and (opt-in) a real PostgresStore. See backends.js for why.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`settings store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("getSetting returns null for a missing key", async () => {
      assert.equal(await store.getSetting(contractId("missing")), null);
    });

    test("setSetting -> getSetting round-trips a JSON value", async () => {
      const key = contractId("setting");
      const value = { nested: { flag: true, list: [1, 2, 3] } };
      await store.setSetting(key, value);
      assert.deepEqual(await store.getSetting(key), value);
      await store.deleteSetting(key);
    });

    test("setSetting overwrites an existing key", async () => {
      const key = contractId("overwrite");
      await store.setSetting(key, "v1");
      await store.setSetting(key, "v2");
      assert.equal(await store.getSetting(key), "v2");
      await store.deleteSetting(key);
    });

    test("getSettings includes a newly set key", async () => {
      const key = contractId("all-settings");
      await store.setSetting(key, "value");
      const all = await store.getSettings();
      assert.equal(all[key], "value");
      await store.deleteSetting(key);
    });

    test("deleteSetting reports whether a key existed", async () => {
      const key = contractId("delete-setting");
      await store.setSetting(key, "x");
      assert.equal(await store.deleteSetting(key), true);
      assert.equal(await store.deleteSetting(key), false);
      assert.equal(await store.getSetting(key), null);
    });
  });
}
