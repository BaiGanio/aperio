// tests/e2e/real-app-codegraph.test.js
//
// Group H: code graph smoke test (plan e2e-coverage-expansion, Step WS-H).
// Indexes a small real subdirectory (tests/e2e/helpers — a handful of JS
// files) rather than the whole repo, to keep indexing fast and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startRealApp, request } from "../helpers/real-app-helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const INDEX_TARGET = resolve(REPO_ROOT, "tests/e2e/helpers");

async function waitForIndexReady(fixture, targetPath, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const statusRes = await request(fixture, "/api/codegraph/status");
    const root = statusRes.json.roots?.find(r => r.path === targetPath);
    if (root?.phase === "ready") return root;
    if (root?.phase === "error") throw new Error(`Indexing failed: ${root.error}`);
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Indexing did not complete within ${timeoutMs}ms`);
}

test("Code graph smoke tests", async (t) => {
  const scratchRoot = mkdtempSync(join(tmpdir(), "aperio-codegraph-"));
  const dbPath = join(scratchRoot, "aperio-test.db");

  const fixture = await startRealApp(t, {
    readyTimeout: 25_000,
    env: {
      APERIO_E2E_SKIP_BOOT: "0",
      APERIO_E2E_INJECT_AGENT: "1",
      DB_BACKEND: "sqlite",
      SQLITE_PATH: dbPath,
      AI_PROVIDER: "stub",
      EMBEDDING_PROVIDER: "none",
      APERIO_CODEGRAPH: "on",
      APERIO_DOCGRAPH: "off",
      IDLE_SHUTDOWN: "off",
      APERIO_CONFIG_PRECEDENCE: "env",
      // Folder indexing requires the target under the read allowlist —
      // the fixture's own runtimeRoot floor doesn't cover the repo tree.
      APERIO_ALLOWED_PATHS_TO_READ: INDEX_TARGET,
    },
  });

  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(scratchRoot, { recursive: true, force: true }); } catch {}
  });

  let resolvedTargetPath;

  await t.test("H1: index a small directory", async () => {
    const indexRes = await request(fixture, "/api/codegraph/index", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ path: INDEX_TARGET, target: "code" }),
    });
    assert.equal(indexRes.status, 202, "Index request accepted");
    resolvedTargetPath = indexRes.json.path;
    assert.ok(resolvedTargetPath, "Response echoes the resolved (realpath'd) target path");

    const root = await waitForIndexReady(fixture, resolvedTargetPath, 20_000);
    assert.equal(root.phase, "ready", "Indexing completes");
    assert.ok(root.files > 0, "At least one file indexed");
    assert.ok(root.symbols > 0, "At least one symbol indexed");
  });

  await t.test("H2: repos endpoint lists the indexed repo", async () => {
    const reposRes = await request(fixture, "/api/codegraph/repos");
    assert.equal(reposRes.status, 200, "Repos request succeeds");
    assert.equal(reposRes.json.enabled, true, "Codegraph reports enabled (SQLite backend present)");
    const repo = reposRes.json.repos.find(r => r.root_path === resolvedTargetPath || r.path === resolvedTargetPath);
    assert.ok(repo, `Indexed repo ${resolvedTargetPath} appears in repos list`);
  });

  await t.test("H3: search finds known symbols", async () => {
    const searchRes = await request(fixture, "/api/codegraph/search?q=startRealApp");
    assert.equal(searchRes.status, 200, "Search succeeds");
    // Backend returns { matches, mode } — codegraph/backends/sqlite.js's search().
    // Each match's `path` is repo-relative (not absolute), per that module's
    // own comment on ambiguity across repos.
    const match = searchRes.json.matches?.find(r => r.name === "startRealApp");
    assert.ok(match, `Search finds startRealApp among: ${JSON.stringify(searchRes.json.matches?.map(r => r.name))}`);
    assert.match(match.path ?? "", /real-app-helper\.js$/, "Match points at real-app-helper.js");

    // Edge: search for a non-existent symbol → empty results, not an error
    const emptyRes = await request(fixture, "/api/codegraph/search?q=totallyMadeUpSymbolXyz123");
    assert.equal(emptyRes.status, 200, "Search for unknown symbol still succeeds");
    assert.equal(emptyRes.json.matches?.length ?? 0, 0, "No matches for an unknown symbol");
  });

  await t.test("H4: outline returns symbols for a known file", async () => {
    // outline()'s f.path column is repo-relative, not absolute (see H3 note).
    const relativePath = "real-app-helper.js";
    const outlineRes = await request(fixture, `/api/codegraph/outline?path=${encodeURIComponent(relativePath)}`);
    assert.equal(outlineRes.status, 200, "Outline request succeeds");
    const names = (outlineRes.json.symbols ?? []).map(s => s.name);
    assert.ok(names.includes("startRealApp"), `Outline includes startRealApp: ${JSON.stringify(names)}`);
    assert.ok(names.includes("request"), `Outline includes request: ${JSON.stringify(names)}`);
    assert.ok(names.includes("createChildStop"), `Outline includes createChildStop: ${JSON.stringify(names)}`);

    // Edge: outline for a non-existent file → empty symbols, not an error
    const missingRes = await request(fixture, `/api/codegraph/outline?path=${encodeURIComponent("does-not-exist.js")}`);
    assert.equal(missingRes.status, 200, "Missing file handled without a 500");
    assert.equal((missingRes.json.symbols ?? []).length, 0, "No symbols for a non-existent file");
  });
});
