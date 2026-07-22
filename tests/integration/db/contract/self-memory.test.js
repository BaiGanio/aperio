// tests/integration/db/contract/self-memory.test.js
// Shared contract: the self_memories store surface, run identically against a
// real SqliteStore and (opt-in) a real PostgresStore. See backends.js for why.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";
import { randomEmbedding } from "./embeddings.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`self-memory store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("insertSelf -> getSelfById roundtrips core fields", async () => {
      const title = contractId("self-insert");
      const row = await store.insertSelf({ title, content: "note to self", importance: 4 }, randomEmbedding());
      assert.equal(row.title, title);
      assert.equal(row.importance, 4);

      const fetched = await store.getSelfById(row.id);
      assert.equal(fetched.title, title);

      await store.deleteSelf(row.id);
    });

    test("getSelfById returns null for a missing id", async () => {
      assert.equal(await store.getSelfById(contractId("missing")), null);
    });

    test("listSelf clamps its limit and includes a newly inserted row", async () => {
      const title = contractId("self-list");
      const row = await store.insertSelf({ title, content: "x", importance: 5 });
      const list = await store.listSelf(500); // above the 200 cap
      assert.ok(Array.isArray(list));
      assert.ok(list.length <= 200);
      assert.ok(list.some((m) => m.id === row.id));
      await store.deleteSelf(row.id);
    });

    test("updateSelf edits in place — same id, new content", async () => {
      const title = contractId("self-update");
      const row = await store.insertSelf({ title, content: "v1", importance: 3 });
      const updated = await store.updateSelf(row.id, { content: "v2", importance: 1 });
      assert.equal(updated.id, row.id, "self-memory updates in place, no versioning");
      assert.equal(updated.content, "v2");
      assert.equal(updated.importance, 1);
      await store.deleteSelf(row.id);
    });

    test("setSelfEmbedding replaces the vector without erroring", async () => {
      const title = contractId("self-embed");
      const row = await store.insertSelf({ title, content: "x" });
      await store.setSelfEmbedding(row.id, randomEmbedding());
      await store.deleteSelf(row.id);
    });

    test("deleteSelf returns the deleted title, then null on a second call", async () => {
      const title = contractId("self-delete");
      const row = await store.insertSelf({ title, content: "x" });
      assert.equal(await store.deleteSelf(row.id), title);
      assert.equal(await store.deleteSelf(row.id), null);
    });

    test("recallSelf (fulltext) finds an inserted self-memory by content", async () => {
      const marker = contractId("self-recall");
      const row = await store.insertSelf({ title: marker, content: `unique self payload ${marker}` });
      const results = await store.recallSelf({ query: marker, mode: "fulltext", limit: 10 });
      assert.ok(results.some((m) => m.id === row.id));
      await store.deleteSelf(row.id);
    });

    test("a self-memory never appears in the user recall/listAll surface", async () => {
      const marker = contractId("self-wall");
      const row = await store.insertSelf({ title: marker, content: marker, importance: 5 });
      const recall = await store.recall({ query: marker, mode: "fulltext", limit: 50 });
      const all = await store.listAll();
      assert.ok(!recall.some((m) => m.title === marker), "user recall leaked a self-note");
      assert.ok(!all.some((m) => m.title === marker), "user listAll leaked a self-note");
      await store.deleteSelf(row.id);
    });
  });
}
