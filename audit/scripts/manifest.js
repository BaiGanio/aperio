// audit/scripts/manifest.js
//
// T4 — A14 (database parity and encryption) evidence-packet manifest, the
// reference implementation for the continuous-audit program's packet
// builders (aperio-continuous-audit.md Step 4, aperio-continuous-audit-tests.md
// T4.4). Build A14 first and validate hash/exclusion behavior against it
// before creating 22 hand-maintained file lists for the other slices.
//
// Deliberately hand-lists included/excluded paths rather than deriving them
// via import-graph analysis — that generic builder is future work for the
// other 21 slices, once this reference packet's hash/ceiling/exclusion
// behavior is proven.

import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const TOKEN_CEILING = 30_000;

// Each file is tagged with the lifecycle/trust bucket it belongs to. The full
// A14 packet (db/sqlite/store.js + db/postgres/store.js alone run ~29K tokens
// combined) exceeds the 30K ceiling, so buildA14Manifest() below splits it
// into these deterministic sub-slices — Step 4's "split oversized packets by
// lifecycle or trust boundary" — instead of proposing a split ad hoc per run.
export const A14_INCLUDED = [
  { path: "db/index.js", bucket: "shared", reason: "backend resolution factory — the seam A14's invariant is about" },
  { path: "db/tables.js", bucket: "shared", reason: "shared table/schema constants both adapters read" },
  { path: "db/types.js", bucket: "shared", reason: "shared domain type constants both adapters read" },
  { path: "db/encrypt.js", bucket: "shared", reason: "AES-256-GCM encrypt-at-rest + OS keychain key handling" },
  { path: "db/migrate.js", bucket: "migrations", reason: "postgres migration runner" },
  { path: "db/migrate-sqlite.js", bucket: "migrations", reason: "sqlite migration runner" },
  { path: "db/sqlite.js", bucket: "sqlite", reason: "sqlite adapter barrel" },
  { path: "db/sqlite/store.js", bucket: "sqlite", reason: "sqlite adapter implementation" },
  { path: "db/sqlite/encryption.js", bucket: "sqlite", reason: "sqlite encrypt-at-rest implementation" },
  { path: "db/sqlite/mappers.js", bucket: "sqlite", reason: "sqlite row<->domain mapping" },
  { path: "db/sqlite/search.js", bucket: "sqlite", reason: "sqlite FTS5/vector search implementation" },
  { path: "db/sqlite/wiki.js", bucket: "sqlite", reason: "sqlite wiki-table implementation" },
  { path: "db/postgres.js", bucket: "postgres", reason: "postgres adapter barrel" },
  { path: "db/postgres/store.js", bucket: "postgres", reason: "postgres adapter implementation" },
  { path: "db/postgres/mappers.js", bucket: "postgres", reason: "postgres row<->domain mapping" },
  { path: "db/postgres/search.js", bucket: "postgres", reason: "postgres tsvector/pgvector search implementation" },
];

// Coupled files A14 deliberately does NOT pull in, and why — T4.1/T4.4's
// "every excluded but coupled file is visible in the manifest" requirement.
export const A14_EXCLUDED = [
  { path: "db/memory-seed.js", reason: "seed data content, not adapter/migration contract surface" },
  { path: "db/memory-seed-lite.js", reason: "seed data content, not adapter/migration contract surface" },
  { path: "db/wiki-seed.js", reason: "seed data content, not adapter/migration contract surface" },
  { path: "db/self-memory-seed.js", reason: "seed data content, not adapter/migration contract surface" },
  { path: "db/agent-job-seed.js", reason: "seed data content, not adapter/migration contract surface" },
  { path: "lib/config.js", reason: "coupled only via DB_BACKEND/APERIO_DB_ENCRYPT keys; the full " +
    "config registry belongs to A02, not A14" },
];

function hashContent(content) {
  return {
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
    tokens: encode(content).length,
  };
}

export function hashFile(relPath) {
  const abs = `${ROOT}/${relPath}`;
  if (!existsSync(abs)) return null;
  return { path: relPath, ...hashContent(readFileSync(abs, "utf8")) };
}

function revisionInfo(files) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirtyPaths = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const dirty = files.some((f) => dirtyPaths.includes(f.path));
  return { commit, dirty, dirtySensitivePaths: files.filter((f) => dirtyPaths.includes(f.path)).map((f) => f.path) };
}

function migrationFiles(dir) {
  try {
    return execFileSync("git", ["ls-files", dir], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }
}

function discoverCompanionTests() {
  const domainPattern = /(^|[\\/])(db|sqlite|postgres|migrat|encrypt)/i;
  let files;
  try {
    files = execFileSync("git", ["ls-files", "tests"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
  return files.filter((f) => f.endsWith(".test.js") && domainPattern.test(f)).sort();
}

// Pure function of an already-hashed file list, so T4.3 (manifest hash drives
// delta selection) can be proven against synthetic input without touching the
// real filesystem — an unrelated file's hash change never enters this list
// for A14 in the first place (A14_INCLUDED doesn't name it), and a change to
// one that IS included flips this hash.
export function computeManifestHash(files) {
  return createHash("sha256")
    .update(files.map((f) => `${f.path}:${f.sha256}`).sort().join("\n"))
    .digest("hex");
}

function buildSubSlice(id, files, tokenCeiling) {
  const estimatedTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  return {
    id,
    files,
    estimatedTokens,
    tokenCeiling,
    withinCeiling: estimatedTokens <= tokenCeiling,
    manifestHash: computeManifestHash(files),
  };
}

export function buildA14Manifest({ tokenCeiling = TOKEN_CEILING } = {}) {
  const included = A14_INCLUDED
    .map(({ path, bucket, reason }) => ({ ...hashFile(path), bucket, reason }))
    .filter((f) => f.sha256);
  const migrationsPostgres = migrationFiles("db/migrations")
    .map((path) => ({ ...hashFile(path), bucket: "migrations", reason: "postgres migration" }));
  const migrationsSqlite = migrationFiles("db/migrations-sqlite")
    .map((path) => ({ ...hashFile(path), bucket: "migrations", reason: "sqlite migration" }));
  const companionTests = discoverCompanionTests();

  const allFiles = [...included, ...migrationsPostgres, ...migrationsSqlite];
  const byBucket = { shared: [], migrations: [...migrationsPostgres, ...migrationsSqlite], sqlite: [], postgres: [] };
  for (const f of included) byBucket[f.bucket].push(f);

  const subSlices = Object.entries(byBucket).map(([bucket, files]) => buildSubSlice(`A14-${bucket}`, files, tokenCeiling));
  const estimatedTokens = allFiles.reduce((sum, f) => sum + f.tokens, 0);

  return {
    slice: "A14",
    ...revisionInfo(allFiles),
    included,
    excluded: A14_EXCLUDED,
    migrations: { postgres: migrationsPostgres, sqlite: migrationsSqlite },
    companionTests,
    subSlices,
    allSubSlicesWithinCeiling: subSlices.every((s) => s.withinCeiling),
    estimatedTokens,
    tokenCeiling,
    withinCeiling: estimatedTokens <= tokenCeiling,
    manifestHash: computeManifestHash(allFiles),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(buildA14Manifest(), null, 2));
}
