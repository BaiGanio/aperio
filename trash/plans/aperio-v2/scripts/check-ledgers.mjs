#!/usr/bin/env node
// T0.3 + T0.4 — the Feature Ledger and Lessons Ledger are complete.
// Run from the repo root: node trash/plans/aperio-v2/scripts/check-ledgers.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const TAG = "archive/v1-final";
const DIR = "trash/plans/aperio-v2";
const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
const featuresFull = readFileSync(`${DIR}/feature-ledger.md`, "utf8");
// the roll-up section is a summary, not ledger rows
const features = featuresFull.split("## Status roll-up")[0];
const lessons = readFileSync(`${DIR}/lessons-ledger.md`, "utf8");

const fail = [];
const ok = [];
const check = (label, missing, total) =>
  missing.length
    ? fail.push(`${label}: ${missing.length}/${total} missing -> ${missing.join(", ")}`)
    : ok.push(`${label}: ${total}/${total}`);

// --- T0.3: every inventory item has a row -----------------------------------
const headings = git("show", `${TAG}:FEATURES.md`)
  .split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
check("FEATURES.md headings", headings.filter((h) => !features.includes(h)), headings.length);

const tools = git("ls-tree", "--name-only", `${TAG}:mcp/tools/`)
  .split("\n").filter(Boolean);
check("mcp/tools entries", tools.filter((t) => {
  const needle = t.endsWith(".js") ? `\`${t}\`` : `\`${t}/\``;
  return !features.includes(needle);
}), tools.length);

const panels = git("ls-tree", "--name-only", `${TAG}:public/scripts/`)
  .split("\n").filter(Boolean);
check("public/scripts entries", panels.filter((p) => {
  const needle = p.endsWith(".js") ? `\`${p}\`` : `\`${p}/\``;
  return !features.includes(needle);
}), panels.length);

const skills = git("ls-tree", "--name-only", "-d", `${TAG}:skills/`)
  .split("\n").filter(Boolean);
check("skills dirs", skills.filter((s) => !features.includes(`\`${s}\``)), skills.length);

// --- T0.3: every status cell is one of the four words ----------------------
const STATUS = /\*\*(core|later|parked|never)\*\*/;
// every data row in sections A-D (one that is not a header or separator) needs a status
const isDataRow = (l) =>
  l.startsWith("| ") && !l.startsWith("| ---") && !l.includes("| v2 status |") &&
  !l.includes("| Question |") && !l.includes("| Lesson |") && !l.includes("| Note |") &&
  !l.includes("|---");
const rows = features.split("\n").filter(isDataRow);
const noStatus = rows.filter((r) => !STATUS.test(r)).map((r) => r.slice(0, 48));
check("rows with a valid status", noStatus, rows.length);

// --- T0.3: no blank cell in any ledger row --------------------------------
const blank = features.split("\n")
  .filter((l) => isDataRow(l) && STATUS.test(l))
  .filter((l) => l.split("|").slice(1, -1).some((c) => c.trim() === ""))
  .map((l) => l.slice(0, 48));
check("rows with no blank cell", blank, rows.length);

// --- T0.3: self-memory is parked ------------------------------------------
check("self-memory row = parked",
  /\| Self-Memory \| \*\*parked\*\*/.test(features) ? [] : ["Self-Memory is not parked"], 1);

// --- T0.4: every open tech-debt item is a lesson ---------------------------
const debt = readFileSync("id/reference/tech-debt.md", "utf8")
  .split("\n").filter((l) => l.startsWith("## "))
  .map((l) => l.slice(3).trim())
  .filter((h) => !["Running Code Depth", "<Topic / Area>", "Intentional deferrals",
                   "Investigated and rejected"].includes(h));
// each one must be named by a lesson's Source cell (first distinctive word group)
const debtMissing = debt.filter((h) => {
  const key = h.split(/[—(]/)[0].trim().slice(0, 24);
  return !lessons.includes(key);
});
check("open tech-debt items covered", debtMissing, debt.length);

// --- T0.4: every feedback_* memory note is a lesson ------------------------
const memDir = `${process.env.HOME}/.claude/projects/-Users-lk-Projects-BaiGanio-aperio/memory`;
const notes = readdirSync(memDir).filter((f) => f.startsWith("feedback_"));
check("feedback_* notes covered",
  notes.filter((n) => !lessons.includes(n.replace(/\.md$/, ""))), notes.length);

// --- T0.4: every lesson has a source --------------------------------------
const lessonRows = lessons.split("\n").filter((l) => /^\| L-[PCM]\d\d \|/.test(l));
check("lessons with a source cell",
  lessonRows.filter((l) => {
    const cells = l.split("|").map((c) => c.trim());
    return cells[cells.length - 2] === "";
  }), lessonRows.length);

// --- T0.3: the roll-up numbers match the tables ---------------------------
{
  const sections = featuresFull.split("## Status roll-up")[0].split("\n## ").slice(1);
  const tallied = sections.map((sec) => {
    const c = { core: 0, later: 0, parked: 0, never: 0 };
    for (const line of sec.split("\n")) {
      const m = line.startsWith("| ") && line.match(STATUS);
      if (m) c[m[1]] += 1;
    }
    return c;
  });
  const rollup = featuresFull.split("## Status roll-up")[1] ?? "";
  const stated = (word) => {
    const row = rollup.split("\n").find((l) => l.startsWith(`| \`${word}\` |`));
    return row ? row.split("|").slice(2, 6).map((n) => Number(n.trim())) : null;
  };
  const bad = [];
  for (const word of ["core", "later", "parked", "never"]) {
    const said = stated(word);
    const real = tallied.map((c) => c[word]);
    if (!said || said.join(",") !== real.join(",")) {
      bad.push(`${word}: roll-up says ${said?.join("/") ?? "?"}, tables say ${real.join("/")}`);
    }
  }
  check("roll-up matches the tables", bad, 4);
}

for (const line of ok) console.log(`ok   ${line}`);
for (const line of fail) console.log(`FAIL ${line}`);
console.log(fail.length ? `\n${fail.length} check(s) failed` : "\nall checks passed");
process.exit(fail.length ? 1 : 0);
