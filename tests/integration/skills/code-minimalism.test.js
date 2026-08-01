/**
 * WS1 of epic #285 — the pre-write code-minimalism skill.
 *
 * Groups M1–M6 of trash/plans/ponytail-borrow/ponytail-borrow-ws1-tests.md.
 * The matcher and the autotune scorer are used as-is: this file asserts against
 * the real skill index, never a fixture, because keyword collision with the other
 * 31 skills is the whole risk being guarded.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadSkillIndex, matchSkills } from "../../../lib/workers/skills.js";
import { planTurnTools } from "../../../lib/agent/turn-planner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const SKILL_PATH = resolve(ROOT, "skills", "code-minimalism", "SKILL.md");

const index = loadSkillIndex(resolve(ROOT, "skills"));
const skill = index.find(s => s.name === "code-minimalism");
const names = (prompt, limit = 4) =>
  matchSkills(prompt, index, { limit }).map(s => s.name);

// ── M1 — frontmatter and index registration ──────────────────────────────────
describe("M1 — frontmatter and index registration", () => {
  test("SKILL.md exists and is non-empty", () => {
    assert.ok(existsSync(SKILL_PATH), `missing ${SKILL_PATH}`);
    assert.ok(readFileSync(SKILL_PATH, "utf8").trim().length > 0, "SKILL.md is empty");
  });

  test("the real loader indexes it with house frontmatter", () => {
    assert.ok(skill, "code-minimalism not found in the skill index");
    assert.ok(skill.description?.trim().length > 0, "missing description");
    assert.ok(skill.keywords?.trim().length > 0, "missing metadata.keywords");
    assert.equal(skill.category, "engineering-discipline");
    // load: "always" would inject the skill into every turn — exactly the context
    // cost this epic exists to avoid. Assert the value, not merely its presence.
    assert.equal(skill.load, "on-demand");
    assert.equal(skill.source, "bundled");
  });
});

// ── M2 — body integrity ──────────────────────────────────────────────────────
describe("M2 — body integrity", () => {
  const raw = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, "utf8") : "";
  // Ladder ordering is asserted on the body only: curated keywords in the
  // frontmatter legitimately repeat ladder vocabulary and would otherwise
  // register as a first occurrence above the ladder itself.
  const body = raw.startsWith("---") ? raw.slice(raw.indexOf("\n---", 3) + 4) : raw;

  test("the ladder appears in order", () => {
    // First-occurrence indices, not `includes` — a scrambled or truncated ladder
    // must fail. Each rung is identified by its most stable phrase.
    const rungs = [
      /does this need to exist/i,
      /already in this codebase/i,
      /stdlib|standard library/i,
      /native platform|platform already/i,
      /already[- ]installed dependency/i,
      /few inline lines|inline lines/i,
      /minimum viable/i,
    ];
    let previous = -1;
    for (const rung of rungs) {
      const match = body.match(rung);
      assert.ok(match, `ladder rung missing: ${rung}`);
      const at = match.index;
      assert.ok(at > previous, `ladder rung out of order: ${rung}`);
      previous = at;
    }
  });

  test("the non-negotiables are explicit", () => {
    assert.match(body, /^## When NOT to Use$/m, "missing '## When NOT to Use' section");
    for (const term of ["validation", "error handling", "security", "test"]) {
      assert.ok(body.toLowerCase().includes(term), `non-negotiable not named: ${term}`);
    }
    assert.match(body, /not corner[- ]cutting/i, "must state that minimalism is not corner-cutting");
  });

  test("cross-links its siblings", () => {
    assert.ok(body.includes("[[code-simplification]]"), "missing [[code-simplification]] link");
    assert.ok(body.includes("[[reasoning-planning]]"), "missing [[reasoning-planning]] link");
  });

  test("attributes ponytail under MIT", () => {
    assert.match(body, /ponytail/i, "missing ponytail attribution");
    assert.match(body, /MIT/, "missing MIT license note");
    assert.match(body, /https?:\/\/\S*ponytail/i, "missing link to ponytail");
  });

  test("keeps the engineering-discipline house shape", () => {
    for (const heading of ["## Rationalizations", "## Red Flags", "## Verification"]) {
      assert.ok(body.includes(heading), `missing house section: ${heading}`);
    }
  });

  test("distinguishes inline code requests from file-delivery requests", () => {
    assert.match(body, /does not by itself authorize\s+(?:saving|writing).+file/is);
    assert.match(body, /answer.+inline/is);
    assert.match(body, /names? a file|file(?:name)? or path/is);
  });
});

// ── M3 — positive matching ───────────────────────────────────────────────────
describe("M3 — positive matching", () => {
  const positives = [
    "Write me a helper for turning a title into a URL slug.",
    "Add a small feature to the export command: an optional date range.",
    "Do I need a library for this, or can we do it with what we already have?",
    "Keep it minimal — just the minimum viable code that solves it.",
  ];

  for (const prompt of positives) {
    test(`matches: "${prompt}"`, () => {
      const got = names(prompt);
      assert.ok(got.includes("code-minimalism"), `got [${got.join(", ")}]`);
    });
  }

  test("wins the first slot at least once", () => {
    // Appearing fourth is worthless to a weak model that only reads the first
    // injected skill — the skill has to actually win a slot somewhere.
    const firsts = positives.map(p => names(p)[0]);
    assert.ok(firsts.includes("code-minimalism"), `never ranked first: [${firsts.join(", ")}]`);
  });

  test("the reported bare-code prompt loads the skill without offering write_file", () => {
    const prompt = "Keep it minimal, but write a function that parses a numeric config " +
      "value from an env string and handles missing or malformed input explicitly.";
    const planned = planTurnTools([], prompt, {
      turnNum: 1,
      skillIndex: index,
      shellAllowed: false,
    });

    assert.ok(planned.skills.some(s => s.name === "code-minimalism"));
    assert.ok(!planned.names.has("write_file"));
  });

  test("an explicit filename restores write_file for the same task", () => {
    const prompt = "Keep it minimal, but write a function that parses a numeric config " +
      "value from an env string. Save it to parseConfigValue.js.";
    const planned = planTurnTools([], prompt, {
      turnNum: 1,
      skillIndex: index,
      shellAllowed: false,
    });

    assert.ok(planned.skills.some(s => s.name === "code-minimalism"));
    assert.ok(planned.names.has("write_file"));
  });
});

// ── M4 — negative matching (no collateral damage) ────────────────────────────
describe("M4 — negative matching", () => {
  test("a pure debugging turn does not pull in code-minimalism", () => {
    // Two shapes: one that matches nothing today (so the assertion is "WS1 must
    // not change that"), and one where debugging-and-error-recovery already wins
    // (so the assertion is "WS1 must not displace it"). Making the first prompt
    // fire the debugging skill is a pre-existing matcher gap, not WS1's job.
    const quiet = names("The helper function throws a TypeError on empty input — find out why.");
    assert.ok(!quiet.includes("code-minimalism"), `code-minimalism leaked: [${quiet.join(", ")}]`);

    const loud = names("Something is throwing an exception on startup and I need to find the cause.");
    assert.equal(loud[0], "debugging-and-error-recovery", `got [${loud.join(", ")}]`);
    assert.ok(!loud.includes("code-minimalism"), `code-minimalism leaked: [${loud.join(", ")}]`);
  });

  test("a doc-only edit matches nothing from this skill", () => {
    const got = names("Fix a typo in the README and update the heading.");
    assert.ok(!got.includes("code-minimalism"), `code-minimalism leaked: [${got.join(", ")}]`);
  });

  test("a post-write cleanup still belongs to code-simplification", () => {
    const got = names(
      "This function is overcomplicated — simplify it and reduce the nesting without changing behavior.",
    );
    assert.equal(got[0], "code-simplification", `got [${got.join(", ")}]`);
  });

  test("the house exact-match prompts are unchanged", () => {
    // Re-asserted from skills.test.js so a WS1 keyword regression is diagnosed at
    // its cause rather than three files away.
    assert.deepEqual(
      matchSkills(
        "Create a new file called notes-for-me.md and write a short note inside it: Reminder — review the Lie Catcher results on Friday. Save it and confirm the file path.",
        index,
      ),
      [],
    );

    const pptxPrompt = `Write a PptxGenJS script aperio-title.js that creates aperio-title.pptx with a single title slide:
- Layout: 16x9
- Title: "Aperio — Personal Memory Layer for AI Agents"
- Subtitle: "One brain. Every agent. Nothing forgotten."
- A thin accent line centered below the title
- Background: white

Use require("pptxgenjs") (CommonJS). Save with writeFile. Print the output path to console.`;
    assert.deepEqual(matchSkills(pptxPrompt, index).map(s => s.name), ["pptx"]);
  });
});

// ── M5 — eval coverage ───────────────────────────────────────────────────────
describe("M5 — eval coverage", () => {
  const readJson = rel => JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
  const evalSet = readJson("skills/autotune/eval.json");
  const negatives = readJson("skills/autotune/eval.negatives.json");

  test("positives exist in eval.json", () => {
    const positives = evalSet.cases.filter(c => c.expect === "code-minimalism");
    assert.ok(positives.length >= 3, `only ${positives.length} positive case(s)`);
  });

  test("expectNot cases exist in eval.json", () => {
    const nots = evalSet.cases.filter(c => c.expectNot?.includes("code-minimalism"));
    assert.ok(nots.length >= 2, `only ${nots.length} expectNot case(s)`);
  });

  test("every case has a unique id and a reported set", () => {
    const ids = evalSet.cases.map(c => c.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate case id in eval.json");
    for (const c of evalSet.cases) {
      assert.ok(["exam", "hard"].includes(c.set), `case ${c.id} has unreported set "${c.set}"`);
    }
  });

  test("eval.negatives.json gained a doc-only-edit turn", () => {
    assert.ok(
      negatives.negatives.some(p => /typo|readme|changelog|proofread/i.test(p)),
      "no doc-only-edit negative present",
    );
  });
});

// ── M6 — no regression against the recorded baseline ─────────────────────────
describe("M6 — no regression", () => {
  // Recorded on f77b1bf, before WS1: train 0.8049, holdout 0.4286, kwChars 4548.
  // Pinned as a SET OF CASE IDS, not an accuracy float — WS1 adds cases, which
  // moves the denominator while leaving the regression question intact.
  const BASELINE_FAILS = new Set([
    "7.12", "hard.pptx", "hard.docx-adv", "hard.canvas",
    "hard.prompt-opt", "hard.mcp", "hard.wiki", "hard.xlsx",
  ]);
  const BASELINE_HOLDOUT = 0.4286;

  const run = spawnSync("node", ["skills/autotune/score.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });

  test("the scorer runs and reports JSON", () => {
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes("{"), "no JSON in scorer output");
  });

  // The scorer logs a startup line before the JSON payload.
  const report = JSON.parse(run.stdout.slice(run.stdout.indexOf("{")));

  test("no failing case id beyond the recorded baseline", () => {
    const introduced = report.fails.map(f => f.id).filter(id => !BASELINE_FAILS.has(id));
    assert.deepEqual(introduced, [], `WS1 broke case(s): ${introduced.join(", ")}`);
  });

  test("every code-minimalism case passes", () => {
    const evalSet = JSON.parse(readFileSync(resolve(ROOT, "skills/autotune/eval.json"), "utf8"));
    const mine = evalSet.cases
      .filter(c => c.expect === "code-minimalism" || c.expectNot?.includes("code-minimalism"))
      .map(c => c.id);
    assert.ok(mine.length > 0, "no code-minimalism cases in the eval set");
    const failed = report.fails.map(f => f.id).filter(id => mine.includes(id));
    assert.deepEqual(failed, [], `code-minimalism case(s) failing: ${failed.join(", ")}`);
  });

  test("holdout accuracy did not drop", () => {
    assert.ok(
      report.holdout >= BASELINE_HOLDOUT,
      `holdout ${report.holdout} < baseline ${BASELINE_HOLDOUT} — keywords are overfitting`,
    );
  });
});
