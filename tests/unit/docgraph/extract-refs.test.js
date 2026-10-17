// tests/lib/docgraph/extract-refs.test.js
// Unit tests for the shared reference extractor (Phase 5). Pure function.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractRefs } from "../../../lib/docgraph/extract-refs.js";

const valuesOf = (refs, kind) => refs.filter(r => r.kind === kind).map(r => r.value);

describe("extract-refs", () => {
  test("extracts ids, urls, emails, wikilinks, links, citations", () => {
    const text = [
      "Paid INV-204871 and JIRA-42 for patient MRN9981.",
      "See https://example.com/report and email alice@example.com.",
      "Cross-ref [[Other Note]] and [the spec](specs/plan.md).",
      "Per @smith2020 and arXiv:2405.12345 and doi: 10.1000/xyz.",
    ].join("\n");
    const refs = extractRefs(text);

    assert.deepEqual(valuesOf(refs, "id").sort(), ["INV-204871", "JIRA-42", "MRN9981"].sort());
    assert.ok(valuesOf(refs, "url").includes("https://example.com/report"));
    assert.ok(valuesOf(refs, "email").includes("alice@example.com"));
    assert.ok(valuesOf(refs, "wikilink").includes("Other Note"));
    assert.ok(valuesOf(refs, "link").includes("specs/plan.md"));
    assert.ok(valuesOf(refs, "citation").includes("@smith2020"));
    assert.ok(valuesOf(refs, "citation").some(v => /arXiv:2405\.12345/.test(v)));
  });

  test("dedupes within a text and trims trailing punctuation", () => {
    const refs = extractRefs("INV-1234, INV-1234. Visit https://x.io).");
    assert.equal(valuesOf(refs, "id").length, 1);
    assert.ok(valuesOf(refs, "url").includes("https://x.io"));
  });

  test("honors DOCGRAPH_REF_PATTERNS extra patterns", () => {
    const old = process.env.DOCGRAPH_REF_PATTERNS;
    process.env.DOCGRAPH_REF_PATTERNS = "\\bACME-\\d+\\b";
    try {
      const refs = extractRefs("ticket ACME-77 open");
      assert.ok(valuesOf(refs, "id").includes("ACME-77"));
    } finally {
      if (old) process.env.DOCGRAPH_REF_PATTERNS = old; else delete process.env.DOCGRAPH_REF_PATTERNS;
    }
  });

  test("empty / no-ref text yields nothing", () => {
    assert.deepEqual(extractRefs(""), []);
    assert.deepEqual(extractRefs("just plain prose with no references"), []);
  });
});
