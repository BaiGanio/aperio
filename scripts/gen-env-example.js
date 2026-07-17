// scripts/gen-env-example.js
//
// Regenerates the two configuration artifacts from the registry in
// lib/config.js, so neither can drift from what the code actually reads:
//
//   .env.example              slim bootstrap template containing only the
//                             registry entries marked `envTemplate`.
//   docs/config-reference.md  the complete annotated list of every variable,
//                             readable on GitHub. Any of them still works in
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
# This slim template contains the ${CONFIG.filter((e) => e.envTemplate).length} START-HERE/bootstrap keys.
# The complete ${CONFIG.length}-variable inventory and help is in ${REF_LINK}.
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

// ── slim .env.example ─────────────────────────────────────────────────────────
// Only explicitly selected bootstrap/START-HERE entries belong in this file.
// The complete inventory and explanations live in config-reference.md.
function renderTemplateEntry(e, { withHelp, active = false }) {
  const out = [];
  if (withHelp && e.help) out.push(commentBlock(e.help));
  if (withHelp && e.type === "select" && e.options) out.push(`# options: ${e.options.join(" | ")}`);
  const value = e.example !== undefined ? e.example : e.default;
  const assign = `${e.key}=${value}`;
  out.push(active && e.show === "set" ? assign : `# ${assign}`);
  return out.join("\n");
}

function buildTemplate() {
  const parts = [HEADER, ""];
  const inTemplate = CONFIG.filter((e) => e.envTemplate);
  let bannerEmitted = false;

  for (const group of GROUPS) {
    const inGroup = inTemplate.filter((e) => groupOf(e) === group.id);
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
      parts.push(entries.map((e) => renderTemplateEntry(e, {
        withHelp: false,
        active: group.id === "start" && section.id === "essentials",
      })).join("\n"));
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
  if (e.envTemplate) meta.push("in `.env.example`");
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
  const n = CONFIG.filter((e) => e.envTemplate).length;
  if (selectedOutputs.length === 1) {
    console.log(`✓ Wrote .env.example (${CONFIG.length} variables; ${n} bootstrap/start keys).`);
  } else {
    console.log(`✓ Wrote .env.example (${n} bootstrap/start keys) and ${REF_LINK} (${CONFIG.length} variables).`);
  }
}
