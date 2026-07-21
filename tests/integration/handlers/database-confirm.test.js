// tests/handlers/database-confirm.test.js
// Two-phase confirm flow for db_execute, plus db_query read-only gating (#170).

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import {
  executeHandler, queryHandler, connectionsHandler,
} from "../../lib/handlers/database/databaseHandlers.js";

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
