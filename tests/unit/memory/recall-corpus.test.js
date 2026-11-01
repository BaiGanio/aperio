// tests/unit/memory/recall-corpus.test.js — WS0 group G0-2 (memory-compaction EPIC #286)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(
  join(__dirname, "../../fixtures/memory-compaction/recall-corpus.json"), "utf8"
)).queries;
const examTitles = new Set(
  JSON.parse(readFileSync(
    join(__dirname, "../../../.github/capability-exam/exam.memories.json"), "utf8"
  )).memories.map(m => m.title)
);

describe("memory-compaction recall corpus", () => {
  test("every expectedTitles entry exists verbatim in exam.memories.json", () => {
    for (const q of corpus) {
      for (const title of q.expectedTitles) {
        assert.ok(examTitles.has(title), `corpus entry "${q.id}" names a title not in exam.memories.json: ${JSON.stringify(title)}`);
      }
    }
  });

  test("has at least 6 semantic and 6 keyword queries", () => {
    const semantic = corpus.filter(q => q.category === "semantic");
    const keyword = corpus.filter(q => q.category === "keyword");
    assert.ok(semantic.length >= 6, `expected >=6 semantic queries, got ${semantic.length}`);
    assert.ok(keyword.length >= 6, `expected >=6 keyword queries, got ${keyword.length}`);
  });

  test("keyword queries are literal phrases, not prose describing a tag/type filter", () => {
    // Regression guard for the corpus bug found while implementing WS0: prose like
    // "show me everything tagged X" never appears in memory content/title, so it
    // scores a meaningless 0% against search_mode=fulltext — a corpus bug, not a
    // recall regression. Keyword queries must not start with list/filter phrasing.
    const banned = /^(show|list|find|search for)\b.*\b(tagged|type:)/i;
    for (const q of corpus.filter(q => q.category === "keyword")) {
      assert.ok(!banned.test(q.query), `keyword query "${q.id}" looks like filter prose, not a literal phrase: ${JSON.stringify(q.query)}`);
    }
  });

  test("every query has at least one expected title", () => {
    for (const q of corpus) {
      assert.ok(Array.isArray(q.expectedTitles) && q.expectedTitles.length >= 1, `corpus entry "${q.id}" has no expectedTitles`);
    }
  });
});
