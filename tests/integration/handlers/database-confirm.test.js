// tests/handlers/database-confirm.test.js
// Two-phase confirm flow for db_execute, plus db_query read-only gating (#170).

import { describe, test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  executeHandler, queryHandler, connectionsHandler,
} from "../../../lib/handlers/database/databaseHandlers.js";
import { normalizeAmount } from "../../../lib/handlers/database/amounts.js";
import { EXTRACTION_CONNECTION, extractionDbPath, findExtractionConnection } from "../../../lib/db-connect/extraction.js";

let dbPath, ctx;

function makeInterruptStore() {
  const rows = new Map();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const get = id => clone(rows.get(id) ?? null);
  return {
    async createAgentInterrupt(input) {
      const now = new Date().toISOString();
      const row = {
        id: input.id,
        session_id: input.sessionId ?? null,
        run_id: input.runId ?? null,
        tool_name: input.toolName,
        canonical_arguments: clone(input.canonicalArguments),
        protected_payload_ref: clone(input.protectedPayloadRef ?? null),
        digest: input.digest,
        allowed_decisions: clone(input.allowedDecisions),
        decision: null,
        decision_payload: null,
        claim_id: null,
        status: "pending",
        created_at: now,
        updated_at: now,
        decided_at: null,
        claimed_at: null,
        completed_at: null,
        expires_at: input.expiresAt ?? null,
      };
      rows.set(row.id, row);
      return get(row.id);
    },
    async getAgentInterrupt(id) { return get(id); },
    async listAgentInterrupts({ status = "pending" } = {}) {
      return [...rows.values()].filter(row => !status || row.status === status).map(row => clone(row));
    },
    async updateAgentInterruptStatus(id, status) {
      const row = rows.get(id);
      if (!row) return null;
      row.status = status;
      row.updated_at = new Date().toISOString();
      return get(id);
    },
    async expireAgentInterrupts(now = new Date().toISOString()) {
      let count = 0;
      for (const row of rows.values()) {
        if (row.status === "pending" && row.expires_at && row.expires_at <= now) {
          row.status = "expired";
          row.updated_at = now;
          count++;
        }
      }
      return count;
    },
    async decideAgentInterrupt(id, { decision, status, decisionPayload = null, now = new Date().toISOString() }) {
      const row = rows.get(id);
      if (!row || row.status !== "pending" || (row.expires_at && row.expires_at <= now)) return null;
      row.decision = decision;
      row.decision_payload = clone(decisionPayload);
      row.status = status;
      row.decided_at = now;
      row.updated_at = now;
      return get(id);
    },
    async claimAgentInterrupt(id, { claimId, now = new Date().toISOString() }) {
      const row = rows.get(id);
      if (!row || !["approved", "edited"].includes(row.status) || (row.expires_at && row.expires_at <= now)) return null;
      row.status = "claimed";
      row.claim_id = claimId;
      row.claimed_at = now;
      row.updated_at = now;
      return get(id);
    },
    async completeAgentInterrupt(id, { status = "executed", now = new Date().toISOString() } = {}) {
      const row = rows.get(id);
      if (!row || row.status !== "claimed") return null;
      row.status = status;
      row.completed_at = now;
      row.updated_at = now;
      return get(id);
    },
  };
}

function makeStore(connections, { interrupts = false } = {}) {
  const settings = new Map([["db.connections", connections]]);
  return {
    getSetting: async (k) => (settings.has(k) ? settings.get(k) : null),
    setSetting: async (k, v) => { settings.set(k, v); return v; },
    ...(interrupts ? makeInterruptStore() : {}),
  };
}

const textOf = (res) => res.content[0].text;

async function confirmed(args, targetCtx = ctx) {
  const proposed = await executeHandler(targetCtx, args);
  const token = textOf(proposed).match(/Token:\s*(db_[a-z0-9]+)/)?.[1];
  assert.ok(token, `expected confirmation token: ${textOf(proposed)}`);
  return executeHandler(targetCtx, { confirmation_token: token });
}

before(() => {
  dbPath = join(tmpdir(), `aperio-confirm-test-${randomBytes(6).toString("hex")}.db`);
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)");
  db.exec("INSERT INTO t (a) VALUES (1), (2)");
  db.close();
  ctx = { store: makeStore([
    { name: "rw", engine: "sqlite", file: dbPath, readOnly: false },
    { name: "ro", engine: "sqlite", file: dbPath, readOnly: true },
  ]) };
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(dbPath + suffix); } catch { /* ignore */ } }
});

describe("db_connections", () => {
  test("lists built-in aperio + user connections, no secrets", async () => {
    const data = JSON.parse(textOf(await connectionsHandler(ctx, {})));
    const names = data.connections.map((c) => c.name);
    assert.ok(names.includes("aperio"));
    assert.ok(names.includes("rw") && names.includes("ro"));
    assert.ok(data.connections.every((c) => !("password" in c)));
  });
});

describe("db_query gating", () => {
  test("rejects a write statement", async () => {
    const res = await queryHandler(ctx, { connection: "rw", sql: "DELETE FROM t" });
    assert.ok(res.isError);
    assert.match(textOf(res), /only runs read statements/i);
  });
  test("runs a read and returns rows", async () => {
    const data = JSON.parse(textOf(await queryHandler(ctx, { connection: "rw", sql: "SELECT * FROM t ORDER BY id" })));
    assert.equal(data.rowCount, 2);
  });
  test("accepts the statement under a near-miss key (query alias)", async () => {
    // Weak models pass the SQL as `query` instead of `sql`; the handler recovers it.
    const data = JSON.parse(textOf(await queryHandler(ctx, { connection: "rw", query: "SELECT * FROM t ORDER BY id" })));
    assert.equal(data.rowCount, 2);
  });
  test("surfaces a friendly error when no sql is provided", async () => {
    const res = await queryHandler(ctx, { connection: "rw" });
    assert.ok(res.isError);
    assert.match(textOf(res), /`sql` is required/i);
  });
});

describe("db_execute two-phase confirm", () => {
  test("propose returns a db_ token and does NOT write", async () => {
    const res = await executeHandler(ctx, { connection: "rw", sql: "INSERT INTO t (a) VALUES (?)", params: [99] });
    assert.match(textOf(res), /Token:\s*db_[a-z0-9]+/);
    assert.match(textOf(res), /nothing has been written/i);
    // confirm nothing inserted yet
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) c FROM t").get().c;
    db.close();
    assert.equal(count, 2);
  });

  test("commit with the token performs the write", async () => {
    const propose = await executeHandler(ctx, { connection: "rw", sql: "INSERT INTO t (a) VALUES (?)", params: [99] });
    const token = textOf(propose).match(/Token:\s*(db_[a-z0-9]+)/)[1];
    const commit = await executeHandler(ctx, { confirmation_token: token });
    assert.match(textOf(commit), /✅ Executed/);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT a FROM t WHERE a = 99").get();
    db.close();
    assert.ok(row);
  });

  test("persists db_execute as a durable interrupt descriptor and executes through claim", async () => {
    const durableCtx = { store: makeStore([
      { name: "rw", engine: "sqlite", file: dbPath, readOnly: false },
    ], { interrupts: true }) };

    const propose = await executeHandler(durableCtx, { connection: "rw", sql: "INSERT INTO t (a) VALUES (?)", params: [123] });
    const token = textOf(propose).match(/Token:\s*(db_[a-z0-9]+)/)[1];
    const row = await durableCtx.store.getAgentInterrupt(token);
    assert.equal(row.tool_name, "db_execute");
    assert.equal(row.status, "pending");
    assert.equal(row.canonical_arguments.connection, "rw");
    assert.equal(row.canonical_arguments.statementClass, "write");

    const commit = await executeHandler(durableCtx, { confirmation_token: token });
    assert.match(textOf(commit), /✅ Executed/);
    assert.equal((await durableCtx.store.getAgentInterrupt(token)).status, "executed");

    const db = new Database(dbPath, { readonly: true });
    const row123 = db.prepare("SELECT a FROM t WHERE a = 123").get();
    db.close();
    assert.ok(row123);
  });

  test("confirmation revalidates connection writability before commit", async () => {
    const store = makeStore([
      { name: "rw", engine: "sqlite", file: dbPath, readOnly: false },
    ], { interrupts: true });
    const durableCtx = { store };

    const propose = await executeHandler(durableCtx, { connection: "rw", sql: "INSERT INTO t (a) VALUES (?)", params: [321] });
    const token = textOf(propose).match(/Token:\s*(db_[a-z0-9]+)/)[1];
    await store.setSetting("db.connections", [{ name: "rw", engine: "sqlite", file: dbPath, readOnly: true }]);

    const commit = await executeHandler(durableCtx, { confirmation_token: token });
    assert.ok(commit.isError);
    assert.match(textOf(commit), /read-only/i);

    const db = new Database(dbPath, { readonly: true });
    const row321 = db.prepare("SELECT a FROM t WHERE a = 321").get();
    db.close();
    assert.equal(row321, undefined);
  });

  test("an invalid/expired token is refused", async () => {
    const res = await executeHandler(ctx, { confirmation_token: "db_nope12" });
    assert.ok(res.isError);
    assert.match(textOf(res), /invalid or expired/i);
  });

  test("rejects a read statement", async () => {
    const res = await executeHandler(ctx, { connection: "rw", sql: "SELECT 1" });
    assert.ok(res.isError);
    assert.match(textOf(res), /use db_query/i);
  });

  test("rejects a read-only connection", async () => {
    const res = await executeHandler(ctx, { connection: "ro", sql: "DELETE FROM t" });
    assert.ok(res.isError);
    assert.match(textOf(res), /read-only/i);
  });

  test("rejects a multi-statement batch", async () => {
    const res = await executeHandler(ctx, { connection: "rw", sql: "DELETE FROM t; DROP TABLE t" });
    assert.ok(res.isError);
    assert.match(textOf(res), /ONE statement/i);
  });
});

describe("WS1 extraction SQL round-trip", () => {
  test("appends normalized locale amounts and aggregates by currency without FX", async () => {
    await confirmed({
      connection: "rw",
      sql: "CREATE TABLE extraction_rows (category TEXT, source_amount TEXT, amount REAL, currency TEXT)",
    });
    const rows = [
      ["Utilities", "142.50 BGN"],
      ["Utilities", "1 266 250,00 EUR"],
      ["Utilities", "-12,50 BGN"],
    ].map(([category, source]) => {
      const normalized = normalizeAmount(source);
      return [category, normalized.source, normalized.amount, normalized.currency];
    });
    for (const params of rows) {
      await confirmed({
        connection: "rw",
        sql: "INSERT INTO extraction_rows (category, source_amount, amount, currency) VALUES (?, ?, ?, ?)",
        params,
      });
    }
    const result = JSON.parse(textOf(await queryHandler(ctx, {
      connection: "rw",
      sql: "SELECT currency, SUM(amount) AS total FROM extraction_rows GROUP BY currency ORDER BY currency",
    })));
    assert.deepEqual(result.rows, [
      { currency: "BGN", total: 130 },
      { currency: "EUR", total: 1266250 },
    ]);
    const source = JSON.parse(textOf(await queryHandler(ctx, {
      connection: "rw", sql: "SELECT source_amount FROM extraction_rows ORDER BY rowid",
    })));
    assert.deepEqual(source.rows.map(row => row.source_amount), ["142.50 BGN", "1 266 250,00 EUR", "-12,50 BGN"]);
  });
});

describe("WS1 writable destination — clean-profile provisioning (T-G1.1, T-G1.2, T-G1.4)", () => {
  // extractionDbPath() is namespaced per profile by the live store's own
  // resolved identity (P1: two profiles sharing one checkout must never
  // collide — see lib/db-connect/extraction.js). Every test therefore gets a
  // FRESH, random, synthetic identity — never a real filesystem path or
  // connection string — so the file it resolves to cannot coincide with any
  // real developer's actual profile. Cleanup only ever removes the exact
  // file(s) a given test's own synthetic identity produced; it is never a
  // hardcoded or no-argument path. The sentinel test at the end of this
  // block proves, rather than merely asserts, that an unrelated "other
  // profile" file sitting in the very same directory survives the whole
  // suite untouched.
  const testFiles = [];

  // A brand new profile: no connections in Settings beyond the built-in
  // aperio one, nothing hand-edited. `db.name` mimics the shape
  // lib/db-connect/drivers/aperio.js already duck-types on a live
  // SqliteStore, but the value itself is a random token that can never equal
  // a real store's actual file path.
  function cleanCtx() {
    const store = { ...makeStore([]), db: { name: `test-profile:${randomBytes(8).toString("hex")}` } };
    testFiles.push(extractionDbPath(store));
    return { store };
  }

  afterEach(() => {
    while (testFiles.length) {
      const file = testFiles.pop();
      for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(file + suffix); } catch { /* ignore */ } }
    }
  });

  test("db_connections on a clean profile lists only the read-only built-in aperio connection", async () => {
    const data = JSON.parse(textOf(await connectionsHandler(cleanCtx(), {})));
    assert.deepEqual(data.connections.map((c) => c.name), ["aperio"]);
    assert.equal(data.connections[0].readOnly, true);
  });

  test("built-in aperio connection rejects writes even when named explicitly (T-G1.1)", async () => {
    const res = await executeHandler(cleanCtx(), { connection: "aperio", sql: "DELETE FROM memories" });
    assert.ok(res.isError);
    assert.match(textOf(res), /always read-only/i);
  });

  test("proposing a write against 'extraction' discloses it will be created, and provisions nothing yet", async () => {
    const cCtx = cleanCtx();
    const res = await executeHandler(cCtx, {
      connection: EXTRACTION_CONNECTION,
      sql: "CREATE TABLE document_extractions (id INTEGER PRIMARY KEY, category TEXT, source_hash TEXT UNIQUE, source_amount TEXT, amount REAL, currency TEXT)",
    });
    assert.match(textOf(res), /Token:\s*db_[a-z0-9]+/);
    assert.match(textOf(res), /will be created now/i);
    assert.equal(await findExtractionConnection(cCtx.store), null, "nothing provisioned before confirmation");
  });

  test("declining a proposed extraction write (never confirming) provisions nothing — edge case", async () => {
    const cCtx = cleanCtx();
    await executeHandler(cCtx, { connection: EXTRACTION_CONNECTION, sql: "CREATE TABLE t (a INTEGER)" });
    assert.equal(await findExtractionConnection(cCtx.store), null);
    assert.ok(!existsSync(extractionDbPath(cCtx.store)));
  });

  test("confirming provisions the connection without hand-editing config; aperio stays read-only after (T-G1.1)", async () => {
    const cCtx = cleanCtx();
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "CREATE TABLE document_extractions (id INTEGER PRIMARY KEY, category TEXT, source_hash TEXT UNIQUE, source_amount TEXT, amount REAL, currency TEXT)",
    }, cCtx);

    const registered = await findExtractionConnection(cCtx.store);
    assert.ok(registered, "extraction connection now registered");
    assert.equal(registered.name, "extraction");
    assert.equal(registered.readOnly, false);
    assert.notEqual(registered.name, "aperio", "never derived from or named after the built-in connection");
    assert.ok(existsSync(extractionDbPath(cCtx.store)));

    const rejected = await executeHandler(cCtx, { connection: "aperio", sql: "DELETE FROM memories" });
    assert.ok(rejected.isError);
    assert.match(textOf(rejected), /read-only/i);
  });

  test("re-confirming a second write against 'extraction' reuses the same connection — already-exists edge case", async () => {
    const cCtx = cleanCtx();
    await confirmed({ connection: EXTRACTION_CONNECTION, sql: "CREATE TABLE t (a INTEGER)" }, cCtx);
    const first = await findExtractionConnection(cCtx.store);

    await confirmed({ connection: EXTRACTION_CONNECTION, sql: "INSERT INTO t (a) VALUES (1)" }, cCtx);
    const second = await findExtractionConnection(cCtx.store);
    assert.deepEqual(second, first, "no duplicate connection created");

    const rows = JSON.parse(textOf(await queryHandler(cCtx, { connection: EXTRACTION_CONNECTION, sql: "SELECT a FROM t" })));
    assert.equal(rows.rowCount, 1);
  });

  test("append-and-round-trip: two extractions land in one table and both come back on query (T-G1.2)", async () => {
    const cCtx = cleanCtx();
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "CREATE TABLE document_extractions (source_document TEXT, source_hash TEXT UNIQUE, category TEXT, source_amount TEXT, amount REAL, currency TEXT)",
    }, cCtx);

    const first = normalizeAmount("142.50 BGN");
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "INSERT INTO document_extractions (source_document, source_hash, category, source_amount, amount, currency) VALUES (?, ?, ?, ?, ?, ?)",
      params: ["electricity-bill.txt", "hash-1", "Utilities", first.source, first.amount, first.currency],
    }, cCtx);

    const second = normalizeAmount("1 266 250,00 EUR");
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "INSERT INTO document_extractions (source_document, source_hash, category, source_amount, amount, currency) VALUES (?, ?, ?, ?, ?, ?)",
      params: ["trade-invoice.txt", "hash-2", "Uncategorized", second.source, second.amount, second.currency],
    }, cCtx);

    const all = JSON.parse(textOf(await queryHandler(cCtx, {
      connection: EXTRACTION_CONNECTION, sql: "SELECT source_document, amount, currency FROM document_extractions ORDER BY rowid",
    })));
    assert.equal(all.rowCount, 2);
    assert.deepEqual(all.rows, [
      { source_document: "electricity-bill.txt", amount: 142.5, currency: "BGN" },
      { source_document: "trade-invoice.txt", amount: 1266250, currency: "EUR" },
    ]);
  });

  test("duplicate source hash is surfaced, never silently deduplicated or silently accepted (T-G1.2 edge case)", async () => {
    const cCtx = cleanCtx();
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "CREATE TABLE document_extractions (source_document TEXT, source_hash TEXT UNIQUE, amount REAL, currency TEXT)",
    }, cCtx);
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "INSERT INTO document_extractions (source_document, source_hash, amount, currency) VALUES (?, ?, ?, ?)",
      params: ["electricity-bill.txt", "dup-hash", 142.5, "BGN"],
    }, cCtx);
    const dupResult = await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "INSERT INTO document_extractions (source_document, source_hash, amount, currency) VALUES (?, ?, ?, ?)",
      params: ["electricity-bill-copy.txt", "dup-hash", 142.5, "BGN"],
    }, cCtx);
    assert.ok(dupResult.isError);
    assert.match(textOf(dupResult), /unique|constraint/i);

    const rows = JSON.parse(textOf(await queryHandler(cCtx, { connection: EXTRACTION_CONNECTION, sql: "SELECT COUNT(*) AS n FROM document_extractions" })));
    assert.equal(rows.rows[0].n, 1, "the duplicate was rejected, not silently inserted");
  });

  test("field drift on a later extraction surfaces a clear error rather than silently dropping data (T-G1.2 edge case)", async () => {
    const cCtx = cleanCtx();
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "CREATE TABLE document_extractions (source_document TEXT, amount REAL, currency TEXT)",
    }, cCtx);
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "INSERT INTO document_extractions (source_document, amount, currency) VALUES (?, ?, ?)",
      params: ["a.txt", 10, "BGN"],
    }, cCtx);
    const drifted = await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "INSERT INTO document_extractions (source_document, amount, currency, vat_rate) VALUES (?, ?, ?, ?)",
      params: ["b.txt", 20, "BGN", "20%"],
    }, cCtx);
    assert.ok(drifted.isError, "field drift is surfaced as an error, never a silent partial write");
    assert.match(textOf(drifted), /no such column|vat_rate/i);
  });

  test("aggregates mixed BGN/EUR rows separately by currency with no blended or converted total (T-G1.4)", async () => {
    const cCtx = cleanCtx();
    await confirmed({
      connection: EXTRACTION_CONNECTION,
      sql: "CREATE TABLE document_extractions (category TEXT, amount REAL, currency TEXT)",
    }, cCtx);
    const rows = [
      ["Utilities", "142.50 BGN"], ["Fuel", "50.00 BGN"], ["Transport", "40.00 EUR"], ["Transport", "9.90 EUR"],
    ].map(([category, source]) => {
      const n = normalizeAmount(source);
      return [category, n.amount, n.currency];
    });
    for (const params of rows) {
      await confirmed({
        connection: EXTRACTION_CONNECTION,
        sql: "INSERT INTO document_extractions (category, amount, currency) VALUES (?, ?, ?)",
        params,
      }, cCtx);
    }
    const totals = JSON.parse(textOf(await queryHandler(cCtx, {
      connection: EXTRACTION_CONNECTION,
      sql: "SELECT currency, SUM(amount) AS total FROM document_extractions GROUP BY currency ORDER BY currency",
    })));
    // Separate per-currency totals only — no exchange rate is ever computed
    // or stored anywhere in this schema, so a single blended figure is
    // structurally impossible to produce from it, not merely absent by luck.
    assert.deepEqual(totals.rows, [
      { currency: "BGN", total: 192.5 },
      { currency: "EUR", total: 49.9 },
    ]);
  });

  test("a writable connection that merely shares the reserved name is rejected, never silently written to (P2)", async () => {
    // Not the managed row — no `provisioned` marker — even though it is
    // writable and would otherwise happily accept the INSERT.
    const store = { ...makeStore([{ name: EXTRACTION_CONNECTION, engine: "sqlite", file: dbPath, readOnly: false }]), db: { name: `test-profile:${randomBytes(8).toString("hex")}` } };
    const cCtx = { store };
    const res = await executeHandler(cCtx, { connection: EXTRACTION_CONNECTION, sql: "INSERT INTO t (a) VALUES (999)" });
    assert.ok(res.isError);
    assert.match(textOf(res), /reserved/i);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT a FROM t WHERE a = 999").get();
    db.close();
    assert.equal(row, undefined, "the unrelated connection's own database was never touched");
    assert.ok(!existsSync(extractionDbPath(store)), "no managed extraction database was created either");
  });

  test("a connection forging the `provisioned` marker with a different file is rejected, never routed to it (P2)", async () => {
    // Simulates a row written through the generic settings API (raw
    // `PUT /api/settings/db.connections`) or a headless DB_CONNECTIONS seed —
    // neither goes through the dedicated connections API's field allowlist,
    // so either can set `provisioned: true` on ANY shape. Before this fix,
    // `meta.provisioned` alone was trusted here, and the confirmed write
    // landed in this unrelated file (just via the plain, non-encrypting
    // driver rather than the managed one) instead of being rejected.
    const forgedFile = join(tmpdir(), `aperio-forged-extraction-${randomBytes(6).toString("hex")}.db`);
    const forgedDb = new Database(forgedFile);
    forgedDb.exec("CREATE TABLE document_extractions (amount REAL)");
    forgedDb.close();
    try {
      const store = {
        ...makeStore([{ name: EXTRACTION_CONNECTION, engine: "sqlite", file: forgedFile, readOnly: false, provisioned: true }]),
        db: { name: `test-profile:${randomBytes(8).toString("hex")}` },
      };
      const cCtx = { store };
      const res = await executeHandler(cCtx, { connection: EXTRACTION_CONNECTION, sql: "INSERT INTO document_extractions (amount) VALUES (1)" });
      assert.ok(res.isError);
      assert.match(textOf(res), /reserved/i);

      const db = new Database(forgedFile, { readonly: true });
      const row = db.prepare("SELECT amount FROM document_extractions").get();
      db.close();
      assert.equal(row, undefined, "the forged row's own file was never written to");
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(forgedFile + suffix); } catch { /* ignore */ } }
    }
  });

  test("a read-only connection that merely shares the reserved name does not block self-provisioning with a misleading error (P2)", async () => {
    const cCtx = { store: { ...makeStore([{ name: EXTRACTION_CONNECTION, engine: "sqlite", file: dbPath, readOnly: true }]), db: { name: `test-profile:${randomBytes(8).toString("hex")}` } } };
    const res = await executeHandler(cCtx, { connection: EXTRACTION_CONNECTION, sql: "CREATE TABLE x (a INTEGER)" });
    assert.ok(res.isError);
    // Must name the actual problem (a reserved-name collision) rather than
    // the generic read-only message, which would wrongly suggest flipping
    // that unrelated connection's readOnly flag is the fix.
    assert.match(textOf(res), /reserved/i);
    assert.doesNotMatch(textOf(res), /turn off its read-only flag/i);
  });

  // ── Sentinel: proof, not assertion, that this suite cannot reach a real
  // profile's extraction data ────────────────────────────────────────────
  // A file for a DIFFERENT, unrelated profile — never one of this suite's own
  // random per-test identities — created once before any test above runs and
  // checked byte-for-byte after every test above has finished. If any test's
  // cleanup, provisioning, or write path ever regressed to a shared/hardcoded
  // location again, this file would be exactly what an earlier version of
  // this suite deleted out from under a real developer (P1); here it must
  // survive completely untouched.
  const sentinelStore = { db: { name: "test-profile:sentinel-other-developer" } };
  const sentinelFile = extractionDbPath(sentinelStore);
  let sentinelBytesBefore;

  before(() => {
    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(sentinelFile + suffix); } catch { /* ignore: stale run */ } }
    mkdirSync(dirname(sentinelFile), { recursive: true });
    const db = new Database(sentinelFile);
    db.exec("CREATE TABLE real_user_data (secret TEXT)");
    db.prepare("INSERT INTO real_user_data (secret) VALUES (?)").run("do-not-touch");
    db.close();
    sentinelBytesBefore = readFileSync(sentinelFile);
  });

  after(() => {
    const sentinelBytesAfter = readFileSync(sentinelFile);
    assert.deepEqual(sentinelBytesAfter, sentinelBytesBefore,
      "an unrelated profile's extraction database must never be modified by this suite");
    // Only the file itself — never the shared var/extraction/ parent
    // directory, which other extraction-touching test files also write into
    // concurrently under plain `npm test`; rmdirSync-if-empty still raced
    // another test's mkdirSync+first-write window (P2 review finding).
    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(sentinelFile + suffix); } catch { /* ignore */ } }
  });
});
