// scripts/gen-env-example.js
//
// Regenerates `.env.example` from the registry in lib/config.js, so the
// template can never drift from what the code actually reads.
//
//   node scripts/gen-env-example.js          → write .env.example
//   node scripts/gen-env-example.js --check   → exit 1 if it's out of date (CI)
//
// This NEVER writes `.env`. A real `.env` belongs to the user — non-technical
// users get it written by the setup wizard, technical users edit it by hand —
// so we only ever refresh the `.env.example` template alongside it.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { SECTIONS, CONFIG } from "../lib/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", ".env.example");

const HEADER = `# ============================================================
# Aperio — Configuration
#
# AUTO-GENERATED from lib/config.js — do not edit by hand.
# Run \`npm run gen:env\` to regenerate. Edit the registry, not this file.
#
# Most people never edit this file. Just run \`npm start\` and the setup
# wizard in your browser fills in a real \`.env\` for you. Appearance and
# similar in-app preferences live in the database, not here.
#
# To configure by hand: copy this file to \`.env\` and set the values in the
# ESSENTIALS block below. Everything past the STOP line is optional and
# already has sensible defaults.
#
# NEVER commit .env to git.
# ============================================================`;

const STOP = `
# ╶───────────────────────────────────────────────────────────╴
#  ✋  YOU CAN STOP HERE.
#      Everything below is optional and has working defaults.
#      Only change it if you know you need to.
# ╶───────────────────────────────────────────────────────────╴`;

const rule = (title) => {
  const line = "─".repeat(Math.max(0, 58 - title.length));
  return `# ── ${title} ${line}`;
};

function renderEntry(e) {
  const out = [];
  if (e.help) {
    for (const line of e.help.split("\n")) out.push(`# ${line}`.trimEnd());
  }
  if (e.type === "select" && e.options) {
    out.push(`# options: ${e.options.join(" | ")}`);
  }
  const value = e.example !== undefined ? e.example : e.default;
  const assign = `${e.key}=${value}`;
  out.push(e.show === "set" ? assign : `# ${assign}`);
  return out.join("\n");
}

function build() {
  const parts = [HEADER, ""];
  const essentials = SECTIONS.find((s) => s.id === "essentials");

  // Essentials first, then the STOP banner, then everything else.
  const order = [essentials, ...SECTIONS.filter((s) => s.id !== "essentials")];

  for (const section of order) {
    const entries = CONFIG.filter((e) => e.section === section.id);
    if (!entries.length) continue;

    if (section.id !== "essentials" && parts.indexOf(STOP) === -1) parts.push(STOP, "");

    parts.push(rule(section.title));
    if (section.blurb) {
      for (const line of section.blurb.split("\n")) parts.push(`# ${line}`);
    }
    parts.push("");
    parts.push(entries.map(renderEntry).join("\n\n"));
    parts.push("");
  }
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
  const count = CONFIG.length;
  console.log(`✓ Wrote .env.example (${count} variables across ${SECTIONS.length} sections).`);
}
