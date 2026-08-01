// tests/lib/routes/api-database.test.js
// Tests for database connection CRUD endpoints.
//
// Connections are stored in the settings store. The real registry.js functions
// (listConnections, saveConnections) read/write through the store's getSetting
// / setSetting. We provide a mock store to control the persisted state.
// Test/sample/browser routes that need actual DB connections via getDriver
// are excluded from this file.

import { describe, test, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import { Router } from "express";
import { existsSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

import logger from "../../../lib/helpers/logger.js";
import { mountDatabaseRoutes } from "../../../lib/routes/api-database.js";
import { extractionDbPath, deleteExtractionFile } from "../../../lib/db-connect/extraction.js";

const SETTINGS_KEY = "db.connections";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

before(() => {
  mock.method(logger, "error", () => {});
  mock.method(logger, "warn",  () => {});
  mock.method(logger, "info",  () => {});
  mock.method(logger, "debug", () => {});
});

after(() => mock.restoreAll());

// ─── Invoke helper ────────────────────────────────────────────────────────────

function invoke(router, method, url, { body = {}, query = {}, params = {} } = {}) {
  return new Promise((resolve) => {
    const req = {
      method: method.toUpperCase(),
      url, body, query, params,
      path: url,
      headers: {}, baseUrl: "", originalUrl: url,
      ip: "127.0.0.1", socket: { remoteAddress: "127.0.0.1" },
    };
    const res = {
      _status: 200, headersSent: false, _headers: {},
      status(code) { this._status = code; return this; },
      json(data)   { resolve({ status: this._status, body: data }); },
      setHeader(k, v) { this._headers[String(k).toLowerCase()] = v; },
      getHeader(k)    { return this._headers[String(k).toLowerCase()]; },
      set()           { return this; },
      on()            { return this; },
    };
    router(req, res, () => resolve({ status: 404, body: null }));
  });
}

// ─── Mock store factory ──────────────────────────────────────────────────────
// The registry functions (listConnections, saveConnections) read/write
// settings.key = "db.connections" where the value is an array of connection
// objects. The mock store stores this in a plain object.

function makeStore(initialConnections = []) {
  const store = { [SETTINGS_KEY]: initialConnections };
  return {
    async getSetting(key) {
      return key === SETTINGS_KEY ? store[SETTINGS_KEY] : null;
    },
    async setSetting(key, value) {
      if (key === SETTINGS_KEY) store[SETTINGS_KEY] = value;
    },
    _store: store,
  };
}

// =============================================================================
// GET /database/connections
// =============================================================================

describe("GET /database/connections", () => {
  test("returns connections list from store", async () => {
    const store = makeStore([
      { name: "my-pg", engine: "postgres", host: "localhost" },
    ]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/database/connections");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.connections));
    // Should include the built-in aperio connection plus the stored one
    const names = body.connections.map(c => c.name);
    assert.ok(names.includes("my-pg"));
  });

  test("returns empty list when no connections saved", async () => {
    const store = makeStore([]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/database/connections");
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.connections));
    // Built-in aperio connection is always listed
    assert.ok(body.connections.some(c => c.builtin));
  });

  test("returns 500 when store throws", async () => {
    const store = {
      getSetting: async () => { throw new Error("db down"); },
    };
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "GET", "/database/connections");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db down"));
  });
});

// =============================================================================
// POST /database/connections  (upsert)
// =============================================================================

describe("POST /database/connections", () => {
  function makeStoreWithOne() {
    return makeStore([
      { name: "existing-pg", engine: "postgres", host: "pg.example.com", port: 5432, database: "test", user: "admin", password: "encrypted-secret" },
    ]);
  }

  // ── Validation tests ────────────────────────────────────────────────────────

  test("rejects missing name", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("name"));
  });

  test("rejects invalid name characters", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "has space!", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("name"));
  });

  test("rejects built-in reserved name", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "aperio", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("reserved") || body.error.includes("built-in"));
  });

  test("rejects unknown engine", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "test", engine: "mongo", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("engine"));
  });

  test("rejects SQLite without file path", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "test-sqlite", engine: "sqlite" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("file"));
  });

  test("rejects server engine without host", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "test-pg", engine: "postgres" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("host"));
  });

  // ── Add / update tests ──────────────────────────────────────────────────────

  test("adds a new connection", async () => {
    const store = makeStore([]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "my-db", engine: "postgres", host: "db.example.com", port: 5432, database: "test", user: "app", password: "secret" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    const names = body.connections.filter(c => !c.builtin).map(c => c.name);
    assert.ok(names.includes("my-db"));
  });

  test("updates existing connection preserving blank password", async () => {
    const store = makeStoreWithOne();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    // Update with blank password → preserve the stored encrypted one
    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "existing-pg", engine: "postgres", host: "new-host.example.com", password: "" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    // The stored connection's host should be updated
    const saved = await store.getSetting("db.connections");
    const conn = saved.find(c => c.name === "existing-pg");
    assert.strictEqual(conn.host, "new-host.example.com");
    // Password should be preserved and re-encrypted from previous entry
    assert.ok(conn.password.startsWith("enc:v1:"), "password was re-encrypted");
  });

  test("returns 500 when saveConnections throws", async () => {
    // A store whose setSetting throws
    const store = {
      getSetting: async () => [],
      setSetting: async () => { throw new Error("save failed"); },
    };
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "new-conn", engine: "sqlite", file: "/tmp/test.db" },
    });
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("save failed"));
  });

  test("rejects a fresh claim on the reserved 'extraction' name when no such connection exists yet", async () => {
    const store = makeStore([]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "extraction", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("reserved"));
  });

  test("rejects editing the genuinely managed (provisioned) extraction connection through the generic upsert", async () => {
    const store = makeStore([{ name: "extraction", engine: "sqlite", file: "/managed/path.db", readOnly: false, provisioned: true }]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "extraction", engine: "sqlite", file: "/managed/path.db", readOnly: true },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("reserved"));
  });

  // P2 review finding: a connection literally named "extraction" configured
  // before that name became reserved must stay editable — this save is an
  // update to that SAME pre-existing row (upsert-by-name), never a fresh
  // claim on the name, so it must not get permanently stuck rejecting every
  // submission that keeps its current name.
  test("P2: grandfathers a pre-existing, unmanaged 'extraction' connection — ordinary edits keep saving", async () => {
    const store = makeStore([{ name: "extraction", engine: "postgres", host: "old-host.example.com", readOnly: true }]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections", {
      body: { name: "extraction", engine: "postgres", host: "new-host.example.com", readOnly: true },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    const saved = await store.getSetting(SETTINGS_KEY);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].host, "new-host.example.com");
    assert.notEqual(saved[0].provisioned, true, "still not the self-provisioned managed row");
  });
});

// =============================================================================
// POST /database/connections/:name/rename
// =============================================================================

describe("POST /database/connections/:name/rename", () => {
  // P2 review finding: this is the actual migration path off the reserved
  // "extraction" name for a connection that held it before self-provisioning
  // existed. Recreating under a new name would demand the user retype a
  // password the server never returns; renaming in place must not.
  test("P2: renames a pre-existing 'extraction' connection, freeing the name, without disturbing its encrypted password", async () => {
    const store = makeStore([
      { name: "extraction", engine: "postgres", host: "pg.example.com", port: 5432, database: "test", user: "admin", password: "enc:v1:deadbeef" },
    ]);
    const originalPassword = store._store[SETTINGS_KEY][0].password;
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/extraction/rename", {
      body: { newName: "extraction-legacy" },
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);

    const saved = await store.getSetting(SETTINGS_KEY);
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].name, "extraction-legacy");
    assert.strictEqual(saved[0].password, originalPassword, "password carried over untouched, not re-entered");

    // The name is now free for self-provisioning.
    const { status: postStatus } = await invoke(router, "POST", "/database/connections", {
      body: { name: "extraction", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(postStatus, 400, "still reserved for self-provisioning, not for a NEW manual claim");
  });

  test("rejects renaming into a reserved name", async () => {
    const store = makeStore([{ name: "old-name", engine: "sqlite", file: "/tmp/x.db" }]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/old-name/rename", {
      body: { newName: "extraction" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("reserved"));
  });

  test("rejects renaming into an already-existing different connection's name", async () => {
    const store = makeStore([
      { name: "one", engine: "sqlite", file: "/tmp/one.db" },
      { name: "two", engine: "sqlite", file: "/tmp/two.db" },
    ]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/one/rename", {
      body: { newName: "two" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("already exists"));
  });

  test("rejects renaming the genuinely managed (provisioned) extraction connection", async () => {
    const store = makeStore([{ name: "extraction", engine: "sqlite", file: "/managed/path.db", readOnly: false, provisioned: true }]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/extraction/rename", {
      body: { newName: "extraction-old" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("managed"));
  });

  test("rejects renaming the built-in aperio connection", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/aperio/rename", {
      body: { newName: "something-else" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("built-in"));
  });

  test("returns 404 for a non-existent connection", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/nonexistent/rename", {
      body: { newName: "something-else" },
    });
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("not found"));
  });

  test("rejects an invalid new name", async () => {
    const store = makeStore([{ name: "old-name", engine: "sqlite", file: "/tmp/x.db" }]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/old-name/rename", {
      body: { newName: "has space!" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("name"));
  });
});

// =============================================================================
// POST /database/connections/test
// =============================================================================

describe("POST /database/connections/test", () => {
  // P2 review finding: this route called validate(req.body) with the default
  // empty list, so validate()'s grandfather clause (which needs the CURRENT
  // list to recognize a pre-existing, unmanaged 'extraction' connection)
  // never saw it — Test always hit the reserved-name rejection for a
  // connection the Save route above accepts unchanged. A real connection
  // attempt is out of scope for this file (see its header comment); this
  // only asserts the request gets PAST validate(), whatever happens to the
  // actual (unreachable) connection attempt after that.
  test("P2: does not reject a pre-existing, grandfathered 'extraction' connection with the reserved-name error", async () => {
    const store = makeStore([{ name: "extraction", engine: "sqlite", file: "/tmp/aperio-test-route-does-not-exist.db", readOnly: true }]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { body } = await invoke(router, "POST", "/database/connections/test", {
      body: { name: "extraction", engine: "sqlite", file: "/tmp/aperio-test-route-does-not-exist.db" },
    });
    assert.ok(!body.error || !body.error.includes("reserved"), `must not be rejected as reserved: ${body.error}`);
  });

  test("still rejects a fresh claim on the reserved 'extraction' name when no such connection exists yet", async () => {
    const store = makeStore([]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "POST", "/database/connections/test", {
      body: { name: "extraction", engine: "postgres", host: "localhost" },
    });
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("reserved"));
  });
});

// =============================================================================
// DELETE /database/connections/:name
// =============================================================================

describe("DELETE /database/connections/:name", () => {
  test("deletes an existing connection", async () => {
    const store = makeStore([
      { name: "to-delete", engine: "sqlite", file: "/tmp/test.db" },
    ]);
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/to-delete");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    const saved = await store.getSetting("db.connections");
    assert.strictEqual(saved.length, 0);
  });

  test("blocks deleting the built-in aperio connection", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/aperio");
    assert.strictEqual(status, 400);
    assert.ok(body.error.includes("built-in") || body.error.includes("cannot be deleted"));
  });

  test("returns 404 for non-existent connection", async () => {
    const store = makeStore();
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/nonexistent");
    assert.strictEqual(status, 404);
    assert.ok(body.error.includes("not found"));
  });

  test("returns 500 when store throws", async () => {
    const store = {
      getSetting: async () => { throw new Error("db error"); },
    };
    const router = Router();
    mountDatabaseRoutes(router, { store });

    const { status, body } = await invoke(router, "DELETE", "/database/connections/anything");
    assert.strictEqual(status, 500);
    assert.ok(body.error.includes("db error"));
  });

  // P2 review finding: deleting the managed extraction connection must also
  // remove its on-disk database, not just the settings row — otherwise the
  // data stays readable at rest, and a later confirmed write silently
  // re-provisions the exact same path and resurrects everything the user
  // believed they'd removed.
  test("deleting the genuinely managed extraction connection also removes its file and sidecars", async () => {
    const store = makeStore();
    const file = extractionDbPath(store);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fake managed sqlite content");
    writeFileSync(file + "-wal", "wal");
    writeFileSync(file + "-shm", "shm");
    store._store[SETTINGS_KEY] = [{ name: "extraction", engine: "sqlite", file, readOnly: false, provisioned: true }];

    const router = Router();
    mountDatabaseRoutes(router, { store });
    try {
      const { status, body } = await invoke(router, "DELETE", "/database/connections/extraction");
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual((await store.getSetting(SETTINGS_KEY)).length, 0, "settings row removed");
      assert.ok(!existsSync(file), "managed file removed from disk");
      assert.ok(!existsSync(file + "-wal"), "WAL sidecar removed");
      assert.ok(!existsSync(file + "-shm"), "SHM sidecar removed");
    } finally {
      // Only the file and its sidecars — never the shared var/extraction/
      // parent directory, which other extraction-touching test files also
      // write into concurrently under plain `npm test` (P2 review finding).
      for (const suffix of ["", "-wal", "-shm", "-journal"]) { try { unlinkSync(file + suffix); } catch { /* already gone */ } }
    }
  });

  test("deleting a row that merely forges `provisioned: true` on an unrelated file leaves that file untouched", async () => {
    // A row named "extraction" with provisioned:true but a file that does NOT
    // match this profile's real managed path — exactly what a raw
    // `PUT /api/settings/db.connections` or a DB_CONNECTIONS seed could
    // produce. Only the settings row should disappear; an arbitrary file
    // must never be deleted just because a forged marker points at it.
    const store = makeStore();
    const unrelatedFile = extractionDbPath(store) + ".unrelated-decoy";
    mkdirSync(dirname(unrelatedFile), { recursive: true });
    writeFileSync(unrelatedFile, "not actually the managed file");
    store._store[SETTINGS_KEY] = [{ name: "extraction", engine: "sqlite", file: unrelatedFile, readOnly: false, provisioned: true }];

    const router = Router();
    mountDatabaseRoutes(router, { store });
    try {
      const { status, body } = await invoke(router, "DELETE", "/database/connections/extraction");
      assert.strictEqual(status, 200);
      assert.strictEqual(body.ok, true);
      assert.strictEqual((await store.getSetting(SETTINGS_KEY)).length, 0, "settings row still removed");
      assert.ok(existsSync(unrelatedFile), "the unrelated file must not be deleted");
    } finally {
      unlinkSync(unrelatedFile);
    }
  });

  // P2 review finding: a deletion failure (EACCES, EBUSY, I/O error) must
  // surface as a failure, not a false "ok" while the sensitive data stays on
  // disk and the connection quietly disappears from Settings. Unlinking a
  // DIRECTORY is a real, portable, unmockable EPERM/EISDIR — never ENOENT —
  // so this exercises the actual failure path without touching fs internals.
  test("returns 500 and keeps the connection listed when the managed file cannot be deleted (non-ENOENT)", async () => {
    const store = makeStore();
    const file = extractionDbPath(store);
    mkdirSync(file, { recursive: true }); // `file` itself is a directory, not a deletable sqlite file
    store._store[SETTINGS_KEY] = [{ name: "extraction", engine: "sqlite", file, readOnly: false, provisioned: true }];

    const router = Router();
    mountDatabaseRoutes(router, { store });
    try {
      const { status, body } = await invoke(router, "DELETE", "/database/connections/extraction");
      assert.strictEqual(status, 500);
      assert.ok(body.error, "must report the failure, not a false success");
      assert.strictEqual((await store.getSetting(SETTINGS_KEY)).length, 1, "the connection row must NOT be removed when the file deletion failed");
    } finally {
      rmdirSync(file);
    }
  });

  // P2 review finding: acquireLock(`${file}.lock`)'s own openSync('wx') fails
  // with ENOENT when the file's PARENT directory doesn't exist at all — a
  // real, reachable state if the var/extraction/ directory was removed by
  // hand, or an earlier delete already cleaned it up. Before the fix this
  // propagated as a thrown error, 500ing the DELETE endpoint and leaving the
  // settings row permanently stuck (undeletable) even though there was
  // nothing left on disk to protect a lock over. Exercised directly against
  // deleteExtractionFile with a synthetic, guaranteed-untouched path (rather
  // than extractionDbPath's real var/extraction/, which other test files
  // write into concurrently and may have already created).
  test("P2: deleteExtractionFile is a no-op success when its parent directory no longer exists", async () => {
    const ghostFile = join(tmpdir(), `aperio-ghost-${randomBytes(8).toString("hex")}`, "sub", "extraction.db");
    await assert.doesNotReject(() => deleteExtractionFile(ghostFile));
  });
});
