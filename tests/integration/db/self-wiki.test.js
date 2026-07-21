// tests/db/self-wiki.test.js
// Store-level tests for self_wiki_articles on a real in-memory SqliteStore.
// self-wiki reuses the same SqliteWiki engine as the user-facing wiki (see
// db/sqlite.js), just against different tables — so these tests focus on
// what's actually new: staleness/revision triggers firing on self_memories
// (which update in place, unlike tombstoned memories), and THE WALL between
// store.wiki and store.selfWiki.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";

let oldPath, oldDims, store;
const emb = () => new Array(1024).fill(0).map(() => Math.random());

before(async () => {
  oldPath = process.env.SQLITE_PATH;
  oldDims = process.env.EMBEDDING_DIMS;
  process.env.SQLITE_PATH = ":memory:";
  process.env.EMBEDDING_DIMS = "4";
  const { SqliteStore } = await import("../../../db/sqlite.js");
  store = await SqliteStore.init();
});

after(() => {
  if (oldPath) process.env.SQLITE_PATH = oldPath; else delete process.env.SQLITE_PATH;
  if (oldDims) process.env.EMBEDDING_DIMS = oldDims; else delete process.env.EMBEDDING_DIMS;
  store?.close?.();
});

describe("self_wiki_articles CRUD (via store.selfWiki)", () => {
  test("upsert creates a new article (revision 1, fresh)", async () => {
    const { id, revision, inserted } = await store.selfWiki.upsert({
      slug: "create-me", title: "Create Me", summary: "s", body_md: "body",
      tags: ["t"], generated_by: "test", source_hash: "h",
    });
    assert.ok(id);
    assert.equal(revision, 1);
    assert.equal(inserted, true);

    const got = await store.selfWiki.get("create-me");
    assert.equal(got.status, "fresh");
    assert.equal(got.title, "Create Me");
    assert.deepEqual(got.tags, ["t"]);
  });

  test("upsert on an existing slug updates in place and bumps revision", async () => {
    await store.selfWiki.upsert({ slug: "bump-me", title: "V1", body_md: "b1", generated_by: "t", source_hash: "h1" });
    const { revision, inserted } = await store.selfWiki.upsert({ slug: "bump-me", title: "V2", body_md: "b2", generated_by: "t", source_hash: "h2" });
    assert.equal(revision, 2);
    assert.equal(inserted, false);

    const got = await store.selfWiki.get("bump-me");
    assert.equal(got.title, "V2");
    assert.equal(got.revision, 2);
  });

  test("get returns null for an unknown slug", async () => {
    assert.equal(await store.selfWiki.get("does-not-exist"), null);
  });

  test("get resolves source_memory_ids from self_wiki_article_sources", async () => {
    const sm = await store.insertSelf({ title: "Src", content: "c" }, null);
    await store.selfWiki.upsert({
      slug: "sourced", title: "Sourced", body_md: "b", generated_by: "t", source_hash: "h",
      source_memory_ids: [sm.id],
    });
    const got = await store.selfWiki.get("sourced");
    assert.deepEqual(got.source_memory_ids, [sm.id]);
  });
});

describe("self-wiki staleness + revision archiving (schema triggers)", () => {
  test("updating a cited self-memory marks the article stale", async () => {
    const sm = await store.insertSelf({ title: "Stale trigger src", content: "v1" }, null);
    await store.selfWiki.upsert({
      slug: "goes-stale", title: "Goes Stale", body_md: "b", generated_by: "t", source_hash: "h",
      source_memory_ids: [sm.id],
    });
    assert.equal((await store.selfWiki.get("goes-stale")).status, "fresh");

    await store.updateSelf(sm.id, { content: "v2 — changed" }, null);

    assert.equal((await store.selfWiki.get("goes-stale")).status, "stale");
  });

  test("re-writing a stale article via upsert clears status back to fresh", async () => {
    const sm = await store.insertSelf({ title: "Refresh src", content: "v1" }, null);
    await store.selfWiki.upsert({
      slug: "refreshed", title: "T", body_md: "b", generated_by: "t", source_hash: "h",
      source_memory_ids: [sm.id],
    });
    await store.updateSelf(sm.id, { content: "changed" }, null);
    assert.equal((await store.selfWiki.get("refreshed")).status, "stale");

    await store.selfWiki.upsert({
      slug: "refreshed", title: "T2", body_md: "b2", generated_by: "t", source_hash: "h2",
      source_memory_ids: [sm.id],
    });
    const got = await store.selfWiki.get("refreshed");
    assert.equal(got.status, "fresh");
    assert.equal(got.revision, 2);
  });

  test("a substantive update archives the prior revision", async () => {
    await store.selfWiki.upsert({ slug: "archived-rev", title: "V1", body_md: "b1", generated_by: "t", source_hash: "h1" });
    await store.selfWiki.upsert({ slug: "archived-rev", title: "V2", body_md: "b2", generated_by: "t", source_hash: "h2" });

    const rows = store.db.prepare(
      `SELECT r.revision AS revision, r.title AS title
         FROM self_wiki_article_revisions r
         JOIN self_wiki_articles a ON a.id = r.article_id
        WHERE a.slug = ?`
    ).all("archived-rev");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revision, 1);
    assert.equal(rows[0].title, "V1");
  });
});

// ── THE WALL ────────────────────────────────────────────────────────────────
describe("the wall — self-wiki and user wiki never cross", () => {
  test("self_wiki_write never creates a row in wiki_articles", async () => {
    await store.selfWiki.upsert({ slug: "wall-check", title: "T", body_md: "b", generated_by: "t", source_hash: "h" });
    const row = store.db.prepare(`SELECT * FROM wiki_articles WHERE slug = ?`).get("wall-check");
    assert.equal(row, undefined);
  });

  test("user wiki_write never creates a row in self_wiki_articles", async () => {
    await store.wiki.upsert({ slug: "user-wall-check", title: "T", body_md: "b", generated_by: "t", source_hash: "h" });
    const row = store.db.prepare(`SELECT * FROM self_wiki_articles WHERE slug = ?`).get("user-wall-check");
    assert.equal(row, undefined);
  });

  test("self-wiki staleness only reacts to self_memories, never to user memories", async () => {
    const selfMem = await store.insertSelf({ title: "Self fact", content: "v1" }, null);
    await store.selfWiki.upsert({
      slug: "cross-check", title: "T", body_md: "b", generated_by: "t", source_hash: "h",
      source_memory_ids: [selfMem.id],
    });

    // A user-memory write goes through a completely different table/trigger
    // (trg_memories_mark_wiki_stale targets wiki_articles, not self_wiki_articles)
    // — it must never affect this self-wiki article.
    await store.insert({ type: "fact", title: "Unrelated user fact", content: "v1", importance: 3 }, emb());
    assert.equal((await store.selfWiki.get("cross-check")).status, "fresh");
  });
});
