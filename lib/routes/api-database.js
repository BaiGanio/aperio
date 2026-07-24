// lib/routes/api-database.js
// CRUD + test-connection for the database tool's named connections (issue #170).
// Connections live DB-backed in the settings store under `db.connections`;
// passwords are field-encrypted by the registry on save and never returned to
// the client. The built-in `aperio` connection is implicit and not editable.

import express from "express";
import logger from "../helpers/logger.js";
import {
  SETTINGS_KEY, BUILTIN_NAME, listConnections, saveConnections, testConnectionConfig, getDriver,
} from "../db-connect/registry.js";
import { createSampleDatabase, deleteSampleDatabase } from "../db-connect/sample-db.js";
import { decryptSecret } from "../db-connect/secrets.js";

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ENGINES = new Set(["sqlite", "postgres", "mysql", "mssql"]);

// Quote a table identifier for the SELECT in the browser routes. The name is
// always validated against listTables() first, so this is belt-and-braces.
const quoteIdent = (engine, name) => {
  const s = String(name);
  if (engine === "mysql") return "`" + s.replace(/`/g, "``") + "`";
  if (engine === "mssql") return "[" + s.replace(/]/g, "]]") + "]";
  return '"' + s.replace(/"/g, '""') + '"'; // sqlite, postgres
};

function validate(conn) {
  if (!conn || typeof conn !== "object") return "connection body is required";
  if (!NAME_RE.test(conn.name || "")) return "name must be 1–40 chars: letters, digits, '-' or '_'";
  if (conn.name.toLowerCase() === BUILTIN_NAME) return `"${BUILTIN_NAME}" is a reserved built-in connection name`;
  if (!ENGINES.has(conn.engine)) return "engine must be one of: sqlite, postgres, mysql, mssql";
  if (conn.engine === "sqlite" && !conn.file) return "sqlite connections need a `file` path";
  if (conn.engine !== "sqlite" && !conn.host) return "server connections need a `host`";
  return null;
}

// Keep only the fields a connection of this engine actually uses.
function normalize(conn) {
  const base = { name: conn.name.trim(), engine: conn.engine, readOnly: conn.readOnly !== false };
  if (conn.engine === "sqlite") return { ...base, file: conn.file };
  return {
    ...base,
    host: conn.host,
    port: conn.port ? Number(conn.port) : undefined,
    database: conn.database,
    user: conn.user,
    password: conn.password,
  };
}

export function mountDatabaseRoutes(router, { store }) {
  // List (masked — no secrets).
  router.get("/database/connections", async (_req, res) => {
    try { res.json({ connections: await listConnections(store) }); }
    catch (err) { logger.error("GET /api/database/connections", err); res.status(500).json({ error: err.message }); }
  });

  // Add or update one connection (upsert by name).
  router.post("/database/connections", express.json({ limit: "32kb" }), async (req, res) => {
    try {
      const err = validate(req.body);
      if (err) return res.status(400).json({ error: err });
      const conn = normalize(req.body);

      const list = (await store.getSetting(SETTINGS_KEY)) || [];
      const idx = list.findIndex((c) => c.name.toLowerCase() === conn.name.toLowerCase());

      // Blank password on update → preserve the stored (encrypted) one.
      if ((conn.password == null || conn.password === "") && idx >= 0 && list[idx].password) {
        conn.password = list[idx].password;
      }
      if (idx >= 0) list[idx] = conn; else list.push(conn);

      const masked = await saveConnections(store, list);
      res.json({ ok: true, connections: [{ name: BUILTIN_NAME, builtin: true }, ...masked] });
    } catch (err) {
      logger.error("POST /api/database/connections", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete one connection by name.
  router.delete("/database/connections/:name", async (req, res) => {
    try {
      const name = req.params.name.toLowerCase();
      if (name === BUILTIN_NAME) return res.status(400).json({ error: "the built-in `aperio` connection cannot be deleted" });
      const list = (await store.getSetting(SETTINGS_KEY)) || [];
      const next = list.filter((c) => c.name.toLowerCase() !== name);
      if (next.length === list.length) return res.status(404).json({ error: "connection not found" });
      await saveConnections(store, next);
      res.json({ ok: true });
    } catch (err) {
      logger.error("DELETE /api/database/connections/:name", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Build the disposable sample "practice shop" and register its two
  // connections (read-only `sample` + writable `sample-rw`). Rebuilds fresh.
  router.post("/database/sample", async (_req, res) => {
    try {
      const masked = await createSampleDatabase(store);
      res.json({ ok: true, connections: [{ name: BUILTIN_NAME, builtin: true }, ...masked] });
    } catch (err) {
      logger.error("POST /api/database/sample", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete the sample connections and its file — resets the workbench.
  router.delete("/database/sample", async (_req, res) => {
    try {
      await deleteSampleDatabase(store);
      res.json({ ok: true });
    } catch (err) {
      logger.error("DELETE /api/database/sample", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Test a connection BEFORE saving. A blank password with a known name reuses
  // the stored secret so the user can re-test without re-typing it.
  router.post("/database/connections/test", express.json({ limit: "32kb" }), async (req, res) => {
    try {
      const err = validate(req.body);
      if (err) return res.status(400).json({ error: err });
      const conn = normalize(req.body);
      if (conn.password == null || conn.password === "") {
        const list = (await store.getSetting(SETTINGS_KEY)) || [];
        const existing = list.find((c) => c.name.toLowerCase() === conn.name.toLowerCase());
        if (existing?.password) conn.password = decryptSecret(existing.password);
      }
      const result = await testConnectionConfig(conn);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });

  // ── Read-only browser for an arbitrary connection ───────────────────────────
  // Lets the Database panel show the tables of any connection (e.g. the sample
  // shop), not just Aperio's own store. Always read-only: rows are fetched via
  // the driver's runRead, so even a writable connection can't be mutated here.

  // List a connection's tables (names only — cheap on any engine).
  router.get("/database/:name/tables", async (req, res) => {
    let driver;
    try {
      ({ driver } = await getDriver(store, req.params.name));
      const tables = await driver.listTables();
      res.json({ tables: tables.map((t) => ({ name: t.name, label: t.name, count: null })) });
    } catch (err) {
      res.status(err.userFacing ? 400 : 500).json({ error: err.message });
    } finally {
      await driver?.close?.();
    }
  });

  // Read the rows of one table from a connection (validated against listTables).
  router.get("/database/:name/table/:table", async (req, res) => {
    let driver;
    try {
      let engine;
      ({ driver, engine } = await getDriver(store, req.params.name));
      const match = (await driver.listTables())
        .find((t) => t.name.toLowerCase() === req.params.table.toLowerCase());
      if (!match) return res.status(400).json({ error: `Unknown table "${req.params.table}"` });
      const { columns, rows } = await driver.runRead(`SELECT * FROM ${quoteIdent(engine, match.name)}`, [], 500);
      res.json({ columns, rows });
    } catch (err) {
      res.status(err.userFacing ? 400 : 500).json({ error: err.message });
    } finally {
      await driver?.close?.();
    }
  });
}
