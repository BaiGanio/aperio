// scripts/gen-env-example.js
//
// Regenerates the two configuration artifacts from the registry in
// lib/config.js, so neither can drift from what the code actually reads:
//
//   .env.example              the complete list of every variable Aperio
//                             reads, grouped by risk, each keeping its own
//                             commented/uncommented state from the registry
//                             (`show`) — dev users get everything in one file.
//   docs/config-reference.md  the same complete inventory as readable
//                             markdown for GitHub. Any of them still works in
//                             a hand-written .env (see APERIO_CONFIG_PRECEDENCE).
//
//   node scripts/gen-env-example.js                 → write both files
//   node scripts/gen-env-example.js --env-only      → write only .env.example
//   node scripts/gen-env-example.js --check         → exit 1 if either is stale (CI)
//   node scripts/gen-env-example.js --out-dir DIR   → write both into DIR (tests)
//
// This NEVER writes `.env`. A real `.env` belongs to the user — non-technical
// users get it written by the setup wizard, technical users edit it by hand —
// so we only ever refresh the generated artifacts alongside it.

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";
import { GROUPS, SECTIONS, CONFIG } from "../lib/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const outDirIdx = process.argv.indexOf("--out-dir");
const outDir = outDirIdx !== -1 ? process.argv[outDirIdx + 1] : null;
const OUT_ENV = outDir ? join(outDir, ".env.example") : join(ROOT, ".env.example");
const OUT_REF = outDir ? join(outDir, "config-reference.md") : join(ROOT, "docs", "config-reference.md");
const REF_LINK = "docs/config-reference.md";

const HEADER = `# Aperio — configuration bootstrap (AUTO-GENERATED)
# Run \`npm run gen:env\` after editing lib/config.js; never edit this file by hand.
# This is the complete list of every variable Aperio reads (${CONFIG.length} total),
# grouped by how risky it is to touch. Only the START HERE block is normally edited.
# The same inventory, as readable markdown, is in ${REF_LINK}.
# Copy to \`.env\`, edit the START HERE values, and run \`npm start\`.
# .env wins when APERIO_CONFIG_PRECEDENCE=env (the active default below).
# Use \`npm run gen:env:check\` to detect drift.`;

const BANNER = `# ╶───────────────────────────────────────────────────────────╴
#  ✋  STOP HERE unless you know why you're continuing.
#      Aperio runs fine with the defaults below. Everything beyond this line
#      is advanced: optional features, integrations, and security plumbing.
# ╶───────────────────────────────────────────────────────────╴`;

const rule = (title) => {
  const line = "─".repeat(Math.max(0, 58 - title.length));
  return `# ── ${title} ${line}`;
};

const commentBlock = (text) => text.split("\n").map((l) => `# ${l}`.trimEnd()).join("\n");

const sectionGroup = Object.fromEntries(SECTIONS.map((s) => [s.id, s.group]));
const groupOf = (e) => sectionGroup[e.section];

// ── complete .env.example ─────────────────────────────────────────────────────
// Every registry entry belongs in this file — dev users get the full
// inventory in one place, not split across .env.example + config-reference.md.
// Only the "start" GROUP honors an entry's `show: "set"`; every other group
// renders commented regardless of `show`, so a plain `cp .env.example .env`
// activates the START HERE block only — never a known-default Postgres
// password or a tier-1 default that would silently outrank a Settings value
// once APERIO_CONFIG_PRECEDENCE=env is in play.
function renderTemplateEntry(e, groupSafe) {
  const out = [];
  if (e.help) out.push(commentBlock(e.help));
  if (e.type === "select" && e.options) out.push(`# options: ${e.options.join(" | ")}`);
  const value = e.example !== undefined ? e.example : e.default;
  const assign = `${e.key}=${value}`;
  // `show: "set"` only takes effect inside the "start" group (GROUPS[].safe).
  // A cp .env.example .env flow must only activate the START HERE block —
  // everything past the STOP banner stays commented no matter what an
  // individual entry's `show` says, so a known-default value (e.g. the
  // Postgres block's aperio_secret password) never gets silently switched on.
  const active = groupSafe && e.show === "set";
  out.push(active ? assign : `# ${assign}`);
  return out.join("\n");
}

function buildTemplate() {
  const parts = [HEADER, ""];
  let bannerEmitted = false;

  for (const group of GROUPS) {
    const inGroup = CONFIG.filter((e) => groupOf(e) === group.id);
    if (!inGroup.length) continue;

    // The Settings banner sits between the START-HERE block and advanced keys.
    if (!group.safe && !bannerEmitted) { parts.push(BANNER, ""); bannerEmitted = true; }

    parts.push(`# ════════════════════════════════════════════════════════════`);
    parts.push(`#  ${group.title}`);
    parts.push(`# ════════════════════════════════════════════════════════════`);
    parts.push("");

    for (const section of SECTIONS) {
      const entries = inGroup.filter((e) => e.section === section.id);
      if (!entries.length) continue;
      parts.push(rule(section.title));
      parts.push(entries.map((e) => renderTemplateEntry(e, group.safe)).join("\n\n"));
      parts.push("");
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ── docs/config-reference.md ──────────────────────────────────────────────────
function renderReferenceEntry(e) {
  const meta = [
    e.type,
    e.tier === 0 ? "tier 0 (bootstrap — .env only)" : "tier 1 (Settings UI, restart to apply)",
    `default: ${e.default === "" || e.default == null ? "*(unset)*" : `\`${e.default}\``}`,
  ];
  if (e.options) meta.push(`options: \`${e.options.join(" | ")}\``);
  if (e.advanced) meta.push("advanced");
  const lines = [`#### \`${e.key}\``, "", meta.join(" · "), ""];
  if (e.help) lines.push(e.help, "");
  return lines.join("\n");
}

function buildReference() {
  const parts = [
    "# Aperio configuration reference",
    "",
    "<!-- AUTO-GENERATED from lib/config.js — do not edit by hand. Run `npm run gen:env`. -->",
    "",
    "Every variable Aperio reads, grouped as in the app. Most are managed in the",
    "app's **Settings** and saved to the database; all of them also work as lines",
    "in `.env`. By default a value saved in Settings wins (`APERIO_CONFIG_PRECEDENCE=db`);",
    "set `APERIO_CONFIG_PRECEDENCE=env` in `.env` to make every line written in the",
    "file win instead — however few lines it holds. Tier-0 keys are read before the",
    "database opens and therefore live in `.env` only.",
    "",
  ];

  for (const group of GROUPS) {
    const inGroup = CONFIG.filter((e) => groupOf(e) === group.id);
    if (!inGroup.length) continue;
    parts.push(`## ${group.title}`, "");
    if (group.blurb) parts.push(group.blurb, "");
    for (const section of SECTIONS) {
      const entries = inGroup.filter((e) => e.section === section.id);
      if (!entries.length) continue;
      parts.push(`### ${section.title}`, "");
      if (section.blurb) parts.push(section.blurb, "");
      parts.push(entries.map(renderReferenceEntry).join("\n"));
    }
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

// ── entry point ───────────────────────────────────────────────────────────────
const outputs = [
  { path: OUT_ENV, name: ".env.example", content: buildTemplate() },
  { path: OUT_REF, name: "config-reference.md", content: buildReference() },
];
const selectedOutputs = process.argv.includes("--env-only") ? outputs.slice(0, 1) : outputs;

if (process.argv.includes("--check")) {
  let stale = false;
  for (const o of selectedOutputs) {
    let current = "";
    try { current = readFileSync(o.path, "utf8"); } catch { /* missing → out of date */ }
    if (current !== o.content) { console.error(`✗ ${o.name} is out of date. Run \`npm run gen:env\`.`); stale = true; }
  }
  if (stale) process.exit(1);
  console.log("✓ .env.example and config-reference.md are up to date.");
} else {
  for (const o of selectedOutputs) writeFileSync(o.path, o.content);
  if (selectedOutputs.length === 1) {
    console.log(`✓ Wrote .env.example (${CONFIG.length} variables).`);
  } else {
    console.log(`✓ Wrote .env.example and ${REF_LINK} (${CONFIG.length} variables each).`);
  }
}
