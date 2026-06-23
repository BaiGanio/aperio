// scripts/gen-env-example.js
//
// Regenerates `.env.example` from the registry in lib/config.js, so the
// template can never drift from what the code actually reads.
//
//   node scripts/gen-env-example.js          → write .env.example
//   node scripts/gen-env-example.js --check   → exit 1 if it's out of date (CI)
//
// The template lists EVERY user-settable variable, ordered by risk group
// (start → features → external → core) with a STOP banner after the safe
// block. Each variable keeps its own commented/uncommented state from the
// registry (`show`), so the safe essentials are ready to edit while advanced
// and bootstrap knobs are shown commented with their defaults.
//
// This NEVER writes `.env`. A real `.env` belongs to the user — non-technical
// users get it written by the setup wizard, technical users edit it by hand —
// so we only ever refresh the `.env.example` template alongside it.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { GROUPS, SECTIONS, CONFIG } from "../lib/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", ".env.example");

const HEADER = `# ============================================================
# Aperio — Configuration
#
# AUTO-GENERATED from lib/config.js — do not edit by hand.
# Run \`npm run gen:env\` to regenerate. Edit the registry, not this file.
#
# This is the complete list of every variable Aperio reads, grouped by how
# risky it is to touch:
#
#   1 START HERE      safe — what most setups actually edit.
#   ── ✋ STOP ──      past here is advanced; the defaults already work.
#   2 OPTIONAL        extra features (usually toggled in the app's UI instead).
#   3 EXTERNAL        keys/endpoints for third-party services.
#   4 CORE/CRITICAL   bootstrap + security plumbing; must live in .env.
#
# To configure by hand: copy this file to \`.env\` and edit the START HERE
# block. Most people never go past the STOP line — run \`npm start\` and the
# setup wizard in your browser writes a real \`.env\` for you.
#
# Precedence: DB (Settings UI) > .env > built-in default. A value saved in
# the UI overrides \`.env\` unless you set APERIO_CONFIG_PRECEDENCE=env.
#
# NEVER commit .env to git.
# ============================================================`;

const STOP = `# ╶───────────────────────────────────────────────────────────╴
#  ✋  STOP HERE unless you know why you're here.
#      Aperio runs fine on the defaults below — most people never edit
#      past this line. Everything beyond is advanced: optional features
#      (normally toggled in the app's Settings panel) and the
#      bootstrap/security plumbing the app depends on.
# ╶───────────────────────────────────────────────────────────╴`;

const groupRule = (title) => {
  const bar = "═".repeat(60);
  return `# ${bar}\n#  ${title}\n# ${bar}`;
};

const rule = (title) => {
  const line = "─".repeat(Math.max(0, 58 - title.length));
  return `# ── ${title} ${line}`;
};

const commentBlock = (text) => text.split("\n").map((l) => `# ${l}`.trimEnd()).join("\n");

// A variable's group is its own override, else its section's group.
const sectionGroup = Object.fromEntries(SECTIONS.map((s) => [s.id, s.group]));
const groupOf = (e) => e.group || sectionGroup[e.section];

function renderEntry(e) {
  const out = [];
  if (e.help) out.push(commentBlock(e.help));
  if (e.type === "select" && e.options) out.push(`# options: ${e.options.join(" | ")}`);
  const value = e.example !== undefined ? e.example : e.default;
  const assign = `${e.key}=${value}`;
  out.push(e.show === "set" ? assign : `# ${assign}`);
  return out.join("\n");
}

function build() {
  const parts = [HEADER, ""];

  GROUPS.forEach((group, gi) => {
    const inGroup = CONFIG.filter((e) => groupOf(e) === group.id);
    if (!inGroup.length) return;

    // STOP banner sits after the first (safe) group, before everything advanced.
    if (gi === 1) parts.push(STOP, "");

    parts.push(groupRule(group.title));
    if (group.blurb) parts.push(commentBlock(group.blurb));
    parts.push("");

    for (const section of SECTIONS) {
      const entries = inGroup.filter((e) => e.section === section.id);
      if (!entries.length) continue;
      parts.push(rule(section.title));
      if (section.blurb) parts.push(commentBlock(section.blurb));
      parts.push("");
      parts.push(entries.map(renderEntry).join("\n\n"));
      parts.push("");
    }
  });

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const generated = build();

if (process.argv.includes("--check")) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing → out of date */ }
  if (current !== generated) {
    console.error("✗ .env.example is out of date. Run `npm run gen:env`.");
    process.exit(1);
  }
  console.log("✓ .env.example is up to date.");
} else {
  writeFileSync(OUT, generated);
  console.log(`✓ Wrote .env.example (${CONFIG.length} variables, grouped by risk).`);
}
