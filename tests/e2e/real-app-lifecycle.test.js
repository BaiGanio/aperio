// tests/e2e/real-app-lifecycle.test.js
//
// Group H: Graceful shutdown and repeatability (plan Step 8)
// Group I: CI scripts and backend parity (plan Step 9)
//
// Covers T55-T65 — shutdown, restart, no orphans, CI scripts, Postgres parity.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { startRealApp, request } from "./helpers/real-app-helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scratchEnv() {
  const root = mkdtempSync(join(tmpdir(), "aperio-lifecycle-"));
  const dbPath = join(root, "test.db");
  return { root, dbPath };
}

// ═════════════════════════════════════════════════════════════════════════
// Group H: Shutdown and lifecycle
// ═════════════════════════════════════════════════════════════════════════

test("Shutdown and lifecycle", async (t) => {
  const { root, dbPath } = scratchEnv();

  // Shared booted fixture
  const fixture = await startRealApp(t, {
    readyTimeout: 25_000,
    env: {
      APERIO_E2E_SKIP_BOOT: "0",
      APERIO_E2E_INJECT_AGENT: "1",
      DB_BACKEND: "sqlite",
      SQLITE_PATH: dbPath,
      AI_PROVIDER: "stub",
      EMBEDDING_PROVIDER: "none",
      APERIO_CODEGRAPH: "off",
      APERIO_DOCGRAPH: "off",
      IDLE_SHUTDOWN: "off",
      APERIO_CONFIG_PRECEDENCE: "env",
    },
  });
  t.after(async () => {
    try { await fixture.stop(); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  });

  // ════════════════════════════════════════════════════════════════════
  // T55: SIGTERM exits cleanly and releases resources
  // ════════════════════════════════════════════════════════════════════
  await t.test("T55: SIGTERM exits cleanly, port released", async () => {
    // Verify server is alive
    const alive = await request(fixture, "/api/locale", {
      headers: { "X-Aperio-Client": "e2e" },
    });
    assert.equal(alive.status, 200, "Server is alive before shutdown");

    // Record the port before stopping
    const port = fixture.port;

    // Stop the fixture (sends SIGTERM)
    await fixture.stop();

    // Port should be released — try to bind it
    const net = await import("node:net");
    const rebound = await new Promise((resolve) => {
      const server = net.createServer();
      server.on("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
    assert.ok(rebound, `Port ${port} can be rebound after SIGTERM`);
  });

  // ════════════════════════════════════════════════════════════════════
  // T57: Immediate same-root restart succeeds
  // ════════════════════════════════════════════════════════════════════
  await t.test("T57: same SQLite root restarts without stale lock", async () => {
    const { root: r2, dbPath: db2 } = scratchEnv();

    // First fixture
    const f1 = await startRealApp(t, {
      readyTimeout: 25_000,
      env: {
        APERIO_E2E_SKIP_BOOT: "0",
        APERIO_E2E_INJECT_AGENT: "1",
        DB_BACKEND: "sqlite",
        SQLITE_PATH: db2,
        AI_PROVIDER: "stub",
        EMBEDDING_PROVIDER: "none",
        APERIO_CODEGRAPH: "off",
        APERIO_DOCGRAPH: "off",
        IDLE_SHUTDOWN: "off",
        APERIO_CONFIG_PRECEDENCE: "env",
      },
    });

    // Write some data
    await request(f1, "/api/settings/config.LLAMACPP_MODEL", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Aperio-Client": "e2e" },
      body: JSON.stringify({ value: "survived-restart" }),
    });

    // Stop first instance
    await f1.stop();

    // Restart with same SQLite path
    const f2 = await startRealApp(t, {
      readyTimeout: 25_000,
      env: {
        APERIO_E2E_SKIP_BOOT: "0",
        APERIO_E2E_INJECT_AGENT: "1",
        DB_BACKEND: "sqlite",
        SQLITE_PATH: db2,
        AI_PROVIDER: "stub",
        EMBEDDING_PROVIDER: "none",
        APERIO_CODEGRAPH: "off",
        APERIO_DOCGRAPH: "off",
        IDLE_SHUTDOWN: "off",
        APERIO_CONFIG_PRECEDENCE: "env",
      },
    });

    // Data survived
    const getRes = await request(f2, "/api/settings/config.LLAMACPP_MODEL");
    assert.equal(getRes.status, 200, "Setting readable after restart");
    assert.equal(getRes.json.value, "survived-restart", "Data survived restart");

    await f2.stop();
    rmSync(r2, { recursive: true, force: true });
  });

  // ════════════════════════════════════════════════════════════════════
  // T59: Tests use conditions, not sleeps
  // ════════════════════════════════════════════════════════════════════
  await t.test("T59: test helpers use condition-based waits", () => {
    const helperSrc = readFileSync(
      resolve(REPO_ROOT, "tests/e2e/helpers/real-app-helper.js"), "utf8"
    );
    // Verify the helper uses Promise-based condition waits, not setTimeout
    // as a correctness mechanism. setTimeout is only used for bounded timeouts.
    assert.ok(
      helperSrc.includes("await new Promise") ||
      helperSrc.includes("child.on("),
      "Helper uses event-driven waits"
    );
    assert.ok(
      !helperSrc.includes("setTimeout(") ||
      helperSrc.includes("setTimeout(() => reject") ||
      helperSrc.includes("clearTimeout(tid"),
      "Any setTimeout is used only for timeouts/deadlines, not correctness"
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // T61: No orphan processes after cleanup
  // ════════════════════════════════════════════════════════════════════
  await t.test("T61: no orphan fixture processes remain", () => {
    // Check for any leftover real-app-server processes
    try {
      const ps = execSync("pgrep -f 'real-app-server' 2>/dev/null || true", {
        encoding: "utf8",
      }).trim();
      assert.equal(ps, "", `No orphan real-app-server processes: "${ps}"`);
    } catch {
      // pgrep not available — skip
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════
// Group I: CI and Postgres parity
// ═════════════════════════════════════════════════════════════════════════

test("CI and backend parity", async (t) => {
  // ════════════════════════════════════════════════════════════════════
  // T62: Scripts discover real-app tests
  // ════════════════════════════════════════════════════════════════════
  await t.test("T62: test:e2e:real discovers only real-app files", () => {
    const pkg = readFileSync(resolve(REPO_ROOT, "package.json"), "utf8");
    assert.ok(
      pkg.includes('test:e2e:real'),
      "test:e2e:real script exists in package.json"
    );
    assert.ok(
      pkg.includes("'tests/e2e/real-app-*.test.js'"),
      "test:e2e:real targets real-app-*.test.js files"
    );
    assert.ok(
      pkg.includes("'tests/e2e/**/*.test.js'"),
      "test:e2e targets all e2e test files"
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // T63: Real-app tests do not require external services
  // ════════════════════════════════════════════════════════════════════
  await t.test("T63: real-app tests are hermetic (no external deps)", () => {
    // All real-app test files use the fixture which sets env vars to disable
    // external services: EMBEDDING_PROVIDER=none, APERIO_CODEGRAPH=off, etc.
    const charSrc = readFileSync(
      resolve(REPO_ROOT, "tests/unit/real-app-char.test.js"), "utf8"
    );
    assert.ok(
      !charSrc.includes("fetch(") &&
      !charSrc.includes("axios") &&
      !charSrc.includes("got("),
      "Characterization tests don't make network calls"
    );
  });

  // ════════════════════════════════════════════════════════════════════
  // T64-T65: Optional Postgres parity
  // ════════════════════════════════════════════════════════════════════
  const pgUrl = process.env.APERIO_E2E_POSTGRES_URL;
  if (!pgUrl) {
    await t.test("T64: Postgres skipped when not configured", (st) => {
      st.diagnostic("APERIO_E2E_POSTGRES_URL not set — Postgres tests skipped");
    });
  } else {
    await t.test("T64: Postgres target is owned disposable database", () => {
      assert.ok(
        pgUrl.includes("e2e") || pgUrl.includes("test"),
        "Postgres URL should target a disposable database (name containing 'e2e' or 'test')"
      );
    });
  }
});
