// Wiki route coverage against the booted real-app fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRealApp, request } from "../helpers/real-app-helper.js";

test("Wiki API tests", async (t) => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "aperio-wiki-"));
  const dbPath = join(scratchRoot, "aperio-test.db");

  const fixture = await startRealApp(t, {
    readyTimeout: 25_000,
    env: {
      APERIO_E2E_SKIP_BOOT: "0",
      APERIO_E2E_INJECT_AGENT: "1",
      DB_BACKEND: "sqlite",
      SQLITE_PATH: dbPath,
      AI_PROVIDER: "stub",
      EMBEDDING_PROVIDER: "none",
      APERIO_CODEGRAPH: "off",
      APERIO_DOCGRAPH: "off",
      IDLE_SHUTDOWN: "off",
      APERIO_CONFIG_PRECEDENCE: "env",
    },
  });

  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  });

  const article = {
    slug: "test-e2e-wiki",
    title: "E2E Wiki Test",
    summary: "e2e summary",
    body_md: "Test content for e2e wiki coverage",
    tags: ["e2e"],
    generated_by: "e2e-test",
    revision: 1,
  };

  await t.test("imports and lists a wiki article", async () => {
    const importRes = await request(fixture, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ memories: [], wiki_articles: [article] }),
    });

    assert.equal(importRes.status, 200, "Import succeeds");
    assert.equal(importRes.json.imported.wiki, 1, "One wiki article imported");

    const listRes = await request(fixture, "/api/wiki/list");
    assert.equal(listRes.status, 200, "Wiki list succeeds");
    assert.ok(
      listRes.json.articles.some((candidate) => candidate.slug === article.slug),
      "Imported article appears in the list",
    );

    const searchRes = await request(fixture, "/api/wiki/search?q=E2E%20Wiki");
    assert.equal(searchRes.status, 200, "Wiki search succeeds");
    assert.ok(
      searchRes.json.articles.some((candidate) => candidate.slug === article.slug),
      "Search finds the imported article",
    );
  });

  await t.test("returns article details and handles missing articles", async () => {
    const articleRes = await request(fixture, `/api/wiki/article/${article.slug}`);
    assert.equal(articleRes.status, 200, "Article lookup succeeds");
    assert.equal(articleRes.json.slug, article.slug);
    assert.equal(articleRes.json.title, article.title);
    assert.equal(articleRes.json.body_md, article.body_md);
    assert.equal(articleRes.json.revision, article.revision);
    assert.deepEqual(articleRes.json.tags, article.tags);

    const missingRes = await request(fixture, "/api/wiki/article/does-not-exist");
    assert.equal(missingRes.status, 404, "Missing article returns 404");
  });

  await t.test("duplicate import is skipped and empty search is rejected", async () => {
    const duplicateRes = await request(fixture, "/api/data/import", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ memories: [], wiki_articles: [article] }),
    });

    assert.equal(duplicateRes.status, 200, "Duplicate import succeeds idempotently");
    assert.equal(duplicateRes.json.imported.wiki, 0);
    assert.equal(duplicateRes.json.skipped.wiki, 1);

    const emptySearchRes = await request(fixture, "/api/wiki/search?q=");
    assert.equal(emptySearchRes.status, 400, "Empty search query is rejected");
  });
});
