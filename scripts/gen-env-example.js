// scripts/gen-env-example.js
//
// Regenerates the two configuration artifacts from the registry in
// lib/config.js, so neither can drift from what the code actually reads:
//
//   .env.example              slim template — only `envTemplate` keys: the
//                             START-HERE provider block plus the tier-0
//                             bootstrap/security keys that must live in .env.
//   docs/config-reference.md  the complete annotated list of every variable,
//                             readable on GitHub. Any of them still works in
//                             a hand-written .env (see APERIO_CONFIG_PRECEDENCE).
//
//   node scripts/gen-env-example.js                 → write both files
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

const HEADER = `# ============================================================
# Aperio — configuration bootstrap
# AUTO-GENERATED from lib/config.js — run \`npm run gen:env\` to regenerate;
# edit the registry, not this file. NEVER commit a real .env to git.
#
# Only what belongs in .env lives here: the START-HERE provider block and
# the bootstrap/security keys read before the database opens. Everything
# else is set in the app's Settings — full reference: ${REF_LINK}
# Copy to \`.env\` and edit — or just run \`npm start\` and take it from there.
# ============================================================`;

const BANNER = `# ╶───────────────────────────────────────────────────────────╴
#  Everything else is configured in the app's Settings (saved to the
#  database). Any variable from ${REF_LINK} still works
#  here — set APERIO_CONFIG_PRECEDENCE=env to make this file win.
# ╶───────────────────────────────────────────────────────────╴
# APERIO_CONFIG_PRECEDENCE=env`;

const rule = (title) => {
  const line = "─".repeat(Math.max(0, 58 - title.length));
  return `# ── ${title} ${line}`;
};

const commentBlock = (text) => text.split("\n").map((l) => `# ${l}`.trimEnd()).join("\n");

const sectionGroup = Object.fromEntries(SECTIONS.map((s) => [s.id, s.group]));
const groupOf = (e) => sectionGroup[e.section];

// ── slim .env.example ─────────────────────────────────────────────────────────
// START-HERE entries get a one-line help; core entries are bare assignments —
// their full annotations live in the reference page the banner points to.
function renderTemplateEntry(e, { withHelp }) {
  const out = [];
  if (withHelp && e.help) out.push(`# ${e.help.split("\n")[0]}`);
  if (withHelp && e.type === "select" && e.options) out.push(`# options: ${e.options.join(" | ")}`);
  const value = e.example !== undefined ? e.example : e.default;
  const assign = `${e.key}=${value}`;
  out.push(e.show === "set" ? assign : `# ${assign}`);
  return out.join("\n");
}

function buildTemplate() {
  const parts = [HEADER, ""];
  const inTemplate = CONFIG.filter((e) => e.envTemplate && e.key !== "APERIO_CONFIG_PRECEDENCE");
  let bannerEmitted = false;

  for (const group of GROUPS) {
    const inGroup = inTemplate.filter((e) => groupOf(e) === group.id);
    if (!inGroup.length) continue;

    // The Settings banner (which carries the precedence line) sits between the
    // START-HERE block and the bootstrap keys.
    if (!group.safe && !bannerEmitted) { parts.push(BANNER, ""); bannerEmitted = true; }

    for (const section of SECTIONS) {
      const entries = inGroup.filter((e) => e.section === section.id);
      if (!entries.length) continue;
      parts.push(rule(section.title));
      parts.push(entries.map((e) => renderTemplateEntry(e, { withHelp: group.safe })).join("\n"));
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

if (process.argv.includes("--check")) {
  let stale = false;
  for (const o of outputs) {
    let current = "";
    try { current = readFileSync(o.path, "utf8"); } catch { /* missing → out of date */ }
    if (current !== o.content) { console.error(`✗ ${o.name} is out of date. Run \`npm run gen:env\`.`); stale = true; }
  }
  if (stale) process.exit(1);
  console.log("✓ .env.example and config-reference.md are up to date.");
} else {
  for (const o of outputs) writeFileSync(o.path, o.content);
  const n = CONFIG.filter((e) => e.envTemplate).length;
  console.log(`✓ Wrote .env.example (${n} bootstrap/start keys) and ${REF_LINK} (${CONFIG.length} variables).`);
}
