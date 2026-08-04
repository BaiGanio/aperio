// tests/unit/agent/turn-planner.test.js
//
// Coverage for lib/agent/turn-planner.js's planTurnTools() — extracted from
// lib/agent/index.js's ensureTurn() (issue #307 Phase 5a). Uses the real
// loadSkillIndex() against a temp skills/ dir (not a hand-built fixture) so
// this test exercises the real skill loader/matcher instead of guessing at
// their internal object shape or scoring thresholds.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadSkillIndex } from "../../../lib/workers/skills.js";
import { planTurnTools } from "../../../lib/agent/turn-planner.js";
import { capToolsForWindow, PREFLIGHT_TOOL_USE } from "../../../lib/agent/tool-profiles.js";

let root, skillIndex;

function writeSkill(name, { load = "on-demand", dependsOn = null, content = "Do the thing.", at = root } = {}) {
  fs.mkdirSync(path.join(at, "skills", name), { recursive: true });
  const lines = ["---", `name: ${name}`, `description: ${name} skill`, "metadata:", `  load: ${load}`];
  if (dependsOn) lines.push(`  depends-on: ${dependsOn}`);
  lines.push("---", "", content);
  fs.writeFileSync(path.join(at, "skills", name, "SKILL.md"), lines.join("\n"), "utf8");
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-"));
  writeSkill("always-on-skill", { load: "always" });
  // A name that appears verbatim in the test's user text so matchSkills'
  // direct-name-match path (score: Infinity) fires deterministically,
  // independent of the keyword-scoring threshold.
  writeSkill("widget-helper", { load: "on-demand" });
  writeSkill("forced-only-skill", { load: "on-demand" });
  skillIndex = loadSkillIndex(path.join(root, "skills"), path.join(root, "var", "skills"), []);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("planTurnTools — skill priority (forced > always-on > keyword)", () => {
  test("orders skills forced-first, then always-on, then keyword match, with no duplicates", () => {
    const messages = [];
    const userText = "please use the widget helper on this";
    const result = planTurnTools(messages, userText, {
      turnNum: 2,
      skillIndex,
      shellAllowed: true,
      pendingForcedSkillNames: ["forced-only-skill"],
      pendingSemanticSkillNames: [],
    });
    assert.deepStrictEqual(
      result.skills.map(s => s.name),
      ["forced-only-skill", "always-on-skill", "widget-helper"],
    );
  });

  test("a forced skill name not present in the index is reported in notFound, not in skills", () => {
    const result = planTurnTools([], "hello there", {
      turnNum: 1,
      skillIndex,
      shellAllowed: true,
      pendingForcedSkillNames: ["does-not-exist"],
      pendingSemanticSkillNames: [],
    });
    assert.ok(!result.skills.some(s => s.name === "does-not-exist"));
    assert.deepStrictEqual(result.notFound, ["does-not-exist"]);
  });

  test("semantic-rescue names are merged like a keyword match, after forced and always-on", () => {
    const result = planTurnTools([], "totally unrelated text with no name match", {
      turnNum: 2,
      skillIndex,
      shellAllowed: true,
      pendingForcedSkillNames: [],
      pendingSemanticSkillNames: ["widget-helper"],
    });
    assert.deepStrictEqual(
      result.skills.map(s => s.name),
      ["always-on-skill", "widget-helper"],
    );
  });

  test("pendingForcedSkillNames/pendingSemanticSkillNames are read by value — the caller owns consuming its own queues", () => {
    const forced = ["forced-only-skill"];
    planTurnTools([], "hi", { turnNum: 1, skillIndex, shellAllowed: true, pendingForcedSkillNames: forced, pendingSemanticSkillNames: [] });
    assert.deepStrictEqual(forced, ["forced-only-skill"], "planTurnTools must not mutate the array it was given");
  });
});

describe("planTurnTools — tool profile classification", () => {
  test("respects shellAllowed:false by omitting run_shell even when a shell-profile keyword matches", () => {
    const result = planTurnTools([], "run a shell command to check status", {
      turnNum: 1, skillIndex, shellAllowed: false, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
    });
    assert.ok(!result.names.has("run_shell"));
  });

  test("offers run_shell when shellAllowed:true and the text matches the shell profile", () => {
    const result = planTurnTools([], "run a shell command to check status", {
      turnNum: 1, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
    });
    assert.ok(result.names.has("run_shell"));
  });

  test("turn 1 or below always includes the FIRST_TURN_TOOLS recall floor", () => {
    const result = planTurnTools([], "hello", {
      turnNum: 1, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
    });
    assert.ok(result.names.has("recall"));
  });
});

// Step 2 of the llamacpp-multiturn-latency plan (trash/plans/document-intelligence-epic/llamacpp-latency/):
// once a turn's assistant response actually calls a tool, the attached tool
// set stays pinned (union-only, never dropping) for up to TOOL_PIN_TURNS
// follow-up turns, instead of re-classifying the bare 2-turn window from
// scratch every turn — Step 1 measured that even a single added/removed tool
// fully defeats llama-server's prompt/KV-cache prefix reuse. TOOL_PIN_TURNS
// defaults to 3 (APERIO_TOOL_PIN_TURNS).
describe("planTurnTools — pin-for-N-turns sticky tool-profile accumulation (T-L2.1)", () => {
  // A realistic growing conversation: turn 1 triggers docgraph and its
  // response actually calls a tool; turn 2 has no keyword of its own but
  // should still carry docgraph; turn 3 pivots to a genuinely new topic
  // (database) without dropping docgraph; turns 4-6 have neither new
  // keywords nor tool calls (a 1/2/3-turn gap, still inside the pin window);
  // turn 7 is a 4-turn gap — past TOOL_PIN_TURNS — and must reset.
  const transcript = [
    { role: "user", content: "search my documents for the invoice" },                        // turn 1
    { role: "assistant", content: [{ type: "tool_use", name: "doc_search", input: {}, id: "t1" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    { role: "assistant", content: "Found some documents." },

    { role: "user", content: "ok continue" },                                                 // turn 2
    { role: "assistant", content: [{ type: "tool_use", name: "doc_batch", input: {}, id: "t2" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
    { role: "assistant", content: "Here are the contents." },

    { role: "user", content: "now query the database schema" },                               // turn 3 (widen)
    { role: "assistant", content: "Sure, here is the schema." },                               // no tool_use this hop

    { role: "user", content: "thanks" },                                                       // turn 4 — 2nd follow-up (still pinned)
    { role: "assistant", content: "You're welcome." },

    { role: "user", content: "cool" },                                                         // turn 5 — 3rd follow-up (still pinned, boundary)
    { role: "assistant", content: "Great." },

    { role: "user", content: "nice" },                                                          // turn 6 — 4th follow-up: resets (TOOL_PIN_TURNS=3)
    { role: "assistant", content: "Indeed." },
  ];

  function planAt(turnNum) {
    const userIdx = [];
    transcript.forEach((m, i) => { if (m.role === "user" && typeof m.content === "string") userIdx.push(i); });
    const upto = transcript.slice(0, userIdx[turnNum - 1] + 1);
    const userText = transcript[userIdx[turnNum - 1]].content;
    return planTurnTools(upto, userText, {
      turnNum, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
  }

  test("turn 1 attaches docgraph tools and reports them as this turn's own intent", () => {
    const r = planAt(1);
    assert.ok(r.names.has("doc_search"));
    assert.ok(r.currentTurnNames.has("doc_search"));
  });

  test("turn 2 carries docgraph forward and still reports it as the priority pick — no newer pivot has occurred yet", () => {
    const r = planAt(2);
    assert.ok(r.names.has("doc_search"), "carried forward from turn 1's tool-using response");
    assert.ok(r.currentTurnNames.has("doc_search"), "docgraph is still the most recently active pivot, so it stays prioritized");
  });

  test("turn 3 widens to a genuinely new topic (database) without dropping docgraph, and database becomes the new priority pivot", () => {
    const r = planAt(3);
    assert.ok(r.names.has("doc_search"), "docgraph still carried");
    assert.ok(r.names.has("db_query"), "database newly added");
    assert.ok(r.currentTurnNames.has("db_query"), "database is this turn's own intent");
    assert.ok(!r.currentTurnNames.has("doc_search"), "database (the newer pivot) supersedes docgraph for priority");
  });

  // Regression for the P1 review finding: a keyword-free confirmation right
  // after a topic pivot must keep prioritizing the PIVOT's tools (database),
  // not fall back to whatever was carried first (docgraph, from before the
  // pivot) — on a budget-capped llama.cpp model this is exactly the turn
  // where dropping db_query/db_execute would break the confirmation itself.
  test("turns 4-5 (2nd and 3rd follow-ups) keep prioritizing the pivot (database) over the older carried profile (docgraph)", () => {
    for (const turnNum of [4, 5]) {
      const r = planAt(turnNum);
      assert.ok(r.names.has("doc_search"), `turn ${turnNum} still has docgraph`);
      assert.ok(r.names.has("db_query"), `turn ${turnNum} still has database`);
      assert.ok(r.currentTurnNames.has("db_query"), `turn ${turnNum} still prioritizes the pivot (database)`);
      assert.ok(!r.currentTurnNames.has("doc_search"), `turn ${turnNum} does not let the older carried profile (docgraph) reclaim priority`);
    }
  });

  test("turn 6 (the 4th follow-up) resets, dropping the stale accumulated profiles", () => {
    const r = planAt(6);
    assert.ok(!r.names.has("doc_search"), "docgraph dropped once the pin window's exact turn count lapses");
    assert.ok(!r.names.has("db_query"), "database dropped once the pin window's exact turn count lapses");
  });

  // Regression for the P1 review finding's EXACT failure condition: the pivot
  // turn immediately follows the old topic, so its live 2-turn window
  // contains BOTH topics' keywords. If pivot tracking used that windowed
  // classification (round-2's bug), the stale old topic would ride along as
  // "current priority" too, and — since it was inserted first — could still
  // outrank the real pivot under a tight budget. Pivot must come from the
  // turn's OWN text alone, which contains only the new topic.
  test("a pivot immediately following the old topic still prioritizes only the new topic, not both", () => {
    const adjacentTranscript = [
      { role: "user", content: "search my documents for the invoice" },                      // old topic: docgraph
      { role: "assistant", content: [{ type: "tool_use", name: "doc_search", input: {}, id: "a1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "ok" }] },
      { role: "assistant", content: "Found some documents." },

      { role: "user", content: "now query the database schema" },                             // pivot, immediately adjacent
      { role: "assistant", content: [{ type: "tool_use", name: "db_query", input: {}, id: "a2" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a2", content: "ok" }] },
      { role: "assistant", content: "Here's the schema." },

      { role: "user", content: "yes, do it" },                                                 // keyword-free confirmation
    ];
    const r = planTurnTools(adjacentTranscript, "yes, do it", {
      turnNum: 3, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
    assert.ok(r.names.has("doc_search"), "docgraph still carried for availability");
    assert.ok(r.names.has("db_query"), "database still carried for availability");
    assert.ok(r.currentTurnNames.has("db_query"), "the pivot (database) is prioritized");
    assert.ok(!r.currentTurnNames.has("doc_search"), "the old, adjacent topic (docgraph) does not ride along as priority too");
  });

  test("reconstructs a historical turn's profile using the same 2-turn window it was actually classified with (intent split across turns)", () => {
    // "Could you index it?" alone has no folder/directory keyword; "the folder
    // I shared" alone has no index/reindex keyword. Only the live 2-turn
    // window ("Could you index it? the folder I shared") triggers the
    // indexing profile — which is exactly what happened when turn 2 was
    // classified live and actually called index_folder. Reconstructing turn
    // 2 from its own single message alone (the pre-fix behavior) would see
    // no indexing keyword at all and silently fail to carry index_folder
    // forward, even though the tool call that should pin it really happened.
    const splitIntentTranscript = [
      { role: "user", content: "Could you index it?" },
      { role: "assistant", content: "Sure — which folder?" },                    // no tool_use yet

      { role: "user", content: "the folder I shared" },
      { role: "assistant", content: [{ type: "tool_use", name: "index_folder", input: {}, id: "t1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: "Indexed." },

      { role: "user", content: "thanks!" },                                       // turn 3 — no keyword of its own
    ];
    const r = planTurnTools(splitIntentTranscript, "thanks!", {
      turnNum: 3, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
    assert.ok(r.names.has("index_folder"), "index_folder pinned forward from turn 2's tool-using response");
  });

  test("preserves split-window intent in the budget-priority pivot, not just availability (P2 review finding)", () => {
    // Same split-intent transcript as above, but asserting currentTurnNames
    // (the budget-priority signal a tight llama.cpp schema cap actually
    // consults), not just names (availability). "the folder I shared" alone
    // ALSO independently matches a different, weaker profile (file-project,
    // from the bare word "folder") — deriving the historical pivot from
    // turn 2's own text alone (the pre-fix behavior) picked file-project and
    // lost indexing entirely, even though index_folder is the tool turn 2
    // actually called. Under a tight budget this let index_folder — the tool
    // just used — get capped away as "stale" on the very next follow-up.
    const splitIntentTranscript = [
      { role: "user", content: "Could you index it?" },
      { role: "assistant", content: "Sure — which folder?" },

      { role: "user", content: "the folder I shared" },
      { role: "assistant", content: [{ type: "tool_use", name: "index_folder", input: {}, id: "t1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
      { role: "assistant", content: "Indexed." },

      { role: "user", content: "thanks!" },
    ];
    const r = planTurnTools(splitIntentTranscript, "thanks!", {
      turnNum: 3, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
    assert.ok(r.currentTurnNames.has("index_folder"), "the split-window intent (indexing) survives into the budget-priority pivot, not just availability");
  });

  test("applies the same split-window pivot correction to the LIVE turn's own priority set, not just a later retroactive follow-up (P2 review finding)", () => {
    // Here "the folder I shared" IS the current/live turn — the one that
    // actually calls index_folder this turn — not a later turn recalling it.
    // ownProfiles alone (this turn's own text) suffers the identical masking
    // (file-project instead of indexing) at the moment the tool is used, not
    // just retroactively; the fix must apply symmetrically to the live turn,
    // not only to historical turns feeding into a later pivot.
    const r = planTurnTools(
      [
        { role: "user", content: "Could you index it?" },
        { role: "assistant", content: "Sure — which folder?" },
        { role: "user", content: "the folder I shared" },
      ],
      "the folder I shared",
      { turnNum: 2, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [], providerName: "llamacpp" },
    );
    assert.ok(r.currentTurnNames.has("index_folder"), "the live turn's own priority set includes the split-window intent, not just the weaker own-text-only profile");
  });

  test("does not let a slash-invoked skill name leak into historical tool-profile reconstruction (P2 review finding)", () => {
    // Several real skill names (pptx, docx, xlsx, wiki, ...) are also literal
    // tool-profile keywords. "/pptx summarize these notes" is correctly
    // slash-cleaned to "summarize these notes" when classified live (no rich-
    // format keyword left, so file-generate is never attached) — but
    // reconstructing turn 1 from its RAW text for turn 2's pin check would see
    // the literal "pptx" substring and falsely attach file-generate, pinning
    // tools (generate_xlsx, generate_docx, ...) that were never live.
    const slashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-slash-"));
    try {
      writeSkill("pptx", { load: "on-demand", content: "Build slide decks.", at: slashRoot });
      const slashSkillIndex = loadSkillIndex(path.join(slashRoot, "skills"), path.join(slashRoot, "var", "skills"), []);

      const transcript = [
        { role: "user", content: "/pptx summarize these notes" },
        { role: "assistant", content: [{ type: "tool_use", name: "recall", input: {}, id: "t1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "Here's a summary." },

        { role: "user", content: "thanks!" },
      ];
      const r = planTurnTools(transcript, "thanks!", {
        turnNum: 2, skillIndex: slashSkillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName: "llamacpp",
      });
      assert.ok(!r.names.has("generate_xlsx"), "raw '/pptx' text must not leak a false file-generate classification");
      assert.ok(!r.names.has("generate_docx"), "raw '/pptx' text must not leak a false file-generate classification");
    } finally {
      fs.rmSync(slashRoot, { recursive: true, force: true });
    }
  });

  test("includes a currently-matched skill's required script tool in the budget-priority set (P2 review finding)", () => {
    // run_node_script/run_python_script are attached to `names` based on the
    // matched skill's OWN content (a `node`/`python` code fence), not via
    // classifyProfiles — so they were never covered by currentTurnNames at
    // all before this fix. During a pinned llama.cpp flow under a tight
    // budget, a carried-forward intent tool (inserted earlier, so untouched
    // by the priority tier) could outrank the script tool THIS turn's own
    // matched skill actually requires, leaving its instructions with nothing
    // to execute them.
    const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-script-"));
    try {
      writeSkill("script-runner", { load: "on-demand", content: "Run `node build.js` to build it.", at: scriptRoot });
      const scriptSkillIndex = loadSkillIndex(path.join(scriptRoot, "skills"), path.join(scriptRoot, "var", "skills"), []);

      const r = planTurnTools([], "please use the script runner to build this", {
        turnNum: 1, skillIndex: scriptSkillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName: "llamacpp",
      });
      assert.ok(r.skills.some(s => s.name === "script-runner"), "sanity: the skill actually matched this turn");
      assert.ok(r.names.has("run_node_script"), "sanity: the script tool is attached to the full set");
      assert.ok(r.currentTurnNames.has("run_node_script"), "the script tool is also in the budget-priority set");
    } finally {
      fs.rmSync(scriptRoot, { recursive: true, force: true });
    }
  });

  test("carries a historical turn's skill-added script tool forward through the pin window (P2 review finding)", () => {
    // run_node_script is attached to a turn's `names` via the matched skill's
    // OWN content (a `node` code fence), never via classifyProfiles — so
    // reconstructing a HISTORICAL turn's tool set from classifyProfiles alone
    // (namesForProfiles(carried)) can never recover it, even though the
    // assistant actually called it. Before this fix, a keyword-free
    // follow-up right after a skill-driven run_node_script call would
    // silently drop that tool from `names`, defeating both the pin
    // mechanism's stability promise and llama-server's prefix-cache reuse
    // for a still-continuing scripted flow.
    const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-script-pin-"));
    try {
      writeSkill("script-runner", { load: "on-demand", content: "Run `node build.js` to build it.", at: scriptRoot });
      const scriptSkillIndex = loadSkillIndex(path.join(scriptRoot, "skills"), path.join(scriptRoot, "var", "skills"), []);

      const transcript = [
        { role: "user", content: "please use the script runner to build this" },
        { role: "assistant", content: [{ type: "tool_use", name: "run_node_script", input: {}, id: "t1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "Built it." },

        { role: "user", content: "thanks!" },
      ];
      const r = planTurnTools(transcript, "thanks!", {
        turnNum: 2, skillIndex: scriptSkillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName: "llamacpp",
      });
      assert.ok(r.names.has("run_node_script"), "the skill-added tool the assistant actually called must stay pinned");
    } finally {
      fs.rmSync(scriptRoot, { recursive: true, force: true });
    }
  });

  test("a just-armed skill tool survives capToolsForWindow's schema-budget cap, not just the uncapped names set (P2 review finding)", () => {
    // Runs the actual capping path (capToolsForWindow), not just planTurnTools'
    // uncapped `names` — the review's own point: prior script-pin tests only
    // ever checked availability, never that the tool survives a tight
    // llama.cpp schema budget. Turn 1 arms the pin with a large profile
    // (docgraph, 7 tools); turn 2 genuinely pivots to a different, small
    // topic (wiki) — which correctly demotes docgraph to stale, per the
    // pivot mechanism — AND calls the skill-added run_node_script that same
    // turn. Turn 3 is a keyword-free follow-up. Without prioritizing
    // run_node_script (profile-invisible; it's never in currentTurnNames
    // through classifyProfiles alone), it lands in `intentStale` at the very
    // end of `names`' insertion order (carriedToolNames is always appended
    // last) — right after the expensive, now-properly-stale docgraph
    // cluster, which alone exhausts the budget before run_node_script's
    // position is ever reached.
    const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-script-cap-"));
    try {
      writeSkill("script-runner", { load: "on-demand", content: "Run `node build.js` to build it.", at: scriptRoot });
      const scriptSkillIndex = loadSkillIndex(path.join(scriptRoot, "skills"), path.join(scriptRoot, "var", "skills"), []);

      const transcript = [
        { role: "user", content: "search my documents for the invoice" },
        { role: "assistant", content: [{ type: "tool_use", name: "doc_search", input: {}, id: "t1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "Found some documents." },

        { role: "user", content: "update the wiki using the script runner" },
        { role: "assistant", content: [{ type: "tool_use", name: "run_node_script", input: {}, id: "t2" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] },
        { role: "assistant", content: "Built it." },

        { role: "user", content: "thanks!" },
      ];
      const r = planTurnTools(transcript, "thanks!", {
        turnNum: 3, skillIndex: scriptSkillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName: "llamacpp",
      });
      assert.ok(r.names.has("run_node_script"), "sanity: available in the uncapped set");
      assert.ok(r.currentTurnNames.has("run_node_script"), "sanity: the just-armed tool is in the priority set");
      assert.ok(!r.currentTurnNames.has("doc_search"), "sanity: the genuine pivot (wiki) correctly demoted docgraph to stale");

      const smallWin = 8191; // matches tool-profiles.test.js's own small-window convention
      const schemaTokenCosts = new Map([
        ["doc_search", 1000], ["doc_repos", 1000], ["doc_manifest", 1000], ["doc_batch", 1000],
        ["doc_outline", 1000], ["doc_context", 1000], ["doc_refs", 1000],
      ]);

      const withoutPriority = capToolsForWindow(r.names, smallWin, { schemaTokenCosts });
      assert.ok(!withoutPriority.has("run_node_script"), "sanity: plain insertion order lets the stale docgraph cluster starve the budget before run_node_script is ever reached");

      const capped = capToolsForWindow(r.names, smallWin, { schemaTokenCosts, currentTurnNames: r.currentTurnNames });
      assert.ok(capped.has("run_node_script"), "the just-armed skill tool survives the real schema-budget cap, not just the uncapped names set");
    } finally {
      fs.rmSync(scriptRoot, { recursive: true, force: true });
    }
  });

  test("reconstructs a mid-conversation slash-invoked turn exactly as classified live (P2 review finding)", () => {
    // Live classification builds `text` by joining the RAW recentUserText
    // window and slash-parsing the WHOLE joined string exactly once —
    // parseSlashSkill only strips a "/skill" prefix when it sits at the very
    // START of the string it's given. Turn 2's slash command here is NOT
    // first in its own live window (turn 1's unrelated text precedes it), so
    // it was never actually stripped live: the literal "pptx" stayed in
    // `text` and legitimately triggered file-generate (which is why the turn
    // called a tool at all). The pre-fix reconstruction cleaned each
    // historical turn's text individually BEFORE windowing, which always
    // strips the slash regardless of position — silently losing turn 2's
    // real, tool-triggering classification from turn 3's pin/carry
    // reconstruction.
    const slashRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-slash-mid-"));
    try {
      writeSkill("pptx", { load: "on-demand", content: "Build slide decks.", at: slashRoot });
      const slashSkillIndex = loadSkillIndex(path.join(slashRoot, "skills"), path.join(slashRoot, "var", "skills"), []);

      const transcript = [
        { role: "user", content: "what's the weather like" },
        { role: "assistant", content: "I don't have weather access." },

        { role: "user", content: "/pptx summarize these notes" },
        { role: "assistant", content: [{ type: "tool_use", name: "write_file", input: {}, id: "t1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "Done." },

        { role: "user", content: "thanks!" },
      ];
      const r = planTurnTools(transcript, "thanks!", {
        turnNum: 3, skillIndex: slashSkillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName: "llamacpp",
      });
      assert.ok(r.names.has("generate_docx"), "file-generate (never itself called, only reachable via the un-stripped 'pptx' classification) stays pinned forward");
    } finally {
      fs.rmSync(slashRoot, { recursive: true, force: true });
    }
  });

  test("preserves a skill-attached script tool that the assistant never itself called (P2 review finding)", () => {
    // run_node_script is ATTACHED to a turn's request because a matched
    // skill's own content requires it — independent of which tool the
    // assistant actually calls that turn. The array llama-server cached for
    // that turn included run_node_script regardless; calledNames alone
    // (only tools the assistant actually invoked) can never recover it if
    // the assistant happened to call a different tool (recall) instead. A
    // follow-up missing run_node_script is exactly as cache-invalidating as
    // one missing a called tool.
    const scriptRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aperio-turn-planner-script-uncalled-"));
    try {
      writeSkill("script-runner", { load: "on-demand", content: "Run `node build.js` to build it.", at: scriptRoot });
      const scriptSkillIndex = loadSkillIndex(path.join(scriptRoot, "skills"), path.join(scriptRoot, "var", "skills"), []);

      const transcript = [
        { role: "user", content: "please use the script runner to build this" },
        { role: "assistant", content: [{ type: "tool_use", name: "recall", input: {}, id: "t1" }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        { role: "assistant", content: "Looked into it." },

        { role: "user", content: "thanks!" },
      ];
      const r = planTurnTools(transcript, "thanks!", {
        turnNum: 2, skillIndex: scriptSkillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName: "llamacpp",
      });
      assert.ok(r.names.has("run_node_script"), "the skill-attached (but never itself called) script tool must still stay pinned");
    } finally {
      fs.rmSync(scriptRoot, { recursive: true, force: true });
    }
  });

  test("without any tool-using turn, nothing carries forward beyond the ordinary 2-turn text window", () => {
    // Turn 2 still legitimately sees turn 1's wording via recentUserText's
    // existing 2-turn window (unrelated to the pin mechanism, unchanged from
    // today). Turn 3 is where the pin mechanism's OWN long-range carry-forward
    // would show up if it fired — it must not, since no turn ever used a tool.
    const noToolTranscript = [
      { role: "user", content: "search my documents for the invoice" },
      { role: "assistant", content: "Here's what I found, without calling a tool." },
      { role: "user", content: "ok continue" },
      { role: "assistant", content: "Sure." },
      { role: "user", content: "still there?" },
    ];
    const r = planTurnTools(noToolTranscript, "still there?", {
      turnNum: 3, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
    assert.ok(!r.names.has("doc_search"), "no tool call happened this flow, so nothing pins forward long-range");
  });

  // Regression for the P2 review finding: sticky pin/carry accumulation must
  // not apply to providers other than llama.cpp — they get no cache benefit
  // from it (capToolsForProvider already leaves their tool contracts
  // uncapped) and would otherwise carry stale/mutating schemas forward for
  // TOOL_PIN_TURNS extra turns for nothing but added schema-token cost.
  test("does not carry tools forward on non-llama.cpp providers, even after a tool-using turn", () => {
    // Turn 3, not turn 2: turn 2's ORDINARY 2-turn text window (recentUserText,
    // unrelated to the sticky mechanism and unaffected by providerName) still
    // legitimately contains turn 1's wording, so testing at turn 2 wouldn't
    // isolate the sticky mechanism at all. By turn 3, turn 1 has fallen out of
    // the ordinary window (only turn 2 + turn 3 remain in it) — docgraph
    // showing up here can only come from the sticky pin/carry mechanism.
    for (const providerName of [undefined, "anthropic", "gemini", "deepseek", "codex", "claude-code"]) {
      const upto = transcript.slice(0, 9); // through turn 3's own message
      const r = planTurnTools(upto, "now query the database schema", {
        turnNum: 3, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
        providerName,
      });
      assert.ok(!r.names.has("doc_search"), `provider "${providerName}" must not carry docgraph forward from turn 1`);
    }
  });
});

describe("planTurnTools — preflight-injected tool_use is excluded from the sticky fold (P2 review finding)", () => {
  // "fake_test_tool_xyz" is not registered in TOOL_PROFILES/HOST_TOOL_PROFILES,
  // so the only way it can appear in a later turn's `names` is via the sticky
  // fold's carriedToolNames — isolating exactly the mechanism under test,
  // independent of any text-keyword classification overlap.
  function transcriptWith(marked) {
    const call = { type: "tool_use", name: "fake_test_tool_xyz", input: {}, id: "pf1" };
    return [
      { role: "user", content: "some unrelated first message" },                       // turn 1
      { role: "assistant", content: [call], ...(marked ? { [PREFLIGHT_TOOL_USE]: true } : {}) },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "pf1", content: "ok" }] },
      { role: "assistant", content: "done" },
      { role: "user", content: "ok thanks" },                                          // turn 2 — no keywords of its own
    ];
  }

  test("an ordinary (unmarked) historical tool_use is still carried forward — baseline sanity check", () => {
    const transcript = transcriptWith(false);
    const r = planTurnTools(transcript, "ok thanks", {
      turnNum: 2, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
    assert.ok(r.names.has("fake_test_tool_xyz"), "a genuine historical tool call should still pin forward");
  });

  test("a PREFLIGHT_TOOL_USE-marked historical tool_use is NOT carried forward", () => {
    const transcript = transcriptWith(true);
    const r = planTurnTools(transcript, "ok thanks", {
      turnNum: 2, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      providerName: "llamacpp",
    });
    assert.ok(!r.names.has("fake_test_tool_xyz"),
      "preflight.js's synthetic tool_use was never actually offered to the model that turn (finalizeTurnTools withheld it), so it must not pin a schema forward llama-server never cached");
  });
});

describe("planTurnTools — vision flags", () => {
  test("flags hasInlineImage/standaloneVision for a bare 'describe this image' turn with an inline image block", () => {
    const messages = [{ role: "user", content: [
      { type: "text", text: "describe this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
    ] }];
    const result = planTurnTools(messages, "describe this image", {
      turnNum: 1, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
    });
    assert.strictEqual(result.hasInlineImage, true);
    assert.strictEqual(result.standaloneVision, true);
  });

  test("does not flag hasInlineImage when there is no image block", () => {
    const result = planTurnTools([{ role: "user", content: "hello" }], "hello", {
      turnNum: 1, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
    });
    assert.strictEqual(result.hasInlineImage, false);
    assert.strictEqual(result.standaloneVision, false);
  });

  // Regression for a P2 review finding: model-context-middleware.js passes
  // the FULL untrimmed history as `messages` (so the sticky pin/carry fold can
  // see historical tool-using turns the context-trimmer already shed) but must
  // pass the TRIMMED, model-facing history as `imageMessages` — an image old
  // enough to have fallen out of the trimmed context is no longer visible to
  // the model, so it must not still classify an unrelated later turn ("read
  // this file") as standalone vision and clear every tool via filterVisionTools.
  test("derives hasInlineImage/standaloneVision from imageMessages, not messages, when imageMessages is given", () => {
    const untrimmedWithStaleImage = [{ role: "user", content: [
      { type: "text", text: "describe this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
    ] }];
    const trimmedNoImage = [{ role: "user", content: "read this file" }];
    const result = planTurnTools(untrimmedWithStaleImage, "read this file", {
      turnNum: 2, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
      imageMessages: trimmedNoImage,
    });
    assert.strictEqual(result.hasInlineImage, false, "the stale image lives only in the untrimmed `messages`, not in imageMessages");
    assert.strictEqual(result.standaloneVision, false);
  });

  test("imageMessages defaults to messages when omitted (every non-llama.cpp caller)", () => {
    const messages = [{ role: "user", content: [
      { type: "text", text: "describe this image" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "pixels" } },
    ] }];
    const result = planTurnTools(messages, "describe this image", {
      turnNum: 1, skillIndex, shellAllowed: true, pendingForcedSkillNames: [], pendingSemanticSkillNames: [],
    });
    assert.strictEqual(result.hasInlineImage, true);
  });
});
