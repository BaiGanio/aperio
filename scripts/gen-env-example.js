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
# This template is deliberately tiny: it holds only bootstrap plumbing plus
# the essential provider choices. EVERY OTHER setting is a typed control in
# the app — open the sidebar's Configuration panel — and is stored in the
# database, not here. Most people never touch this file at all: run
# \`npm start\` and the setup wizard in your browser writes a real \`.env\`.
#
# To configure by hand: copy this file to \`.env\` and set the ESSENTIALS
# block below. Everything past the STOP line is bootstrap/security plumbing
# that must live in \`.env\`; it already has sensible defaults.
#
# Developers: you can still add ANY variable here by hand (see the full list
# in the Configuration panel or \`npm run config:sync\`). A value saved in the
# UI is stored in the DB and overrides \`.env\` (precedence: DB > .env >
# default).
#
# NEVER commit .env to git.
# ============================================================`;

const STOP = `
# ╶───────────────────────────────────────────────────────────╴
#  ✋  YOU CAN STOP HERE.
#      Everything below is bootstrap/security plumbing that must live
#      in .env. Every other setting lives in the app's Configuration
#      panel (saved to the database). Only change the lines below if
#      you know you need to.
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

// The template only ships the essentials block + Tier-0 bootstrap/security
// plumbing that must live in `.env`. Every other (Tier-1) variable is edited
// in the app's Configuration panel and persisted to the database, so it is
// intentionally omitted here.
const isTemplateVar = (e) => e.section === "essentials" || e.tier === 0;

function build() {
  const parts = [HEADER, ""];
  const essentials = SECTIONS.find((s) => s.id === "essentials");

  // Essentials first, then the STOP banner, then everything else.
  const order = [essentials, ...SECTIONS.filter((s) => s.id !== "essentials")];

  for (const section of order) {
    const entries = CONFIG.filter((e) => e.section === section.id && isTemplateVar(e));
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
  const count = CONFIG.filter(isTemplateVar).length;
  console.log(`✓ Wrote .env.example (${count} of ${CONFIG.length} variables — essentials + Tier-0 bootstrap; the rest live in the Configuration panel).`);
}
