// tests/lib/agent/tool-profiles.test.js
//
// Regression test for issue #125: "extract data from docx into xlsx" produced a
// spreadsheet full of hallucinated content. Root cause — read_docx (the only
// on-disk .docx reader; read_file rejects the .docx extension) was registered
// as an MCP tool but absent from every TOOL_PROFILE, so the profile→tool filter
// never offered it to the model. A docx→xlsx prompt classified as file-generate
// got generate_xlsx but no docx reader, leaving the model to fabricate the data.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { classifyProfiles, TOOL_PROFILES, capToolsForWindow, SMALL_WINDOW_TOKENS, SMALL_WINDOW_MAX_TOOLS, isCapableModel, needsRecallScaffold } from "../../../lib/agent/tool-profiles.js";

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
    assert.ok(toolsFor("check this PDF and find me similar documents with a Customer ID field").has("doc_search"));
  });

  test("a generic web search does not load docgraph", () => {
    assert.ok(!toolsFor("search the web for letter of credit").has("doc_search"));
  });
});

// The self-memory quad is always available (like the user-memory quad) so the
// agent can keep its own continuity on any turn. The provider gate that strips
// these on cloud lives in lib/agent/index.js, not in classifyProfiles.
describe("tool-profiles — self-memory always offered", () => {
  test("an ordinary prompt surfaces the self_* quad", () => {
    const tools = toolsFor("help me think through this");
    for (const t of ["self_remember", "self_recall", "self_update", "self_forget"]) {
      assert.ok(tools.has(t), `${t} must always be offered`);
    }
  });
});

// capToolsForWindow: a tiny served window (e.g. gemma4:12b at ~6k) can't hold
// the full re-sent schema set plus a tool result, so cap the attached tools.
describe("capToolsForWindow", () => {
  const bigWin = SMALL_WINDOW_TOKENS + 1;
  const smallWin = SMALL_WINDOW_TOKENS - 1;

  test("leaves a large window untouched", () => {
    const names = new Set(["recall", "remember", "fetch_github_issue", "fetch_url", "read_file", "scan_project", "code_search", "doc_search", "db_query", "web_search", "export_data", "import_data"]);
    assert.equal(capToolsForWindow(names, bigWin), names, "returns the same set unchanged");
  });

  test("leaves a small window untouched when already within budget", () => {
    const names = new Set(["recall", "remember", "fetch_github_issue"]);
    assert.equal(capToolsForWindow(names, smallWin), names);
  });

  test("caps to the budget on a small window", () => {
    const names = new Set(Array.from({ length: 20 }, (_, i) => `t${i}`).concat("recall"));
    const capped = capToolsForWindow(names, smallWin);
    assert.equal(capped.size, SMALL_WINDOW_MAX_TOOLS);
  });

  test("keeps recall (the memory floor) and the turn's intent tools over baseline", () => {
    // 12 memory/self/data baseline names + recall + an intent tool. On a small
    // window the intent tool and recall must survive the cap.
    const core = [...TOOL_PROFILES.memory, ...TOOL_PROFILES.self, ...TOOL_PROFILES.data];
    const names = new Set([...core, "fetch_github_issue"]);
    const capped = capToolsForWindow(names, smallWin);
    assert.ok(capped.has("recall"), "recall floor survives");
    assert.ok(capped.has("fetch_github_issue"), "the turn's intent tool survives the cap");
  });
});

// needsRecallScaffold: a second, finer gate below isCapableModel (issue #188).
// isCapableModel decides tools + the neutral memory pointer. needsRecallScaffold
// decides the behavior-*overriding* crutch (forced auto-recall injection) — a
// model can be capable without needing the scaffold, so the two must not share
// a single threshold.
describe("needsRecallScaffold (issue #188 capability-gate doctrine)", () => {
  let saved;
  beforeEach(() => {
    saved = {
      APERIO_CAPABLE_MODELS: process.env.APERIO_CAPABLE_MODELS,
      APERIO_RECALL_SCAFFOLD_MODELS: process.env.APERIO_RECALL_SCAFFOLD_MODELS,
    };
    delete process.env.APERIO_CAPABLE_MODELS;
    delete process.env.APERIO_RECALL_SCAFFOLD_MODELS;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("default (APERIO_RECALL_SCAFFOLD_MODELS unset): falls back to APERIO_CAPABLE_MODELS — behavior unchanged", () => {
    process.env.APERIO_CAPABLE_MODELS = "qwen3:32b, llama3.1:70b";
    const provider = { name: "llamacpp", model: "qwen3:32b" };
    assert.ok(isCapableModel(provider), "still capable");
    assert.ok(needsRecallScaffold(provider), "falls back to the capable-models list by default");
  });

  test("a model allowlisted as capable but NOT in the scaffold list: capable, no scaffold", () => {
    process.env.APERIO_CAPABLE_MODELS = "qwen3:32b";
    process.env.APERIO_RECALL_SCAFFOLD_MODELS = "llama3.1:70b"; // qwen3:32b not in this list
    const provider = { name: "llamacpp", model: "qwen3:32b" };
    assert.ok(isCapableModel(provider), "tools + memory pointer");
    assert.ok(!needsRecallScaffold(provider), "graduated out of the forced-recall crutch");
  });

  test("a model in the scaffold list still gets it", () => {
    process.env.APERIO_CAPABLE_MODELS = "qwen3:32b";
    process.env.APERIO_RECALL_SCAFFOLD_MODELS = "qwen3:32b";
    const provider = { name: "llamacpp", model: "qwen3:32b" };
    assert.ok(needsRecallScaffold(provider));
  });

  test("cloud providers never need the scaffold, even if the name matches the list", () => {
    process.env.APERIO_RECALL_SCAFFOLD_MODELS = "claude-sonnet-5";
    const provider = { name: "anthropic", model: "claude-sonnet-5" };
    assert.ok(isCapableModel(provider), "cloud is always capable");
    assert.ok(!needsRecallScaffold(provider), "cloud never needs the local-model scaffold");
  });

  test("a weak, non-allowlisted local model needs no scaffold either", () => {
    const provider = { name: "llamacpp", model: "gemma3:4b" };
    assert.ok(!isCapableModel(provider));
    assert.ok(!needsRecallScaffold(provider));
  });
});
