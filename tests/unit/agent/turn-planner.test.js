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

let root, skillIndex;

function writeSkill(name, { load = "on-demand", dependsOn = null, content = "Do the thing." } = {}) {
  fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
  const lines = ["---", `name: ${name}`, `description: ${name} skill`, "metadata:", `  load: ${load}`];
  if (dependsOn) lines.push(`  depends-on: ${dependsOn}`);
  lines.push("---", "", content);
  fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), lines.join("\n"), "utf8");
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
});
