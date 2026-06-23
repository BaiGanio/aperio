// lib/db-connect/registry.js
//
// Connection registry for the database tool (issue #170). Resolves a connection
// NAME to a live driver. User connections are stored DB-backed in the settings
// store under `db.connections` (passwords field-encrypted via secrets.js); they
// are NEVER passed as tool arguments. The built-in `aperio` connection (the
// app's own store, read-only) is always present and cannot be overwritten.
//
// Lifecycle: getDriver() returns a fresh driver; the caller MUST call
// driver.close() when done (a no-op for the built-in `aperio` handle).

import { openSqlite } from "./drivers/sqlite.js";
import { openPostgres } from "./drivers/postgres.js";
import { openMysql } from "./drivers/mysql.js";
import { openMssql } from "./drivers/mssql.js";
import { openAperio, aperioEngine } from "./drivers/aperio.js";
import { encryptSecret, decryptSecret } from "./secrets.js";

export const SETTINGS_KEY = "db.connections";
export const BUILTIN_NAME = "aperio";
const ENGINES = new Set(["sqlite", "postgres", "mysql", "mssql"]);

const fail = (msg) => { throw Object.assign(new Error(msg), { userFacing: true }); };

// ── Storage ────────────────────────────────────────────────────────────────

// Headless seed: DB_CONNECTIONS may carry a JSON array of connection objects
// (for deploys with no UI). Stored connections win on a name collision; env
// passwords are plaintext and pass through decryptSecret unchanged.
function envConnections() {
  const raw = process.env.DB_CONNECTIONS;
  if (!raw || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c) => c && c.name && c.engine) : [];
  } catch {
    return [];
  }
}

async function loadRaw(store) {
  const stored = await store?.getSetting?.(SETTINGS_KEY);
  const list = Array.isArray(stored) ? [...stored] : [];
  const haveName = new Set(list.map((c) => c.name?.toLowerCase()));
  for (const c of envConnections()) {
    if (!haveName.has(c.name.toLowerCase())) list.push(c);
  }
  return list;
}

/** Persist the connection list, encrypting any plaintext password in place. */
export async function saveConnections(store, list) {
  const out = list.map((c) => {
    const copy = { ...c };
    if (copy.password != null && copy.password !== "") copy.password = encryptSecret(copy.password);
    return copy;
  });
  await store.setSetting(SETTINGS_KEY, out);
  return out.map(maskConnection);
}

// ── Listing (no secrets) ─────────────────────────────────────────────────────

/** Strip the password; expose only whether one is set. */
export function maskConnection(c) {
  const { password, ...rest } = c;
  return { ...rest, hasPassword: !!(password && password !== "") };
}

/** Every connection the model may target — built-in first, then user ones. No secrets. */
export async function listConnections(store) {
  const builtin = {
    name: BUILTIN_NAME,
    engine: aperioEngine(store),
    readOnly: true,
    builtin: true,
    description: "Aperio's own internal data store (memories, wiki, sessions). Read-only.",
  };
  const user = (await loadRaw(store)).map(maskConnection);
  return [builtin, ...user];
}

// ── Resolution → live driver ─────────────────────────────────────────────────

async function findConfig(store, name) {
  const list = await loadRaw(store);
  return list.find((c) => c.name?.toLowerCase() === String(name).toLowerCase()) || null;
}

/** Build a live driver for a config object (password already decrypted). */
export async function openDriver(cfg) {
  if (!ENGINES.has(cfg.engine)) fail(`unknown engine "${cfg.engine}" (expected sqlite, postgres, mysql, or mssql)`);
  const readOnly = cfg.readOnly !== false; // default ON
  if (cfg.engine === "sqlite") return openSqlite({ file: cfg.file, readOnly });
  if (cfg.engine === "postgres") return openPostgres({ ...cfg, readOnly });
  if (cfg.engine === "mssql") return openMssql({ ...cfg, readOnly }); // SQL Server (lazy)
  return openMysql({ ...cfg, readOnly }); // mysql (lazy)
}

/**
 * Resolve a connection name to a live driver.
 * @returns {Promise<{driver, readOnly, engine, name, builtin}>}
 */
export async function getDriver(store, name) {
  const wanted = String(name || "").trim();
  if (!wanted) fail("a connection `name` is required (call db_connections to list them)");

  if (wanted.toLowerCase() === BUILTIN_NAME) {
    const driver = openAperio(store, { readOnly: true });
    return { driver, readOnly: true, engine: driver.engine, name: BUILTIN_NAME, builtin: true };
  }

  const cfg = await findConfig(store, wanted);
  if (!cfg) {
    const names = (await listConnections(store)).map((c) => c.name).join(", ");
    fail(`no connection named "${wanted}". Available: ${names}.`);
  }
  const decrypted = { ...cfg, password: decryptSecret(cfg.password) };
  const driver = await openDriver(decrypted);
  return { driver, readOnly: cfg.readOnly !== false, engine: cfg.engine, name: cfg.name, builtin: false };
}

/** Open a driver from a raw (UI-supplied) config, test it, and close it. */
export async function testConnectionConfig(cfg) {
  const decrypted = { ...cfg, password: decryptSecret(cfg.password) };
  const driver = await openDriver(decrypted);
  try {
    await driver.testConnection();
    const tables = await driver.listTables();
    return { ok: true, tableCount: tables.length };
  } finally {
    await driver.close();
  }
}
