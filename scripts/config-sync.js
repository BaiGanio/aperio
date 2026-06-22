// scripts/config-sync.js
//
// Phase 2b — on-demand .env ↔ registry reconciliation report (issue #167).
//
//   npm run config:sync                 → print Managed / Unmanaged / Orphaned
//   npm run config:sync -- --scaffold    → also write config.scaffold.js with
//                                          ready-to-paste registry stubs for the
//                                          unmanaged vars
//
// Read-only by design: it NEVER writes .env and NEVER mutates lib/config.js.
// `--scaffold` only writes a throwaway draft (config.scaffold.js) for a dev to
// curate and paste in.

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { parseEnvFile, classify, inferType, ENV_PATH } from "../lib/config-sync.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Draft lands in var/ — already gitignored, so no extra ignore rule needed.
const SCAFFOLD_OUT = resolve(__dirname, "..", "var", "config.scaffold.js");

// Orphan detection needs the DB. Degrade gracefully if it can't open.
async function dbSettingKeys() {
  try {
    const { getStore } = await import("../db/index.js");
    const store = await getStore();
    const settings = await store.getSettings();
    await store.close?.();
    return Object.keys(settings);
  } catch (err) {
    console.warn(`! Could not read the database for orphan detection (${err.message}). Skipping orphaned check.`);
    return [];
  }
}

function scaffoldFor(unmanaged, envVars) {
  const entries = unmanaged.map((key) => {
    const type = inferType(key, envVars[key]);
    return [
      `  { key: ${JSON.stringify(key)}, section: "imported", type: ${JSON.stringify(type)}, tier: 1, show: "commented",`,
      `    default: "", help: "TODO: describe ${key}, then move it into the right section." },`,
    ].join("\n");
  });
  return [
    "// config.scaffold.js — AUTO-GENERATED draft (npm run config:sync -- --scaffold).",
    "// These are UNMANAGED vars found in your .env. Review each, fix its",
    "// section/type/help, then paste it into the CONFIG array in lib/config.js and",
    "// delete this file. Nothing reads this file — it's a clipboard, not a source.",
    "",
    "export const SCAFFOLD = [",
    ...entries,
    "];",
    "",
  ].join("\n");
}

async function main() {
  const scaffold = process.argv.includes("--scaffold");
  const envVars = parseEnvFile();
  const { managed, unmanaged, orphaned } = classify(envVars, await dbSettingKeys());

  console.log(`\nConfig sync — ${ENV_PATH}\n`);
  console.log(`Managed   : ${managed.length} var(s) in .env have a registry control.`);

  if (unmanaged.length) {
    console.log(`\nUnmanaged : ${unmanaged.length} var(s) in .env with NO registry entry`);
    console.log(`            (shown in the Config panel under "Unmanaged / Imported"):`);
    for (const k of unmanaged) console.log(`   • ${k.padEnd(34)} → ${inferType(k, envVars[k])}`);
  } else {
    console.log(`Unmanaged : none — every .env var has a registry control.`);
  }

  if (orphaned.length) {
    console.log(`\nOrphaned  : ${orphaned.length} DB config value(s) whose key is gone from both`);
    console.log(`            the registry and .env (still injected at boot — consider deleting):`);
    for (const k of orphaned) console.log(`   • config.${k}`);
  } else {
    console.log(`Orphaned  : none.`);
  }

  if (scaffold) {
    if (!unmanaged.length) {
      console.log(`\nNothing to scaffold — no unmanaged vars.`);
    } else {
      mkdirSync(dirname(SCAFFOLD_OUT), { recursive: true });
      writeFileSync(SCAFFOLD_OUT, scaffoldFor(unmanaged, envVars));
      console.log(`\n✓ Wrote ${SCAFFOLD_OUT} (${unmanaged.length} draft stub(s)). Review, then paste into lib/config.js.`);
    }
  } else if (unmanaged.length) {
    console.log(`\nTip: run \`npm run config:sync -- --scaffold\` to draft registry stubs for the unmanaged vars.`);
  }
  console.log("");
}

main();
