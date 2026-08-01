// tests/integration/db/contract/wiki.test.js
// Shared contract: wiki articles, run identically against a real SqliteStore
// and (opt-in) a real PostgresStore. See backends.js for why.
//
// Postgres has no store.wiki/store.selfWiki sub-store — its wiki logic lives
// in lib/handlers/wiki/wikiQueries.js as raw SQL behind `if (store.wiki) {...}
// else {...}` branches. Two coverage layers follow from that split:
//   1. Store-level: proposeWikiDraft/listWikiDrafts/publishWikiDraft exist
//      symmetrically on both stores (top-level convenience methods), so they
//      get the normal loop-driven contract test like every other domain.
//   2. Handler-level: the read path (search/list/get — hybrid RRF ranking,
//      tag/status filters) is the more complex, more drift-prone logic, and
//      it only exists unified in lib/handlers/wiki/wikiQueries.js. Those tests
//      call the wikiQueries functions directly against each real store.
// Self-wiki is out of scope here — see the follow-up GitHub issue.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { contractBackends, postgresSkipNotice, contractId } from "./backends.js";
import { randomEmbedding } from "./embeddings.js";
import { searchArticles, listArticles, getArticle } from "../../../../lib/handlers/wiki/wikiQueries.js";

postgresSkipNotice(test);

const generateEmbedding = async () => randomEmbedding();

for (const backend of await contractBackends()) {
  describe(`wiki store contract [${backend.name}]`, () => {
    let store;
    before(async () => { store = await backend.getStore(); });
    after(async () => { await backend.teardown(store); });

    test("proposeWikiDraft creates a draft that appears in listWikiDrafts", async () => {
      const slug = contractId("wiki-draft");
      const proposed = await store.proposeWikiDraft({
        slug, title: "Draft title", summary: "s", body_md: "# body", tags: ["contract"],
      });
      assert.equal(proposed.slug, slug);

      const drafts = await store.listWikiDrafts();
      assert.ok(drafts.some((d) => d.slug === slug));
    });

    test("publishWikiDraft flips a draft to fresh and removes it from listWikiDrafts", async () => {
      const slug = contractId("wiki-publish");
      await store.proposeWikiDraft({ slug, title: "To publish", body_md: "# body" });
      const published = await store.publishWikiDraft(slug);
      assert.equal(published.slug, slug);

      const drafts = await store.listWikiDrafts();
      assert.ok(!drafts.some((d) => d.slug === slug), "no longer a draft");
    });

    test("publishWikiDraft throws for an unknown slug", async () => {
      await assert.rejects(() => store.publishWikiDraft(contractId("missing")));
    });

    test("handler-level read path: list -> get -> fulltext search agree after publishing", async () => {
      const slug = contractId("wiki-read");
      const marker = contractId("marker");
      await store.proposeWikiDraft({
        slug, title: `Read path ${marker}`, summary: "summary",
        body_md: `# Heading\n\nBody mentioning ${marker}.`, tags: ["contract-read"],
      });
      await store.publishWikiDraft(slug);

      const listed = await listArticles(store, { tag: "contract-read" });
      assert.ok(listed.some((a) => a.slug === slug));

      const got = await getArticle(store, slug);
      assert.equal(got.slug, slug);
      assert.equal(got.status, "fresh");
      assert.ok(Array.isArray(got.sources));

      const results = await searchArticles(store, generateEmbedding, { query: marker, mode: "fulltext", limit: 10 });
      assert.ok(results.some((a) => a.slug === slug));
    });

    test("getArticle returns null for an unknown slug", async () => {
      assert.equal(await getArticle(store, contractId("missing")), null);
    });
  });
}
