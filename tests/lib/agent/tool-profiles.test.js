// tests/lib/agent/tool-profiles.test.js
//
// Regression test for issue #125: "extract data from docx into xlsx" produced a
// spreadsheet full of hallucinated content. Root cause — read_docx (the only
// on-disk .docx reader; read_file rejects the .docx extension) was registered
// as an MCP tool but absent from every TOOL_PROFILE, so the profile→tool filter
// never offered it to the model. A docx→xlsx prompt classified as file-generate
// got generate_xlsx but no docx reader, leaving the model to fabricate the data.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { classifyProfiles, TOOL_PROFILES } from "../../../lib/agent/tool-profiles.js";

function toolsFor(text) {
  const profiles = classifyProfiles(text);
  return new Set([...profiles].flatMap(p => [...(TOOL_PROFILES[p] ?? [])]));
}

describe("tool-profiles — read_docx availability (issue #125)", () => {
  test("docx→xlsx conversion prompt surfaces read_docx", () => {
    const tools = toolsFor("extract the data from 3a12f719-Aperio_Summary.docx into an xlsx file");
    assert.ok(tools.has("read_docx"), "model must be able to read the source .docx");
    assert.ok(tools.has("generate_xlsx"), "model must be able to write the .xlsx");
  });

  test("reading a .docx on disk surfaces read_docx", () => {
    assert.ok(toolsFor("read this .docx file on disk and summarize it").has("read_docx"));
    assert.ok(toolsFor("convert /tmp/report.docx to a spreadsheet").has("read_docx"));
  });
});

// Docgraph tools (doc_search, …) were registered as MCP tools but absent from
// every TOOL_PROFILE, so the profile→tool filter never offered them. A
// "use the doc_search tool…" prompt issued a native call to a tool the model
// was never given, which failed name recovery and surfaced the honest "couldn't
// issue the call correctly" fallback.
describe("tool-profiles — docgraph availability", () => {
  test("naming doc_search surfaces the docgraph tools", () => {
    const tools = toolsFor('use the doc_search tool to search for "LETTER OF CREDIT"');
    assert.ok(tools.has("doc_search"), "the named tool must be offered");
  });

  test("document-corpus retrieval phrasing surfaces doc_search", () => {
    assert.ok(toolsFor("search my documents for the invoice").has("doc_search"));
    assert.ok(toolsFor("find where I wrote about budgets in my notes").has("doc_search"));
  });

  test("a generic web search does not load docgraph", () => {
    assert.ok(!toolsFor("search the web for letter of credit").has("doc_search"));
  });
});
