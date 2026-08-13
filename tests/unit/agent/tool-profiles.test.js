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

import { classifyProfiles, TOOL_PROFILES, HOST_TOOL_PROFILES, CONFIRM_TOOLS, filterToolsForIntent, capToolsForWindow, capToolsForProvider, SMALL_WINDOW_TOKENS, SMALL_WINDOW_MAX_TOOLS, TOOL_SCHEMA_BUDGET_RATIO, isCapableModel, needsRecallScaffold, isDocRepoInventoryIntent, isDocumentAggregationIntent, computeSchemaTokenCosts, filterVisionTools, filterSelfMemoryTools, parsePinTurns, filterPreExecutedTools } from "../../../lib/agent/tool-profiles.js";
import { CONFIRMABLE_TOOLS } from "../../../lib/helpers/confirmableTools.js";
import { applyConfigToEnv, configSettingKey } from "../../../lib/config-resolver.js";

function toolsFor(text) {
  const profiles = classifyProfiles(text);
  return new Set([...profiles].flatMap((p) => [
    ...(TOOL_PROFILES[p] ?? []),
    ...(HOST_TOOL_PROFILES[p] ?? []),
  ]));
}

describe("tool-profiles — confirm tool lists are the same object", () => {
  test("CONFIRM_TOOLS === CONFIRMABLE_TOOLS", () => {
    assert.equal(CONFIRM_TOOLS, CONFIRMABLE_TOOLS,
      "CONFIRM_TOOLS (emit side) and CONFIRMABLE_TOOLS (accept side) must be the same Set; " +
      "adding a confirmable tool to only one list silently breaks either the confirm button " +
      "or the reply handler.");
  });
});

describe("tool-profiles — extraction availability (Document Intelligence WS3, review finding P1)", () => {
  // Registering mcp/tools/extraction.js with the MCP child alone does not
  // make the tools reachable from the web agent — planTurnTools() only
  // attaches names present in TOOL_PROFILES via classifyProfiles(). This
  // whole describe block is the regression guard for that gap; the coverage
  // bijection test (tests/integration/mcp/tool-profile-coverage.test.js)
  // would also fail loudly if TOOL_PROFILES.extraction went missing again.

  test("CONFIRM_TOOLS recognizes the propose tool by its PUBLIC name", () => {
    // The tool-hook checks the name the MODEL calls (extraction_template_
    // propose), not the interrupt's internal toolName — those must be the
    // same string or the self-confirmation guard never triggers (review
    // finding P1, "Route template proposals through the confirmation gate").
    assert.ok(CONFIRM_TOOLS.has("extraction_template_propose"));
  });

  test("a document-aggregation turn surfaces extraction tools alongside docgraph, not instead of it", () => {
    const tools = toolsFor("how much did I spend on utilities last month across my indexed documents?");
    assert.ok(tools.has("doc_manifest"), "sanity check: this is the existing docgraph-triggering phrasing");
    assert.ok(tools.has("extraction_apply"));
    assert.ok(tools.has("extraction_template_match"));
    assert.ok(tools.has("extraction_template_propose"));
    assert.ok(tools.has("extraction_log_record"));
  });

  test("an explicit template/extraction request surfaces extraction tools without any aggregate language", () => {
    const tools = toolsFor("learn a template from this invoice so future ones extract automatically");
    assert.ok(tools.has("extraction_template_propose"));
  });

  test("extraction intent always loads database too — the documented persistence/dedup follow-up is otherwise unreachable in the same turn (review finding P1)", () => {
    // extraction_apply's own results are useless without a same-turn
    // db_execute to write them, and extraction_log_record (round 3's fix)
    // requires a genuine db_execute_token — neither phrasing below mentions
    // SQL/database/table at all, so database's own separate keyword regex
    // would never have added it on its own.
    for (const text of [
      "how much did I spend on utilities last month across my indexed documents?",
      "learn a template from this invoice so future ones extract automatically",
    ]) {
      const tools = toolsFor(text);
      assert.ok(tools.has("db_execute"), `db_execute must load alongside extraction for: "${text}"`);
      assert.ok(tools.has("db_query"));
    }
  });

  test("a plain document-search question does not drag in extraction tools uninvited", () => {
    const tools = toolsFor("search my documents for the Q3 planning notes");
    assert.ok(!tools.has("extraction_apply"));
    assert.ok(!tools.has("extraction_template_propose"));
  });

  test("bare 'run'/'execute'/'verify' alongside SQL/database intent does not add shell (2026-08-13 live finding)", () => {
    // Recorded live during a document-intelligence WS2 provenance run: "run
    // SELECT category, currency, SUM(amount) GROUP BY category, currency
    // against the extraction table" matched the shell profile's bare \brun\b
    // keyword, adding run_shell's schema to a plain SQL follow-up turn — this
    // perturbed the tool-schema set turn to turn and defeated llama.cpp
    // prompt-cache reuse (the same mechanism behind the open "Tool profiles /
    // schema budgeting" cache-reuse tech debt). classifyProfiles now narrows
    // `shell` for database-intent text the same way it already did for
    // docGraph intent — only an unambiguous shell/QA signal keeps it.
    for (const text of [
      "run SELECT category, currency, SUM(amount) GROUP BY category, currency against the extraction table now and give me the resulting breakdown and total",
      "execute the query against the extraction table",
      "verify the total by querying the database",
    ]) {
      const profiles = classifyProfiles(text);
      assert.ok(profiles.has("database"), `expected database intent for: "${text}"`);
      assert.ok(!profiles.has("shell"), `unexpected shell profile for: "${text}"`);
    }
  });

  test("an unambiguous shell/QA signal still keeps shell even alongside database intent", () => {
    const profiles = classifyProfiles("run this SQL script from the terminal against the database");
    assert.ok(profiles.has("database"));
    assert.ok(profiles.has("shell"));
  });

  test("bare 'run'/'test'/'verify' with no database intent still triggers shell as before", () => {
    const profiles = classifyProfiles("run the tests and verify they pass");
    assert.ok(profiles.has("shell"));
  });
});

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

  test("natural doc-search wording surfaces docgraph instead of web search", () => {
    for (const prompt of [
      "could you use your doc search tools to find me the document?",
      'search some documents with this criteria "Merchant: Café du Terminal Aéroport de Paris-Roissy CDG"',
    ]) {
      const tools = toolsFor(prompt);
      assert.ok(tools.has("doc_search"), `doc_search must be offered for: ${prompt}`);
      assert.ok(!tools.has("web_search"), `web_search must not compete for: ${prompt}`);
    }
  });

  test("document-index inventory wording surfaces doc_repos, never code_repos", () => {
    const prompt = "What folders do you have indexed? For each folder, tell me how many documents it contains and what file types are in it.";
    const tools = toolsFor(prompt);
    assert.ok(tools.has("doc_repos"), "doc_repos must be offered for a document-index inventory");
    assert.ok(!tools.has("code_repos"), "bare 'indexed' must not misroute the request to codegraph");
    assert.ok(!tools.has("scan_project"), "document folders must not compete with filesystem scanning");
  });

  test("the recent-turn window does not let quoted receipt data add competing search scopes", () => {
    const prompt = [
      'search some documents with this criteria "Merchant: Café du Terminal Aéroport de Paris-Roissy CDG"',
      "What folders do you have indexed? For each folder, tell me how many documents it contains and what file types are in it.",
    ].join(" ");
    const tools = toolsFor(prompt);
    assert.ok(tools.has("doc_repos"));
    for (const name of ["code_repos", "scan_project", "web_search", "run_shell"]) {
      assert.ok(!tools.has(name), `${name} must not compete with doc_repos`);
    }
  });

  test("detects explicit document-index inventory intent in either word order", () => {
    for (const prompt of [
      "What folders do you have indexed?",
      "List the indexed document folders",
      "show me your doc repos",
    ]) assert.equal(isDocRepoInventoryIntent(prompt), true, prompt);

    for (const prompt of [
      "Which code repositories are indexed?",
      "Scan this project folder",
      "Search the web for document indexing tools",
    ]) assert.equal(isDocRepoInventoryIntent(prompt), false, prompt);
  });

  test("a generic web search does not load docgraph", () => {
    assert.ok(!toolsFor("search the web for letter of credit").has("doc_search"));
  });

  test("bare aggregation questions surface the manifest-first retrieval tools", () => {
    for (const prompt of [
      "How much did I pay for utilities last month?",
      "What was the total I spent in the household folder last month?",
      // Regression (T-R5.2, 2026-07-24): "spending" (gerund) fell through the
      // money regex's exact "spend"/"spent" alternatives, so this realistic
      // phrasing never triggered the doc_manifest/doc_batch preflight
      // shortcut — the model saw no document tools at all and gave up.
      "What's my total spending this month, broken down by category?",
    ]) {
      assert.equal(isDocumentAggregationIntent(prompt), true, prompt);
      const tools = toolsFor(prompt);
      assert.ok(tools.has("doc_manifest"), `manifest must be offered for: ${prompt}`);
      assert.ok(tools.has("doc_batch"), `batch must be offered for: ${prompt}`);
      assert.ok(!tools.has("web_search"), `web search must not compete for: ${prompt}`);
    }
  });

  test("money+aggregate language without a personal or corpus cue is NOT a document question", () => {
    // Regression: these satisfy the old money+aggregate-only check but are
    // ordinary, non-personal questions with no reference to the user's own
    // records — routing them to document preflight was the bug.
    for (const prompt of [
      "How much does fuel cost each month?",
      "How much does internet cost each month?",
      "What is the total monthly cost of groceries in a typical household?",
    ]) {
      assert.equal(isDocumentAggregationIntent(prompt), false, prompt);
    }
  });

  test("a personal pronoun or an indexed-folder mention restores the aggregation match", () => {
    for (const prompt of [
      "How much does fuel cost me each month?",
      "How much do I pay for internet each month?",
      "What's the total cost of groceries in my indexed folder each month?",
    ]) {
      assert.equal(isDocumentAggregationIntent(prompt), true, prompt);
    }
  });

  test("explicit mentions of the new doc_manifest/doc_batch tools activate docgraph", () => {
    for (const prompt of [
      "Use doc_manifest to inspect my corpus",
      "Call doc_batch on these candidates",
    ]) {
      const tools = toolsFor(prompt);
      assert.ok(tools.has("doc_manifest"), `docgraph tools must activate for: ${prompt}`);
      assert.ok(tools.has("doc_batch"), `docgraph tools must activate for: ${prompt}`);
    }
  });
});

describe("tool-profiles — filesystem search availability", () => {
  test("a code bug search offers the real grep_files tool", () => {
    const tools = toolsFor("find the auth bug in the code");
    assert.equal(tools.has("grep_files"), true);
  });

  test("a generic web search does not load filesystem search", () => {
    const tools = toolsFor("search the web for today's weather");
    assert.equal(tools.has("grep_files"), false);
  });
});

describe("tool-profiles — conversational folder indexing", () => {
  test("explicit indexing requests surface only the mutation tool needed for the action", () => {
    for (const prompt of [
      "Index this folder /srv/notes",
      "Index repository ~/Projects/aperio",
      "Please reindex the documents in /data/contracts",
      "Start indexing the folder /srv/archive",
    ]) {
      assert.ok(toolsFor(prompt).has("index_folder"), prompt);
    }
  });

  test("questions about already indexed content do not surface the mutation tool", () => {
    for (const prompt of [
      "Which code repositories are indexed?",
      "Search my indexed documents for the invoice",
    ]) {
      assert.ok(!toolsFor(prompt).has("index_folder"), prompt);
    }
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
  const smallWin = 8191;

  test("applies schema-token budget to a large window (no tool-count cap)", () => {
    // A large window no longer passes through uncapped. With a 20% schema-token
    // ratio, a very large set of tools should be reduced while the recall floor
    // and intent tools survive.
    const core = [...TOOL_PROFILES.memory, ...TOOL_PROFILES.self, ...TOOL_PROFILES.data];
    const names = new Set([...core, "fetch_github_issue", "web_search", "read_file", "write_file", "grep_files"]);
    const capped = capToolsForWindow(names, bigWin);
    // The large window must still be capped by the schema-token budget when
    // the set is too large to fit within the 20% ratio.
    assert.ok(capped.size >= 2, "recall floor + intent tools survive");
    assert.ok(capped.has("recall"), "recall floor survives on large windows");
    assert.ok(capped.has("fetch_github_issue"), "intent tools survive on large windows");
  });

  test("leaves a large small-like window untouched when schema budget is sufficient", () => {
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

  test("caps schema tokens dynamically for 11k and 16k local windows", () => {
    const names = new Set([
      "recall", "wiki_write", "wiki_get", "wiki_search", "wiki_list", "propose_wiki",
      ...TOOL_PROFILES.memory, ...TOOL_PROFILES.self, ...TOOL_PROFILES.data,
    ]);
    const schemaTokenCosts = new Map([...names].map(name => [name, 400]));

    const at11k = capToolsForWindow(names, 11_264, { schemaTokenCosts });
    const at16k = capToolsForWindow(names, 16_384, { schemaTokenCosts });

    assert.ok(at11k.size < names.size, "11k window must not receive the full schema set");
    assert.ok(at16k.size < names.size, "16k window must retain headroom for chained tool results");
    for (const required of ["recall", "wiki_write", "wiki_search"]) {
      assert.ok(at11k.has(required), `${required} survives the 11k schema budget`);
      assert.ok(at16k.has(required), `${required} survives the 16k schema budget`);
    }
  });

  test("does not replace an over-budget intent tool with a cheaper core tool", () => {
    for (const contextWindow of [smallWin, bigWin]) {
      const schemaBudget = Math.floor(contextWindow * TOOL_SCHEMA_BUDGET_RATIO);
      const names = new Set(["recall", "fetch_github_issue", "remember"]);
      const schemaTokenCosts = new Map([
        ["recall", 100],
        ["fetch_github_issue", schemaBudget],
        ["remember", 1],
      ]);

      const capped = capToolsForWindow(names, contextWindow, { schemaTokenCosts });

      assert.ok(capped.has("recall"), `recall floor survives at ${contextWindow} tokens`);
      assert.ok(!capped.has("fetch_github_issue"), `over-budget intent is excluded at ${contextWindow} tokens`);
      assert.ok(!capped.has("remember"), `lower-priority core cannot leapfrog intent at ${contextWindow} tokens`);
    }
  });

  // Step 2 of the llamacpp-multiturn-latency plan: pin-for-N-turns tool-set
  // stability (turn-planner.js's computeStickyProfiles) can carry a stale
  // profile's tools forward from earlier in a flow. Under a tight schema
  // budget, this turn's OWN newly-relevant tools must never be silently
  // truncated in favor of that stale carryover — the plan's locked decision
  // that correctness of tool availability isn't traded for cache stability.
  test("prioritizes this turn's own tools over stale carried-over ones under a tight budget", () => {
    const schemaBudget = Math.floor(smallWin * TOOL_SCHEMA_BUDGET_RATIO);
    // Insertion order deliberately puts the stale tool FIRST, so a pass would
    // only happen by genuinely consulting currentTurnNames, not by accident.
    const names = new Set(["recall", "stale_carried_tool", "new_pivot_tool"]);
    const schemaTokenCosts = new Map([
      ["recall", 100],
      ["stale_carried_tool", 1500],
      ["new_pivot_tool", 1500],
    ]);
    const currentTurnNames = new Set(["new_pivot_tool"]);

    const capped = capToolsForWindow(names, smallWin, { schemaTokenCosts, currentTurnNames });

    assert.ok(capped.has("recall"), "recall floor survives");
    assert.ok(capped.has("new_pivot_tool"), "this turn's own newly-relevant tool survives the budget");
    assert.ok(!capped.has("stale_carried_tool"), "a stale carried-over tool loses out to the current turn's own tool");
    assert.ok(schemaBudget > 0, "sanity: budget is non-trivial at this window size");
  });

  test("falls back to plain insertion order when currentTurnNames is not given", () => {
    const names = new Set(["recall", "first_tool", "second_tool"]);
    const schemaTokenCosts = new Map([
      ["recall", 100],
      ["first_tool", 1500],
      ["second_tool", 1500],
    ]);

    const capped = capToolsForWindow(names, smallWin, { schemaTokenCosts });

    assert.ok(capped.has("first_tool"), "insertion order wins without currentTurnNames");
    assert.ok(!capped.has("second_tool"), "second candidate is still budget-truncated");
  });

  test("keeps non-llama.cpp provider tool contracts unchanged", () => {
    const names = new Set([
      "recall", "wiki_write", "wiki_get", "wiki_search", "wiki_list", "propose_wiki",
      ...TOOL_PROFILES.memory, ...TOOL_PROFILES.self, ...TOOL_PROFILES.data,
    ]);
    const schemaTokenCosts = new Map([...names].map(name => [name, 400]));

    for (const name of ["anthropic", "deepseek", "gemini", "claude-code", "codex"]) {
      assert.strictEqual(
        capToolsForProvider(names, { name, contextWindow: 11_264 }, { schemaTokenCosts }),
        names,
        `${name} keeps its complete selected tool set`,
      );
    }
  });
});

// A P2 review finding on Step 2's first cut: Number(raw) || 3 silently
// replaced an explicit APERIO_TOOL_PIN_TURNS=0 (a valid, meaningful "disable
// follow-up pinning" value) with the default 3, since 0 is falsy.
describe("parsePinTurns (APERIO_TOOL_PIN_TURNS)", () => {
  test("preserves an explicit 0 (disables follow-up pinning)", () => {
    assert.strictEqual(parsePinTurns("0"), 0);
  });

  test("parses a valid positive value", () => {
    assert.strictEqual(parsePinTurns("5"), 5);
  });

  test("falls back to the default 8 when unset", () => {
    assert.strictEqual(parsePinTurns(undefined), 8);
    assert.strictEqual(parsePinTurns(""), 8);
  });

  test("falls back to the default 8 for a non-finite or negative value", () => {
    assert.strictEqual(parsePinTurns("not-a-number"), 8);
    assert.strictEqual(parsePinTurns("-1"), 8);
    assert.strictEqual(parsePinTurns("NaN"), 8);
  });

  test("falls back to the default 8 for a fractional value (P2 review finding)", () => {
    // sinceLastToolUse advances one whole turn at a time; a fractional
    // TOOL_PIN_TURNS like 1.5 would silently pin 2 follow-up turns (both
    // 0 < 1.5 and 1 < 1.5 hold), not the value actually configured.
    assert.strictEqual(parsePinTurns("1.5"), 8);
    assert.strictEqual(parsePinTurns("0.5"), 8);
    assert.strictEqual(parsePinTurns("2.99"), 8);
  });
});

// P2 review finding: TOOL_PIN_TURNS (above) is a module-level constant read
// from process.env at import time. standalone.js used to statically import
// the agent module (which transitively imports this file) at the TOP of the
// file, before runStandalone() ever calls applyConfigToEnv() to hydrate
// DB-stored config into process.env — so a value saved via the Settings UI
// was silently ineffective in standalone/CLI mode, even though the server
// path picked it up correctly. Fixed by making standalone.js's agent import
// a dynamic `await import(...)` performed AFTER hydration (mirroring
// server.js/hydrateRuntime.js's existing pattern). This test proves the
// mechanism the fix relies on: a fresh import of this module reflects a
// DB-hydrated value, but only if hydration ran first — a cache-busted
// dynamic import is used because this file's own top-level static import
// (above) has already frozen the ordinary TOOL_PIN_TURNS binding for this
// process.
const cacheBustToolProfiles = () =>
  import(`../../../lib/agent/tool-profiles.js?t=${Date.now()}_${Math.random().toString(36).slice(2)}`);
const storeWith = (settings = {}) => ({ async getSettings() { return { ...settings }; } });

describe("TOOL_PIN_TURNS DB-hydration ordering (P2 review finding)", () => {
  let saved;
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => { process.env = saved; });

  test("reflects a DB-configured value when the module is (re)imported AFTER applyConfigToEnv runs", async () => {
    delete process.env.APERIO_TOOL_PIN_TURNS;
    await applyConfigToEnv(storeWith({ [configSettingKey("APERIO_TOOL_PIN_TURNS")]: "7" }));
    const mod = await cacheBustToolProfiles();
    assert.strictEqual(mod.TOOL_PIN_TURNS, 7);
  });

  test("stays at the pre-hydration default when the module is imported BEFORE applyConfigToEnv runs — the exact bug a static top-level import caused", async () => {
    delete process.env.APERIO_TOOL_PIN_TURNS;
    const mod = await cacheBustToolProfiles();
    await applyConfigToEnv(storeWith({ [configSettingKey("APERIO_TOOL_PIN_TURNS")]: "7" }));
    assert.strictEqual(mod.TOOL_PIN_TURNS, 8, "a module already evaluated before hydration keeps its module-level constant frozen at the default forever, regardless of a later DB write");
  });
});

describe("tool-profiles — wiki authoring", () => {
  test("wiki writes do not also attach filesystem edit tools", () => {
    const profiles = classifyProfiles("Write a wiki article summarizing everything we know about Nimbus");
    assert.ok(profiles.has("wiki"));
    assert.ok(!profiles.has("file-edit"));
  });

  test("an explicit wiki export path still attaches filesystem edit tools", () => {
    const profiles = classifyProfiles("Write a wiki article and save it to a markdown file");
    assert.ok(profiles.has("wiki"));
    assert.ok(profiles.has("file-edit"));
  });

  test("an explicit wiki write keeps wiki_write but removes propose_wiki", () => {
    const text = "Write a wiki article summarizing everything we know about Nimbus";
    const tools = filterToolsForIntent(toolsFor(text), text);

    assert.ok(tools.has("wiki_write"));
    assert.ok(!tools.has("propose_wiki"));
  });

  test("unsolicited synthesis and explicit proposal requests keep propose_wiki", () => {
    for (const text of [
      "I noticed several memories form a recurring topic; use the wiki if appropriate",
      "Propose a wiki article about Nimbus for my review",
    ]) {
      assert.ok(filterToolsForIntent(toolsFor(text), text).has("propose_wiki"));
    }
  });
});

describe("tool-profiles — generic transformation intent (issue #301 finding #3)", () => {
  test("generate without a file target does not surface file-edit tools", () => {
    assert.ok(!classifyProfiles("generate a poem about the sea").has("file-edit"));
  });

  test("export without a file target does not surface file-edit tools", () => {
    assert.ok(!classifyProfiles("which countries export the most coffee?").has("file-edit"));
  });

  test("convert without a file target does not surface file-edit tools", () => {
    assert.ok(!classifyProfiles("convert 10 kilometers to miles").has("file-edit"));
  });
});

describe("tool-profiles — code delivery is not implicit file intent", () => {
  test("bare write/create code requests do not surface filesystem edit tools", () => {
    for (const text of [
      "Keep it minimal, but write a function that parses a numeric config value.",
      "Write me a helper for turning a title into a URL slug.",
      "Create a JavaScript function that validates an email address.",
    ]) {
      assert.ok(!classifyProfiles(text).has("file-edit"), `unexpected file-edit profile for: ${text}`);
    }
  });

  test("named-file and explicit persistence requests still surface filesystem edit tools", () => {
    for (const text of [
      "Write the numeric config helper to parseConfigValue.js.",
      "Create a JavaScript file named parseConfigValue.js.",
      "Save this helper locally.",
      "Modify the existing helper to reject NaN.",
    ]) {
      assert.ok(classifyProfiles(text).has("file-edit"), `missing file-edit profile for: ${text}`);
    }
  });
});

// ─── CSV vs XLSX classification — issue #300 ──────────────────────────────────
// Plain CSV requests must not activate the heavy file-generate profile or
// offer generate_xlsx. They should use file-edit (write_file) instead.
// CSV + Excel intent should still offer generate_xlsx.
describe("tool-profiles — CSV classification (issue #300)", () => {
  test("plain CSV creation does NOT surface generate_xlsx but DOES surface write_file", () => {
    const profiles = classifyProfiles("create a csv file with the data");
    assert.ok(!profiles.has("file-generate"), "plain CSV must not activate file-generate");
    assert.ok(profiles.has("file-edit"), "plain CSV should activate file-edit for write_file");
  });

  test("plain CSV write without Excel terms does NOT surface generate_xlsx", () => {
    const profiles = classifyProfiles("write this data as a csv");
    assert.ok(!profiles.has("file-generate"));
    assert.ok(profiles.has("file-edit"));
  });

  test("plain CSV analysis does NOT surface generate_xlsx", () => {
    const profiles = classifyProfiles("analyze this csv data and summarize it");
    assert.ok(!profiles.has("file-generate"), "analysis alone must not load file-generate");
  });

  test("CSV + Excel intent DOES surface generate_xlsx", () => {
    for (const prompt of [
      "convert this csv to an xlsx file",
      "import this csv into an excel spreadsheet",
      "open this csv in excel and format it",
    ]) {
      const profiles = classifyProfiles(prompt);
      assert.ok(profiles.has("file-generate"), `file-generate must activate for: ${prompt}`);
    }
  });

  test("CSV + spreadsheet pairing surfaces generate_xlsx", () => {
    const profiles = classifyProfiles("turn this csv into a formatted spreadsheet with formulas");
    assert.ok(profiles.has("file-generate"));
  });

  test("reading a csv for inspection does NOT surface generate_xlsx", () => {
    const profiles = classifyProfiles("read this csv file and show me the first 10 rows");
    assert.ok(!profiles.has("file-generate"));
    assert.ok(profiles.has("file-read"));
  });

  test("\"generate a CSV\" routes to file-edit instead of file-generate", () => {
    const profiles = classifyProfiles("generate a CSV file with the data");
    assert.ok(!profiles.has("file-generate"), "\"generate a CSV\" must not activate file-generate");
    assert.ok(profiles.has("file-edit"), "\"generate a CSV\" must activate file-edit for write_file");
  });

  test("export as CSV surfaces file-edit for write_file", () => {
    const profiles = classifyProfiles("export this data as CSV");
    assert.ok(!profiles.has("file-generate"), "plain CSV export must not activate file-generate");
    assert.ok(profiles.has("file-edit"), "CSV export must activate file-edit for write_file");
  });

  test("\"generate a chart\" still surfaces file-generate", () => {
    const profiles = classifyProfiles("generate a chart from this data");
    assert.ok(profiles.has("file-generate"), "\"generate a chart\" must still activate file-generate");
  });

  test("CSV to non-Excel conversion surfaces file-edit for read+write", () => {
    for (const prompt of [
      "convert this CSV to a JSON file",
      "convert this tsv to a markdown file",
      "convert this csv into yaml",
    ]) {
      const profiles = classifyProfiles(prompt);
      assert.ok(!profiles.has("file-generate"), `CSV→non-Excel must not activate file-generate: ${prompt}`);
      assert.ok(profiles.has("file-edit"), `CSV→non-Excel must activate file-edit: ${prompt}`);
    }
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

// ---------------------------------------------------------------------------
// Phase 5a (issue #307): pure category-2 helpers extracted from the inline
// logic in lib/agent/index.js's ensureTurn()/resolveToolNamesForTurn().
// ---------------------------------------------------------------------------

describe("computeSchemaTokenCosts", () => {
  test("estimates cost from a tool's serialized openai schema", () => {
    const schema = { function: { name: "recall", parameters: { type: "object", properties: { query: { type: "string" } } } } };
    const openaiByName = new Map([["recall", schema]]);
    const costs = computeSchemaTokenCosts(new Set(["recall"]), openaiByName);
    assert.strictEqual(costs.get("recall"), Math.max(1, Math.ceil(JSON.stringify(schema).length / 3)));
  });

  test("falls back to the bare name's length when no schema is registered for it", () => {
    const openaiByName = new Map();
    const costs = computeSchemaTokenCosts(new Set(["mystery_tool"]), openaiByName);
    assert.strictEqual(costs.get("mystery_tool"), Math.max(1, Math.ceil(JSON.stringify("mystery_tool").length / 3)));
  });

  test("cost is always at least 1", () => {
    const openaiByName = new Map([["x", {}]]);
    const costs = computeSchemaTokenCosts(new Set(["x"]), openaiByName);
    assert.ok(costs.get("x") >= 1);
  });
});

describe("filterVisionTools", () => {
  const IMAGE_TOOLS = new Set(["read_image", "preprocess_image", "describe_image", "recall", "remember"]);

  test("leaves tools untouched when the provider is not local", () => {
    const result = filterVisionTools(IMAGE_TOOLS, {
      hasInlineImage: true, standaloneVision: false, providerIsLocal: false, modelHandlesInlineImage: true,
    });
    assert.deepStrictEqual([...result].sort(), [...IMAGE_TOOLS].sort());
  });

  test("leaves tools untouched when there is no inline image", () => {
    const result = filterVisionTools(IMAGE_TOOLS, {
      hasInlineImage: false, standaloneVision: false, providerIsLocal: true, modelHandlesInlineImage: true,
    });
    assert.deepStrictEqual([...result].sort(), [...IMAGE_TOOLS].sort());
  });

  test("leaves tools untouched when the local model does not itself handle inline images", () => {
    const result = filterVisionTools(IMAGE_TOOLS, {
      hasInlineImage: true, standaloneVision: false, providerIsLocal: true, modelHandlesInlineImage: false,
    });
    assert.deepStrictEqual([...result].sort(), [...IMAGE_TOOLS].sort());
  });

  test("drops only the image-reading tools for a non-standalone vision turn on a capable local model", () => {
    const result = filterVisionTools(IMAGE_TOOLS, {
      hasInlineImage: true, standaloneVision: false, providerIsLocal: true, modelHandlesInlineImage: true,
    });
    assert.deepStrictEqual([...result].sort(), ["recall", "remember"]);
  });

  test("clears every tool for a standalone vision turn on a capable local model", () => {
    const result = filterVisionTools(IMAGE_TOOLS, {
      hasInlineImage: true, standaloneVision: true, providerIsLocal: true, modelHandlesInlineImage: true,
    });
    assert.strictEqual(result.size, 0);
  });
});

describe("filterSelfMemoryTools", () => {
  test("leaves self-memory/self-wiki tools untouched on a local provider", () => {
    const names = new Set(["self_recall", "self_update", "self_wiki_write", "recall"]);
    const result = filterSelfMemoryTools(names, { providerIsLocal: true });
    assert.deepStrictEqual([...result].sort(), [...names].sort());
  });

  test("drops all self-memory and self-wiki tools on a cloud provider", () => {
    const names = new Set(["self_recall", "self_update", "self_wiki_write", "self_wiki_get", "recall"]);
    const result = filterSelfMemoryTools(names, { providerIsLocal: false });
    assert.deepStrictEqual([...result], ["recall"]);
  });
});

// preflight auto-executes doc_manifest + doc_batch and their schemas were then
// withheld from the very request they were pre-executed for. On llama.cpp that
// is a 40→38 shift in a tools block the chat template renders at the front of
// the prompt, which cost a measured 262s of prefill on the 2026-08-13 WS2
// T-G2.3 gate and failed the run on the per-turn ceiling.
describe("filterPreExecutedTools", () => {
  const anthropic = [{ name: "doc_batch" }, { name: "doc_manifest" }, { name: "db_query" }];
  const preExecuted = new Set(["doc_manifest", "doc_batch"]);

  test("drops pre-executed tools for an ordinary provider", () => {
    const result = filterPreExecutedTools(anthropic, "anthropic", preExecuted);
    assert.deepStrictEqual(result.map(t => t.name), ["db_query"]);
  });

  test("keepStable returns the array untouched, preserving the cache prefix", () => {
    const result = filterPreExecutedTools(anthropic, "anthropic", preExecuted, { keepStable: true });
    assert.strictEqual(result, anthropic, "same reference — nothing rebuilt, nothing dropped");
  });

  test("an empty pre-executed set is a passthrough regardless of keepStable", () => {
    assert.strictEqual(filterPreExecutedTools(anthropic, "anthropic", new Set()), anthropic);
  });

  test("unwraps the openai function shape", () => {
    const openai = [{ function: { name: "doc_batch" } }, { function: { name: "db_query" } }];
    const result = filterPreExecutedTools(openai, "openai", preExecuted);
    assert.deepStrictEqual(result.map(t => t.function.name), ["db_query"]);
  });

  test("filters inside gemini functionDeclarations groups", () => {
    const gemini = [{ functionDeclarations: [{ name: "doc_batch" }, { name: "db_query" }] }];
    const result = filterPreExecutedTools(gemini, "gemini", preExecuted);
    assert.deepStrictEqual(result[0].functionDeclarations.map(t => t.name), ["db_query"]);
  });
});
