// audit/scripts/contracts/memory.js
// A13 Memory, wiki, and embeddings contract gate — deterministic checks.
// Verifies:
//   1. Memory handlers, seed data, and wiki files exist
//   2. Embedding pipeline modules exist
//   3. Memory compaction and token counting exist
//   4. Companion tests exist

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

function checkMemoryFiles(rootDir) {
  const results = [];

  const files = [
    ["db/memory-seed.js", "Memory seed data"],
    ["db/self-memory-seed.js", "Self-memory seed data"],
    ["db/wiki-seed.js", "Wiki seed data"],
    ["db/sqlite/wiki.js", "SQLite wiki implementation"],
    ["db/memory-seed-lite.js", "Memory seed data (lite)"],
    ["lib/handlers/memory/memoryHandlers.js", "Memory CRUD handlers"],
    ["lib/handlers/memory/selfMemoryHandlers.js", "Self-memory handlers"],
    ["lib/helpers/embeddings.js", "Embedding generation"],
    ["lib/helpers/embedding-queue.js", "Embedding queue"],
    ["lib/helpers/embedding-backlog.js", "Embedding backlog"],
    ["lib/helpers/embedding-worker.js", "Embedding worker"],
    ["lib/helpers/embedding-worker-client.js", "Embedding worker client"],
    ["lib/memory/compactionBaseline.js", "Memory compaction baseline"],
    ["lib/memory/tokenCount.js", "Memory token counting"],
  ];

  for (const [relPath, label] of files) {
    const full = join(rootDir, relPath);
    results.push({
      invariant: `${label} (${relPath}) exists`,
      passed: existsSync(full),
      detail: existsSync(full) ? "Present" : "MISSING",
    });
  }

  return { results, passed: results.every(r => r.passed) };
}

function checkMemoryTests(rootDir) {
  const results = [];

  const testFiles = [
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
  ];

  let missing = 0;
  for (const t of testFiles) {
    const full = join(rootDir, t);
    const exists = existsSync(full);
    if (!exists) missing++;
    results.push({
      invariant: `Test file ${t} exists`,
      passed: exists,
      detail: exists ? "Present" : "MISSING",
    });
  }

  return { results, passed: missing === 0 };
}

function runMemoryContractGate(rootDir) {
  rootDir = resolve(rootDir || process.cwd());
  const gate = {
    $schema: "aperio-audit-memory-contract-v1",
    slice_id: "A13",
    checks: {
      memory_files: checkMemoryFiles(rootDir),
      memory_tests: checkMemoryTests(rootDir),
    },
    passed: false,
  };
  gate.passed = gate.checks.memory_files.passed && gate.checks.memory_tests.passed;
  return gate;
}

const rootArg = process.argv[2];
const gate = runMemoryContractGate(rootArg);
process.stdout.write(JSON.stringify(gate, null, 2) + "\n");
process.exit(gate.passed ? 0 : 1);

export { runMemoryContractGate };
