// tests/integration/db/contract/memories.test.js
// Shared contract: the memories store surface, run identically against a real
// SqliteStore and (opt-in) a real PostgresStore. See backends.js for why.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";
import { randomEmbedding } from "./embeddings.js";

postgresSkipNotice(test);

for (const backend of await contractBackends()) {
  describe(`memories store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("insert -> getById roundtrips core fields", async () => {
      const title = contractId("insert");
      const row = await store.insert({ type: "fact", title, content: "hello", importance: 4 }, randomEmbedding());
      assert.equal(row.title, title);
      assert.equal(row.type, "fact");
      assert.equal(row.importance, 4);

      const fetched = await store.getById(row.id);
      assert.equal(fetched.id, row.id);
      assert.equal(fetched.content, "hello");

      await store.delete(row.id);
    });

    test("getById returns null for a missing id", async () => {
      assert.equal(await store.getById(contractId("missing")), null);
    });

    test("bulkInsert inserts every row and returns them in order", async () => {
      const a = contractId("bulk-a");
      const b = contractId("bulk-b");
      const rows = await store.bulkInsert([
        { type: "fact", title: a, content: "A" },
        { type: "fact", title: b, content: "B" },
      ]);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].title, a);
      assert.equal(rows[1].title, b);
      await store.delete(rows[0].id);
      await store.delete(rows[1].id);
    });

    test("bulkInsert returns [] for empty input", async () => {
      assert.deepEqual(await store.bulkInsert([]), []);
    });

    test("listAll surfaces a newly inserted current row", async () => {
      const title = contractId("listall");
      const row = await store.insert({ type: "fact", title, content: "x" });
      const all = await store.listAll();
      assert.ok(all.some((m) => m.id === row.id));
      await store.delete(row.id);
    });

    test("update tombstones the old version and returns a new row", async () => {
      const title = contractId("update");
      const row = await store.insert({ type: "fact", title, content: "v1" });
      const updated = await store.update(row.id, { content: "v2" });

      assert.notEqual(updated.id, row.id, "update creates a new bitemporal version");
      assert.equal(updated.content, "v2");
      assert.equal(updated.title, title, "unspecified fields carry over from the old version");

      const all = await store.listAll();
      assert.ok(!all.some((m) => m.id === row.id), "old version no longer current");
      assert.ok(all.some((m) => m.id === updated.id), "new version is current");

      await store.delete(updated.id);
    });

    test("update on an already-superseded id throws", async () => {
      const title = contractId("update-stale");
      const row = await store.insert({ type: "fact", title, content: "v1" });
      const updated = await store.update(row.id, { content: "v2" });
      await assert.rejects(() => store.update(row.id, { content: "v3" }));
      await store.delete(updated.id);
    });

    test("setPin reports whether a matching row was found", async () => {
      const title = contractId("pin");
      const row = await store.insert({ type: "fact", title, content: "x" });
      assert.equal(await store.setPin(row.id, true), true);
      assert.equal(await store.setPin(contractId("missing"), true), false, "unknown id — no change");
      await store.delete(row.id);
    });

    test("setExpiry reports whether it actually changed a row", async () => {
      const title = contractId("expiry");
      const row = await store.insert({ type: "fact", title, content: "x" });
      const future = new Date(Date.now() + 86400000).toISOString();
      assert.equal(await store.setExpiry(row.id, future), true);
      assert.equal(await store.setExpiry(contractId("missing"), future), false);
      await store.delete(row.id);
    });

    test("setEmbedding and clearAllEmbeddings affect listWithoutEmbeddings", async () => {
      const title = contractId("embed");
      const row = await store.insert({ type: "fact", title, content: "x" });
      let missing = await store.listWithoutEmbeddings();
      assert.ok(missing.some((m) => m.id === row.id), "no embedding yet");

      await store.setEmbedding(row.id, randomEmbedding());
      missing = await store.listWithoutEmbeddings();
      assert.ok(!missing.some((m) => m.id === row.id), "embedding was set");

      await store.delete(row.id);
    });

    test("delete returns the deleted title, then null on a second call", async () => {
      const title = contractId("delete");
      const row = await store.insert({ type: "fact", title, content: "x" });
      assert.equal(await store.delete(row.id), title);
      assert.equal(await store.delete(row.id), null);
    });

    test("counts() reports total/embedded/current as numbers", async () => {
      const counts = await store.counts();
      assert.equal(typeof counts.total, "number");
      assert.equal(typeof counts.embedded, "number");
      assert.equal(typeof counts.current, "number");
    });

    test("pending inbox: insert -> list -> approve promotes to a real memory", async () => {
      const title = contractId("pending-approve");
      const pending = await store.insertPending({ type: "fact", title, content: "draft" });
      assert.equal(pending.status, "pending");

      const listed = await store.listPending();
      assert.ok(listed.some((p) => p.id === pending.id));

      const approved = await store.approvePending(pending.id);
      assert.equal(approved.title, title);
      const promoted = await store.getById(approved.id);
      assert.ok(promoted, "approved pending memory became a real memory");

      await store.delete(approved.id);
    });

    test("pending inbox: concurrent approvals of the same id promote exactly once", async () => {
      const title = contractId("pending-race");
      const pending = await store.insertPending({ type: "fact", title, content: "draft" });

      const results = await Promise.allSettled([
        store.approvePending(pending.id),
        store.approvePending(pending.id),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, "exactly one concurrent approval wins");
      assert.equal(rejected.length, 1, "the other fails instead of silently double-promoting");

      const all = await store.recall({ query: title, mode: "fulltext", limit: 50 });
      const matches = all.filter((m) => m.title === title);
      assert.equal(matches.length, 1, "only one memory was promoted, not two");

      await store.delete(matches[0].id);
    });

    test("pending inbox: reject leaves no promoted memory behind", async () => {
      const title = contractId("pending-reject");
      const pending = await store.insertPending({ type: "fact", title, content: "draft" });
      const rejected = await store.rejectPending(pending.id);
      assert.equal(rejected.status, "rejected");
      assert.ok(!(await store.listPending()).some((p) => p.id === pending.id));
    });

    test("recall (fulltext) finds an inserted memory by content", async () => {
      const marker = contractId("recall-marker");
      const row = await store.insert({ type: "fact", title: marker, content: `unique payload ${marker}` });
      const results = await store.recall({ query: marker, mode: "fulltext", limit: 10 });
      assert.ok(results.some((m) => m.id === row.id));
      await store.delete(row.id);
    });

    test("findDuplicates + mergeDuplicate merge two near-identical rows", async () => {
      const vec = randomEmbedding();
      const titleA = contractId("dup-a");
      const titleB = contractId("dup-b");
      const a = await store.insert({ type: "fact", title: titleA, content: "same content" }, vec);
      const b = await store.insert({ type: "fact", title: titleB, content: "same content" }, vec);

      const dups = await store.findDuplicates(0.99);
      assert.ok(dups.some((d) => (d.id_a === a.id && d.id_b === b.id) || (d.id_a === b.id && d.id_b === a.id)));

      await store.mergeDuplicate(a.id, b.id);
      assert.equal(await store.getById(b.id), null, "b was absorbed into a");
      assert.ok(await store.getById(a.id), "a survives the merge");

      await store.delete(a.id);
    });
  });
}
