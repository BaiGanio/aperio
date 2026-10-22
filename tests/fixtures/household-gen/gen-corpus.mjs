// Writes the generated household documents.
//
//   node tests/fixtures/household-gen/gen-corpus.mjs [--dry-run] [--force]
//
// Safety rules, in order of importance:
//   1. `frozen` artifacts are never written. They are hand-authored documents the
//      oracle only describes.
//   2. A generated path that already exists but is absent from the manifest of a
//      previous run aborts the whole run. That is the guard against silently
//      overwriting a document somebody wrote by hand. `--force` overrides it.
//   3. Nothing outside the declared artifact set is ever touched — no cleaning,
//      no pruning, no deleting.
//
// The manifest lives beside this script, NOT in the corpus: the corpus is a
// model-readable location and must not carry generator bookkeeping.

import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildCorpus } from "./build.mjs";

const HOUSEHOLD = process.env.HOUSEHOLD_ROOT ?? "/Users/lk/Projects/household";
const MANIFEST = resolve(import.meta.dirname, "generated-manifest.json");

const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function readManifest() {
  try {
    return new Set(JSON.parse(await readFile(MANIFEST, "utf8")).files);
  } catch {
    return new Set();
  }
}

const { artifacts, events, periods } = buildCorpus();
const known = await readManifest();
const generated = artifacts.filter(artifact => artifact.write && !artifact.frozen);
const declared = artifacts.filter(artifact => !artifact.write || artifact.frozen);

// Guard 2: refuse to clobber anything we did not write ourselves.
const collisions = [];
for (const artifact of generated) {
  const target = join(HOUSEHOLD, artifact.relPath);
  if (await exists(target) && !known.has(artifact.relPath)) collisions.push(artifact.relPath);
}
if (collisions.length && !force) {
  console.error("refusing to overwrite files this generator did not create:");
  for (const path of collisions) console.error(`  ${path}`);
  console.error("\nrun with --force only if you are certain these are generated documents.");
  process.exit(2);
}

// Guard 1: every frozen artifact must actually be there — a missing one means the
// oracle is describing a document that no longer exists.
const missingFrozen = [];
for (const artifact of declared) {
  if (!await exists(join(HOUSEHOLD, artifact.relPath))) missingFrozen.push(artifact.relPath);
}

let written = 0;
const byFormat = {};
for (const artifact of generated) {
  const target = join(HOUSEHOLD, artifact.relPath);
  const body = await artifact.write();
  byFormat[artifact.format] = (byFormat[artifact.format] ?? 0) + 1;
  if (dryRun) continue;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof body === "string" ? body : body);
  written += 1;
}

if (!dryRun) {
  await writeFile(MANIFEST, `${JSON.stringify({
    files: generated.map(artifact => artifact.relPath).sort(),
  }, null, 2)}\n`);
}

const totals = Object.entries(periods)
  .map(([period, data]) => `  ${period}  BGN ${(data.monthlyTotal / 100).toFixed(2).padStart(9)}  ${Object.entries(data.otherCurrency).map(([currency, amount]) => `${currency} ${(amount / 100).toFixed(2)}`).join("  ")}`)
  .join("\n");

console.log(`${dryRun ? "would write" : "wrote"} ${dryRun ? generated.length : written} documents to ${HOUSEHOLD}`);
console.log(`formats: ${Object.entries(byFormat).map(([format, count]) => `${format} ${count}`).join(", ")}`);
console.log(`declared-but-not-written (frozen/hand-authored): ${declared.length}`);
if (missingFrozen.length) {
  console.log(`\nWARNING — declared documents missing from disk (${missingFrozen.length}):`);
  for (const path of missingFrozen) console.log(`  ${path}`);
}
console.log(`\nevents: ${events.length}\nper-period totals:\n${totals}`);
