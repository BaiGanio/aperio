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
