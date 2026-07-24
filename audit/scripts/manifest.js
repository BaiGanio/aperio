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
  A01: {
    name: "Bootstrap and shutdown",
    invariant: "Production entrypoint, first-run bootstrap, and graceful shutdown all exist; crash breaker protects against repeated fatal errors; tests cover startup and shutdown lifecycle.",
    include: [
      ["server.js", "Production entrypoint — global error guards, signal handling"],
      ["bootstrap.js", "First-run setup — llama.cpp download, config, engine install"],
      ["lib/server.js", "Composition root — createApp(), Express + WS + lifecycle"],
      ["lib/server/shutdown.js", "Graceful shutdown — workers, WS, HTTP, store, cleanup"],
      ["lib/load-env.js", ".env loader — boot-time environment loading"],
      ["lib/server/hydrateRuntime.js", "Runtime hydration — DB, config, embeddings init"],
      ["lib/helpers/crashBreaker.js", "Crash breaker — exits on repeated fatals"],
      ["lib/config-resolver.js", "Boot-time config resolution"],
    ],
    coupled: [
      ["lib/server/setupRoutes.js", "Route registration — lifecycle concern, tested under A03"],
      ["lib/server/ws.js", "WebSocket setup — covered under A04"],
      ["lib/agent/index.js", "Agent factory — boot dependency, covered under A05"],
    ],
    testFiles: [
      "tests/e2e/bootstrap/bootstrap.test.js",
      "tests/e2e/real-app/real-app-lifecycle.test.js",
      "tests/integration/server/server.test.js",
      "tests/unit/lib/server.shutdown.test.js",
    ],
  },
  A03: {
    name: "HTTP routes and security",
    invariant: "Every route is registered, guarded by auth/rate-limit/net-guard middleware, and has matching tests; path safety and security modules exist.",
    include: [
      ["lib/routes/api.js", "Route composition — mounts all domain sub-routers"],
      ["lib/routes/api-agents.js", "Agent API routes"],
      ["lib/routes/api-codegraph.js", "Codegraph API routes"],
      ["lib/routes/api-config.js", "Config API routes"],
      ["lib/routes/api-data.js", "Data API routes"],
      ["lib/routes/api-database.js", "Database API routes"],
      ["lib/routes/api-datasets.js", "Datasets API routes"],
      ["lib/routes/api-docgraph.js", "Docgraph API routes"],
      ["lib/routes/api-github-webhook.js", "GitHub webhook routes"],
      ["lib/routes/api-interrupts.js", "Interrupt API routes"],
      ["lib/routes/api-memories.js", "Memory API routes"],
      ["lib/routes/api-meta.js", "Meta API routes"],
      ["lib/routes/api-restart.js", "Restart API routes"],
      ["lib/routes/api-sessions.js", "Session API routes"],
      ["lib/routes/api-settings.js", "Settings API routes"],
      ["lib/routes/api-wiki.js", "Wiki API routes"],
      ["lib/routes/paths.js", "Path safety — read/write gate for all file ops"],
      ["lib/server/setupRoutes.js", "Route registration — wires everything to Express"],
      ["lib/helpers/rateLimit.js", "Rate limiting middleware"],
      ["lib/helpers/netGuard.js", "DNS rebinding / CSRF protection"],
      ["lib/security/agentPermissions.js", "Agent permission enforcement"],
      ["lib/security/interruptService.js", "Interrupt service"],
    ],
    coupled: [
      ["lib/server/ws.js", "WebSocket handler — audited under A04 separately"],
      ["lib/helpers/staticAuth.js", "Static file auth — internal to setupRoutes"],
    ],
    testFiles: [
      "tests/integration/routes/api-memories.test.js",
      "tests/integration/routes/api-sessions.test.js",
      "tests/integration/routes/api-settings.test.js",
      "tests/integration/routes/api-config.test.js",
      "tests/integration/routes/api-codegraph.test.js",
      "tests/integration/routes/api-docgraph.test.js",
      "tests/integration/routes/api-agents.test.js",
      "tests/integration/routes/api-interrupts.test.js",
      "tests/integration/routes/api-restart.test.js",
      "tests/unit/security/agentPermissions.test.js",
      "tests/unit/security/interruptService.test.js",
      "tests/integration/helpers/netGuard.test.js",
    ],
  },
  A13: {
    name: "Memory, wiki, and embeddings",
    invariant: "Memory, wiki, self-memory, and embedding modules exist for both backends; search modules are mirrored; handlers and tests are complete.",
    include: [
      ["db/memory-seed.js", "Memory seed data"],
      ["db/memory-seed-lite.js", "Memory seed data (lite variant)"],
      ["db/self-memory-seed.js", "Self-memory seed data"],
      ["db/wiki-seed.js", "Wiki seed data"],
      ["db/sqlite/wiki.js", "SQLite wiki implementation"],
      ["lib/handlers/memory/memoryHandlers.js", "Memory CRUD handlers"],
      ["lib/handlers/memory/selfMemoryHandlers.js", "Self-memory CRUD handlers"],
      ["lib/helpers/embeddings.js", "Embedding generation"],
      ["lib/helpers/embedding-queue.js", "Embedding queue manager"],
      ["lib/helpers/embedding-backlog.js", "Embedding backlog processing"],
      ["lib/helpers/embedding-worker.js", "Embedding worker process"],
      ["lib/helpers/embedding-worker-client.js", "Embedding worker client"],
      ["lib/memory/compactionBaseline.js", "Memory compaction baseline"],
      ["lib/memory/tokenCount.js", "Memory token counting"],
    ],
    coupled: [
      ["db/sqlite/search.js", "Search implementation — tested under A14 contract"],
      ["db/postgres/search.js", "Search implementation — tested under A14 contract"],
      ["db/sqlite/store.js", "Store operations — tested under A14 contract"],
      ["db/postgres/store.js", "Store operations — tested under A14 contract"],
    ],
    testFiles: [
      "tests/unit/tools/memory.test.js",
      "tests/unit/tools/self-memory.test.js",
      "tests/unit/tools/self-wiki.test.js",
      "tests/unit/wiki/wikiHandlers.test.js",
      "tests/unit/wiki/wikiQueries.test.js",
      "tests/unit/helpers/embeddings.test.js",
      "tests/unit/helpers/embedding-queue.test.js",
      "tests/unit/helpers/embedding-backlog.test.js",
      "tests/unit/helpers/embedding-worker-client.test.js",
      "tests/unit/db/memory-seed.test.js",
      "tests/integration/db/contract/memories.test.js",
      "tests/integration/db/contract/wiki.test.js",
      "tests/integration/db/contract/self-memory.test.js",
      "tests/integration/db/contract/embeddings.js",
      "tests/integration/db/self-wiki.test.js",
      "tests/unit/memory/compactionBaseline.test.js",
    ],
  },
  A02: {
    name: "Configuration and secrets",
    invariant: "Config precedence is DB > env > defaults; secrets never leak through Settings API; registry and generated env/docs stay in sync.",
    include: [
      ["lib/config.js", "Config registry — every user-facing config var"],
      ["lib/config-resolver.js", "Config resolver — DB > env > default resolution"],
      ["lib/config-sync.js", "Config sync — env/registry reconciliation"],
      ["lib/load-env.js", "Load .env into process.env at import time"],
      ["lib/routes/api-settings.js", "Settings CRUD API — secret write-only enforcement"],
      ["lib/routes/api-config.js", "Config API endpoint"],
      ["scripts/gen-env-example.js", ".env.example generator from config registry"],
    ],
    coupled: [
      [".env.example", "Generated file — verified separately by gen:env:check"],
      ["docs/config-reference.md", "Generated doc — verified separately by gen:env:check"],
      ["lib/pricing.js", "Provider pricing — not a config concern"],
    ],
    testFiles: [
      "tests/unit/lib/config-sync.test.js",
      "tests/integration/routes/api-settings.test.js",
      "tests/integration/routes/api-config.test.js",
    ],
  },
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
