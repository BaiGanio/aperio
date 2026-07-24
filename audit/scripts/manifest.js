// audit/scripts/manifest.js
// Evidence packet builder for Aperio Continuous Audit.
// Scans a bounded set of files, records content hashes, inclusion reasons,
// and excluded coupled files. Produces a manifest JSON that can be used to
// (a) estimate token usage before an LLM invocation and (b) detect whether
// evidence has changed since last run.
//
// Use: node audit/scripts/manifest.js <slice-id> [rootDir]

import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

function sha256(content) {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Slice definitions ──────────────────────────────────────────────────────

// Each slice defines:
//   include:  [path, reason][] — files that ARE evidence
//   coupled:  [path, reason][] — files related but excluded, reason recorded
//   excludes: glob or path patterns to skip during directory walks

const SLICE_DEFS = {
  A14: {
    name: "Database parity and encryption",
    invariant: "SQLite and Postgres adapters implement equivalent store operations; migrations are in parity; encryption has focused tests for both backends.",
    include: [
      ["db/index.js", "Store factory — backend resolution and fallback"],
      ["db/sqlite.js", "SQLite barrel export"],
      ["db/postgres.js", "Postgres barrel export"],
      ["db/sqlite/store.js", "SQLite store implementation (all operations)"],
      ["db/postgres/store.js", "Postgres store implementation (all operations)"],
      ["db/migrate.js", "Postgres migration runner"],
      ["db/migrate-sqlite.js", "SQLite migration runner"],
      ["db/tables.js", "Shared table whitelist"],
      ["db/types.js", "Shared type definitions and row deserialization"],
      ["db/encrypt.js", "AES-256-GCM encryption module"],
      ["db/sqlite/encryption.js", "SQLite-specific encryption helpers"],
      ["db/sqlite/search.js", "SQLite fulltext + semantic search"],
      ["db/postgres/search.js", "Postgres fulltext + semantic search"],
      ["db/sqlite/mappers.js", "SQLite row mapping helpers"],
      ["db/postgres/mappers.js", "Postgres row mapping helpers"],
      ["db/sqlite/wiki.js", "SQLite wiki implementation"],
    ],
    coupled: [
      ["db/memory-seed.js", "Seed data — not a contract concern; tested separately"],
      ["db/memory-seed-lite.js", "Seed data (lite variant)"],
      ["db/self-memory-seed.js", "Self-memory seed data"],
      ["db/wiki-seed.js", "Wiki seed data"],
      ["db/agent-job-seed.js", "Agent job seed data"],
      ["db/tables.js", "Already included above for whitelist"],
    ],
    // Test files that exercise these modules
    testFiles: [
      "tests/integration/db/contract/backends.js",
      "tests/integration/db/contract/memories.test.js",
      "tests/integration/db/contract/settings.test.js",
      "tests/integration/db/contract/wiki.test.js",
      "tests/integration/db/contract/self-memory.test.js",
      "tests/integration/db/contract/embeddings.js",
      "tests/integration/db/contract/agent-interrupts.test.js",
      "tests/integration/db/contract/agent-jobs.test.js",
      "tests/integration/db/contract/import-export.test.js",
      "tests/integration/db/contract/issue-triage.test.js",
      "tests/integration/db/encrypt.test.js",
      "tests/integration/db/index.test.js",
      "tests/integration/db/sqlite.test.js",
      "tests/unit/db/agent-interrupts.test.js",
    ],
  },
};

function resolveSlicePath(baseDir, relPath) {
  return resolve(baseDir, relPath);
}

async function buildManifest(sliceId, rootDir) {
  rootDir = resolve(rootDir || process.cwd());
  const def = SLICE_DEFS[sliceId];
  if (!def) {
    throw new Error(`Unknown slice: ${sliceId}. Available: ${Object.keys(SLICE_DEFS).join(", ")}`);
  }

  // Track all root-level migration directories for parity scanning
  const pgMigrationsDir = join(rootDir, "db", "migrations");
  const sqliteMigrationsDir = join(rootDir, "db", "migrations-sqlite");

  const entries = [];
  let totalBytes = 0;

  for (const [relPath, reason] of def.include) {
    const full = resolveSlicePath(rootDir, relPath);
    if (!existsSync(full)) {
      entries.push({
        path: relPath,
        reason,
        status: "missing",
        hash: null,
        bytes: 0,
      });
      continue;
    }
    const content = readFileSync(full, "utf-8");
    const hash = sha256(content);
    const bytes = Buffer.byteLength(content, "utf-8");
    totalBytes += bytes;
    entries.push({
      path: relPath,
      reason,
      status: "present",
      hash,
      bytes,
    });
  }

  // Add migration files dynamically
  for (const [dir, backend] of [[pgMigrationsDir, "postgres"], [sqliteMigrationsDir, "sqlite"]]) {
    if (existsSync(dir)) {
      const files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort();
      for (const f of files) {
        const relPath = `db/migrations${backend === "sqlite" ? "-sqlite" : ""}/${f}`;
        const full = join(dir, f);
        const content = readFileSync(full, "utf-8");
        const hash = sha256(content);
        const bytes = Buffer.byteLength(content, "utf-8");
        totalBytes += bytes;
        entries.push({
          path: relPath,
          reason: `Migration: ${f} (${backend})`,
          status: "present",
          hash,
          bytes,
        });
      }
    }
  }

  // Coupled exclusions
  const coupled = def.coupled.map(([path, reason]) => ({ path, reason }));

  // Test file statuses
  const testFiles = [];
  for (const t of def.testFiles) {
    const full = resolveSlicePath(rootDir, t);
    testFiles.push({
      path: t,
      status: existsSync(full) ? "present" : "missing",
    });
  }

  // Token estimate (~4 chars per token for code)
  const estimatedTokens = Math.ceil(totalBytes / 4);

  const manifest = {
    $schema: "aperio-audit-manifest-v1",
    slice_id: sliceId,
    slice_name: def.name,
    invariant: def.invariant,
    revised_at: rootDir,
    token_estimate: estimatedTokens,
    token_ceiling: 30000,
    exceeds_ceiling: estimatedTokens > 30000,
    entries,
    coupled_exclusions: coupled,
    test_files: testFiles,
    aggregate_hash: sha256(JSON.stringify(entries.map(e => `${e.path}:${e.hash}`).sort().join("|"))),
  };

  return manifest;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const sliceArg = process.argv[2];
const rootArg = process.argv[3];
if (!sliceArg) {
  console.error("Usage: node audit/scripts/manifest.js <slice-id> [rootDir]");
  console.error("Available slices: " + Object.keys(SLICE_DEFS).join(", "));
  process.exit(1);
}

buildManifest(sliceArg, rootArg)
  .then(m => {
    process.stdout.write(JSON.stringify(m, null, 2) + "\n");
  })
  .catch(err => {
    console.error("Manifest error:", err.message);
    process.exit(1);
  });

export { buildManifest, SLICE_DEFS };
