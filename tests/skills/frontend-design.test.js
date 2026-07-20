import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadSkillIndex, matchSkills } from "../../lib/workers/skills.js";

const root = resolve(process.cwd());
const skillPath = resolve(root, "skills/frontend-design/SKILL.md");

// The deliverable threshold lives in three places: persistAnswerArtifacts (the
// authority, which decides what actually reaches disk), the client mirror in
// _isDeliverable, and the SKILL.md prose that tells the model how long a block
// must be to become a previewable artifact. Prose that drifts from the constant
// silently teaches the model the wrong contract — it did exactly that once — so
// the numbers are parsed from source and pinned to each other here.
function parseThreshold(relPath, pattern) {
  const src = readFileSync(resolve(root, relPath), "utf8");
  const m = src.match(pattern);
  assert.ok(m, `deliverable threshold not found in ${relPath} — update ${pattern} and the docs it pins`);
  return { chars: Number(m[1]), lines: Number(m[2]) };
}

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

test("the skill's artifact threshold matches the code that enforces it", () => {
  const server = parseThreshold(
    "lib/agent/index.js",
    /body\.length < (\d+) && body\.split\("\\n"\)\.length < (\d+)/,
  );
  const client = parseThreshold(
    "public/scripts/streaming.js",
    /text\.length >= (\d+) \|\| text\.split\("\\n"\)\.length >= (\d+)/,
  );
  assert.deepEqual(client, server, "client _isDeliverable drifted from persistAnswerArtifacts");

  const body = readFileSync(skillPath, "utf8");
  assert.match(body, new RegExp(`${server.chars}\\+? characters`, "i"),
    `SKILL.md must cite the ${server.chars}-character artifact threshold`);
  assert.match(body, new RegExp(`${server.lines}\\+? lines`, "i"),
    `SKILL.md must cite the ${server.lines}-line artifact threshold`);
});

test("the skill's filename claims match persistAnswerArtifacts", () => {
  const src = readFileSync(resolve(root, "lib/agent/index.js"), "utf8");
  const body = readFileSync(skillPath, "utf8");
  assert.match(src, /base = `\$\{slug\}\.html`/, "title-slug filename derivation moved");
  assert.match(src, /"index\.html"/, "index.html fallback moved");
  assert.match(body, /<title>` becomes the filename/i, "SKILL.md must document the title-as-filename rule");
  assert.match(body, /index\.html/, "SKILL.md must document the index.html fallback");
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
