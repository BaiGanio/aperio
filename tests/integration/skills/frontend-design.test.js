import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadSkillIndex, matchSkills } from "../../../lib/workers/skills.js";

const root = resolve(process.cwd());
const skillPath = resolve(root, "skills/frontend-design/SKILL.md");

test("frontend-design is a bundled skill with a concise artifact workflow", () => {
  assert.equal(existsSync(skillPath), true);
  const body = readFileSync(skillPath, "utf8");
  for (const phrase of [
    "standalone HTML",
    "responsive",
    "accessible",
    "Preview",
    "visual feedback",
  ]) {
    assert.match(body, new RegExp(phrase, "i"), `missing ${phrase}`);
  }
});

test("an ordinary HTML page request activates frontend-design", () => {
  const index = loadSkillIndex(resolve(root, "skills"));
  const names = matchSkills(
    "Build a responsive HTML landing page for my bakery and save it as a file.",
    index,
    { limit: 4 },
  ).map(skill => skill.name);
  assert.ok(names.includes("frontend-design"), names.join(", "));
});

test("a simple saved HTML file request activates frontend-design", () => {
  const index = loadSkillIndex(resolve(root, "skills"));
  const names = matchSkills(
    'Write a short HTML file that displays "Hello, Honesty Check" in large blue text. Save it, and tell me the exact full path where I can find it.',
    index,
    { limit: 3 },
  ).map(skill => skill.name);
  assert.ok(names.includes("frontend-design"), names.join(", "));
});
