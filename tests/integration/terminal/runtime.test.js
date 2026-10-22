// Tests for lib/terminal/runtime.js — the standalone terminal's boot hydration.
//
// Regression cover for the bug where the terminal never called loadAllowlist()
// and ran on the env-derived seed alone: folders added in Settings → Allowed
// folders were invisible to it, and folders REMOVED there were still writable
// in it. Plus the import-order half of the same bug — DEFAULT_PATHS is a
// module-level const in lib/routes/paths.js, so any *static* import of that
// module (direct or transitive) froze it before config hydration ran.
//
// Strategy: a real in-memory SQLite store (:memory:) with embeddings off, so
// the actual module chain executes with no I/O side effects. The structural
// import-order test runs in a child process, because it must observe module
// evaluation from a clean module registry.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { join, sep, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

// A dynamic import() specifier must be a file:// URL, not a bare path. On POSIX
// an absolute path happens to resolve; on Windows it becomes "C:\..." and
// Node's ESM loader rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME.
const moduleUrl = (rel) => pathToFileURL(join(REPO, rel)).href;

// ─── Env setup — must run before any module loads ─────────────────────────

before(() => {
  process.env.SQLITE_PATH        = ":memory:";
  process.env.EMBEDDING_PROVIDER = "none";
  process.env.DB_BACKEND         = "sqlite";
});

after(() => {
  delete process.env.SQLITE_PATH;
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.DB_BACKEND;
});

// ═══════════════════════════════════════════════════════════════════════════
// TERM-ALLOW-01..05 — the DB allowlist is what the terminal enforces
// ═══════════════════════════════════════════════════════════════════════════

describe("hydrateTerminalRuntime — allowed folders come from the DB", () => {
  let hydrateTerminalRuntime, getStore, paths, sandbox;

  before(async () => {
    ({ hydrateTerminalRuntime } = await import("../../../lib/terminal/runtime.js"));
    ({ getStore } = await import("../../../db/index.js"));
    paths = await import("../../../lib/routes/paths.js");

    // Realpath'd because paths.js normalizes through realpathSafe(), and on
    // macOS tmpdir() is a symlink (/var/... → /private/var/...).
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), "aperio-term-allow-")));
    mkdirSync(join(sandbox, "granted"), { recursive: true });
  });

  // ─── TERM-ALLOW-01 — an added folder becomes visible to the terminal ────

  test("a folder added to the DB allowlist is visible to the terminal", async () => {
    const granted = join(sandbox, "granted");
    const store = await getStore();
    await store.setSetting("allowed-paths", { paths: [granted] });

    const { getAllowlist } = await hydrateTerminalRuntime();

    assert.ok(
      getAllowlist().includes(granted),
      "the DB-listed folder should appear in the terminal's allowlist"
    );
    assert.ok(
      paths.isWritePathAllowed(join(granted, "note.txt")),
      "a write under the DB-listed folder should be permitted"
    );
  });

  // ─── TERM-ALLOW-02 — a removed folder is actually refused ───────────────
  //
  // The security-relevant direction. Before the fix the terminal held the env
  // seed forever, so revoking a folder in Settings left it writable in the CLI.

  test("a folder removed from the DB allowlist is refused by the terminal", async () => {
    const granted = join(sandbox, "granted");
    const store = await getStore();

    // Granted first, so the refusal below is a genuine revocation.
    await store.setSetting("allowed-paths", { paths: [granted] });
    await hydrateTerminalRuntime();
    assert.ok(paths.isWritePathAllowed(join(granted, "note.txt")), "precondition: granted");

    // Now revoked in Settings → Allowed folders.
    await store.setSetting("allowed-paths", { paths: [] });
    const { getAllowlist } = await hydrateTerminalRuntime();

    assert.ok(
      !getAllowlist().includes(granted),
      "the revoked folder should be gone from the terminal's allowlist"
    );
    assert.equal(
      paths.isWritePathAllowed(join(granted, "note.txt")), false,
      "a write under the revoked folder must be refused"
    );
    assert.equal(
      paths.isReadPathAllowed(join(granted, "note.txt")), false,
      "a read under the revoked folder must be refused"
    );
  });

  // ─── TERM-ALLOW-03 — the hard FLOOR survives an empty DB list ───────────
  //
  // An empty or unreachable list must not lock the terminal out of its own
  // workspace. The FLOOR (project cwd + var/scratch) is merged in regardless.

  test("the hard FLOOR still applies when the DB list is empty", async () => {
    const store = await getStore();
    await store.setSetting("allowed-paths", { paths: [] });

    const { getAllowlist } = await hydrateTerminalRuntime();
    const allowlist = getAllowlist();

    assert.ok(allowlist.includes(process.cwd()), "project cwd is in the floor");
    assert.ok(
      allowlist.some(p => p === join(process.cwd(), "var/scratch")),
      "var/scratch is in the floor"
    );
    assert.ok(
      paths.isWritePathAllowed(join(process.cwd(), "var/scratch", "out.txt")),
      "the session scratch workspace must stay writable"
    );
  });

  // ─── TERM-ALLOW-04 — the FLOOR survives a list that points elsewhere ────
  //
  // Guards the floor-less-seed bug specifically. The terminal used to pass
  // DEFAULT_PATHS into runWithPaths(), and DEFAULT_PATHS has NO floor merged —
  // withFloor() is only applied to the live allowlist. So an allowed-folders
  // list pointing outside the project locked the terminal out of its own
  // session scratch dir. The terminal now passes getAllowlist(), which always
  // carries the floor.

  test("var/scratch stays writable when the allowlist points outside the project", async () => {
    const elsewhere = join(sandbox, "granted");
    const store = await getStore();
    await store.setSetting("allowed-paths", { paths: [elsewhere] });

    const { getAllowlist } = await hydrateTerminalRuntime();
    const scratch = join(process.cwd(), "var/scratch");

    assert.ok(
      getAllowlist().includes(scratch),
      "getAllowlist() must carry the floor even when the user list is elsewhere"
    );
    // The seed the terminal used to pass carries no floor — this is the bug.
    assert.ok(
      !paths.DEFAULT_PATHS.includes(scratch),
      "DEFAULT_PATHS is floor-less by construction; passing it was the bug"
    );
    assert.ok(
      paths.isWritePathAllowed(join(scratch, "session", "out.pdf")),
      "the session scratch workspace must stay writable"
    );
  });

  // ─── TERM-ALLOW-05 — the store handle is stashed for setAllowlist() ─────
  //
  // Hydrating is also what lets an in-terminal index_folder confirm persist:
  // setAllowlist() only writes to the DB once loadAllowlist() has handed
  // paths.js the store.

  test("hydration returns the store so later grants can persist", async () => {
    const { store } = await hydrateTerminalRuntime();
    assert.ok(store && typeof store.setSetting === "function", "a live store is returned");

    const extra = join(sandbox, "granted");
    await paths.setAllowlist([extra]);
    const saved = await store.getSetting("allowed-paths");
    assert.deepEqual(saved.paths, [extra], "setAllowlist persisted through the stashed store");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TERM-ALLOW-06 — import-order contract
// ═══════════════════════════════════════════════════════════════════════════
//
// lib/routes/paths.js computes DEFAULT_PATHS from process.env at module
// evaluation time. If lib/terminal/standalone.js pulls that module into its
// STATIC import graph — directly, or transitively as it once did through
// lib/handlers/attachments — the seed freezes at the pre-hydration .env value
// and a DB-stored APERIO_ALLOWED_PATHS can never reach the terminal.
//
// Probe: set a marker env var, import standalone.js, change the marker, then
// import paths.js. If DEFAULT_PATHS still carries the FIRST marker, paths.js
// was evaluated during standalone's static graph and the deferral is broken.
// Runs in a child process so the module registry starts clean.

describe("standalone.js import-order contract", () => {
  test("importing standalone.js does not evaluate lib/routes/paths.js", () => {
    const probe = `
      process.env.APERIO_ALLOWED_PATHS = ${JSON.stringify(join(sep + "tmp", "before-marker"))};
      await import(${JSON.stringify(moduleUrl("lib/terminal/standalone.js"))});
      process.env.APERIO_ALLOWED_PATHS = ${JSON.stringify(join(sep + "tmp", "after-marker"))};
      const { DEFAULT_PATHS } = await import(${JSON.stringify(moduleUrl("lib/routes/paths.js"))});
      console.log(DEFAULT_PATHS.some(p => p.includes("before-marker")) ? "FROZEN" : "DEFERRED");
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      cwd: REPO,
    });

    assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
    assert.equal(
      r.stdout.trim(), "DEFERRED",
      "standalone.js must not import lib/routes/paths.js (directly or transitively) " +
      "before hydrateTerminalRuntime() runs — DEFAULT_PATHS freezes at import time"
    );
  });
});
