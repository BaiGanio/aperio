// tests/integration/db/contract/import-export.test.js
// Shared contract: exportAll/importAll and the whitelisted table browser, run
// identically against a real SqliteStore and (opt-in) a real PostgresStore.
// See backends.js for why.
//
// One asymmetry is unavoidable here, not a backend-API difference: SqliteStore
// trivially gives a second, truly empty ":memory:" instance to import into,
// while PostgresStore.init() always points at the SAME real database (there's
// no "second empty Postgres" without provisioning a whole extra DB). So the
// full export -> fresh-store -> import round-trip only runs for SQLite; every
// backend still gets the idempotent-reimport and listTables/readTable checks,
// which don't need a second instance.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`import/export store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("exportAll includes a freshly inserted memory and self-memory", async () => {
      const title = contractId("export-memory");
      const selfTitle = contractId("export-self");
      const mem = await store.insert({ type: "fact", title, content: "exported" });
      const self = await store.insertSelf({ title: selfTitle, content: "exported self" });

      const bundle = await store.exportAll();
      assert.ok(Array.isArray(bundle.memories));
      assert.ok(Array.isArray(bundle.wiki_articles));
      assert.ok(Array.isArray(bundle.agent_jobs));
      assert.ok(Array.isArray(bundle.agent_runs));
      assert.ok(Array.isArray(bundle.self_memories));
      assert.ok(bundle.memories.some((m) => m.id === mem.id && m.title === title));
      assert.ok(bundle.self_memories.some((m) => m.id === self.id && m.title === selfTitle));

      await store.delete(mem.id);
      await store.deleteSelf(self.id);
    });

    test("importAll is idempotent — re-importing an already-present memory is skipped", async () => {
      const title = contractId("reimport");
      const mem = await store.insert({ type: "fact", title, content: "x" });
      const bundle = await store.exportAll();
      const result = await store.importAll({ memories: bundle.memories.filter((m) => m.id === mem.id) });
      assert.equal(result.imported.memories, 0, "already exists — nothing new imported");
      assert.equal(result.skipped.memories, 1);
      await store.delete(mem.id);
    });

    test("listTables reports counts for every whitelisted table", async () => {
      const tables = await store.listTables();
      const names = tables.map((t) => t.name);
      assert.ok(names.includes("memories"));
      assert.ok(names.includes("settings"));
      for (const t of tables) assert.equal(typeof t.count, "number");
    });

    test("readTable returns columns and rows for a whitelisted table", async () => {
      const { columns, rows } = await store.readTable("settings");
      assert.ok(Array.isArray(columns));
      assert.ok(Array.isArray(rows));
    });

    test("readTable rejects a non-whitelisted table name", async () => {
      await assert.rejects(() => store.readTable("sqlite_master"));
    });
  });
}

// ── SQLite-only: full round-trip into a second, genuinely empty instance ────
{
  const sqliteBackend = (await contractBackends()).find((b) => b.name === "sqlite");
  describe("import/export full round-trip [sqlite, two independent instances]", () => {
    let source, target;
    before(async () => {
      source = await sqliteBackend.getStore();
      target = await sqliteBackend.getStore();
    });
    after(async () => {
      await sqliteBackend.teardown(source);
      await sqliteBackend.teardown(target);
    });

    test("exportAll from a populated store imports cleanly into an empty one", async () => {
      const title = contractId("roundtrip-memory");
      const mem = await source.insert({ type: "fact", title, content: "roundtrip" });

      const bundle = await source.exportAll();
      const beforeCount = (await target.counts()).current;
      const result = await target.importAll(bundle);
      assert.ok(result.imported.memories >= 1);

      const afterCount = (await target.counts()).current;
      assert.ok(afterCount > beforeCount);

      const imported = await target.getById(mem.id);
      assert.ok(imported, "the exact memory id carried over");
      assert.equal(imported.title, title);
    });
  });
}
