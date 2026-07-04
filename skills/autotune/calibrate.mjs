#!/usr/bin/env node
// Semantic-rescue floor calibrator — the read-only ground truth for the
// APERIO_SKILL_SEMANTIC tier (sibling of score.mjs, which calibrates the
// deterministic keyword tier).
//
// It reproduces production exactly: the semantic tier fires ONLY when the real
// matchSkills() returns nothing (null-only trigger), then accepts the nearest
// skill embedding if its cosine similarity clears the floor. It sweeps the floor
// and reports, per step: train/holdout accuracy, paraphrases rescued, and
// negatives that would wrongly fire — so you can pick a floor from data.
//
// Usage (transformers is local; voyage needs a key):
//   node skills/autotune/calibrate.mjs
//   EMBEDDING_PROVIDER=voyage VOYAGE_API_KEY=… node skills/autotune/calibrate.mjs
//
// Ground truth (do not tune toward it): eval.json, eval.holdout.json,
// eval.negatives.json. Set the winning floor as APERIO_SKILL_SEMANTIC_FLOOR (or
// update PROVIDER_FLOORS in lib/workers/skills.js for a new provider default).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { loadSkillIndex, matchSkills } from "../../lib/workers/skills.js";
import { generateEmbedding } from "../../lib/helpers/embeddings.js";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const provider = (process.env.EMBEDDING_PROVIDER || "transformers").toLowerCase();

const readJson = p => JSON.parse(readFileSync(p, "utf-8"));
const index = loadSkillIndex(join(repoRoot, "skills")).filter(s => s.load !== "never");

const cosine = (a, b) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
};

process.stderr.write(`[calibrate] provider=${provider}  embedding ${index.length} skills…\n`);
const skillVecs = [];
for (const s of index) {
  const v = await generateEmbedding(`${s.description ?? ""} ${s.keywords ?? ""}`.trim(), "document");
  if (!Array.isArray(v) || !v.length) { console.error(`\n✗ embedder returned nothing (provider=${provider}). For voyage, set VOYAGE_API_KEY.`); process.exit(1); }
  skillVecs.push({ name: s.name, v });
}
const embedTop = async (prompt) => {
  const q = await generateEmbedding(prompt, "query");
  let name = null, sim = -1;
  for (const s of skillVecs) { const c = cosine(q, s.v); if (c > sim) { sim = c; name = s.name; } }
  return { name, sim };
};

const cases = [
  ...readJson(join(here, "eval.json")).cases.map(c => ({ ...c, split: "train" })),
  ...readJson(join(here, "eval.holdout.json")).cases.map(c => ({ ...c, split: "holdout" })),
].filter(c => c.expect); // floor calibration is about rescuing positives
const negatives = readJson(join(here, "eval.negatives.json")).negatives;

process.stderr.write(`[calibrate] scoring ${cases.length} positives + ${negatives.length} negatives…\n`);
// Precompute the production trigger (lexical empty?) and the embedding neighbour.
const rows = [];
for (const c of cases) {
  const lexEmpty = matchSkills(c.prompt, index, { limit: 3 }).length === 0;
  const em = await embedTop(c.prompt);
  rows.push({ ...c, lexEmpty, em });
}
const negRows = [];
for (const p of negatives) {
  const lexEmpty = matchSkills(p, index, { limit: 3 }).length === 0;
  negRows.push({ p, lexEmpty, em: await embedTop(p) });
}

// null-only trigger: pick = lexical top; if lexical empty, embedding top if ≥ floor.
const lexTop = prompt => (matchSkills(prompt, index, { limit: 1 })[0]?.name) ?? null;
function accAt(floor, split) {
  const r = rows.filter(x => x.split === split);
  let ok = 0;
  for (const x of r) {
    const pick = x.lexEmpty ? (x.em.sim >= floor ? x.em.name : null) : lexTop(x.prompt);
    if (pick === x.expect) ok++;
  }
  return r.length ? ok / r.length : 0;
}

const base = s => accAt(1, s); // floor 1 ⇒ semantic never fires ⇒ lexical baseline
console.log(`\nprovider: ${provider}`);
console.log(`baseline (keyword-only): train ${base("train").toFixed(4)}   holdout ${base("holdout").toFixed(4)}\n`);
console.log(["floor", "train", "holdout", "rescued", "neg_fire"].map(s => s.padEnd(10)).join(""));
let best = null;
for (let f = 0.30; f <= 0.72 + 1e-9; f += 0.02) {
  const floor = +f.toFixed(2);
  const train = accAt(floor, "train"), holdout = accAt(floor, "holdout");
  const rescued = rows.filter(x => x.lexEmpty && x.em.sim >= floor && x.em.name === x.expect).length;
  const negFire = negRows.filter(x => x.lexEmpty && x.em.sim >= floor).length;
  console.log([floor.toFixed(2), train.toFixed(4), holdout.toFixed(4), `${rescued}`, `${negFire}/${negRows.length}`].map(s => String(s).padEnd(10)).join(""));
  const score = train + holdout - negFire / negRows.length; // rescue value minus false-fire cost
  if (!best || score > best.score) best = { floor, train, holdout, negFire, score };
}
console.log(`\nsuggested floor ≈ ${best.floor}  (train ${best.train.toFixed(4)}, holdout ${best.holdout.toFixed(4)}, ${best.negFire}/${negRows.length} false-fire)`);
console.log(`→ set APERIO_SKILL_SEMANTIC_FLOOR=${best.floor} for provider "${provider}", or bake it into PROVIDER_FLOORS in lib/workers/skills.js`);
