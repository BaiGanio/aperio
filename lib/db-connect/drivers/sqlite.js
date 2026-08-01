// lib/db-connect/drivers/sqlite.js
//
// SQLite driver for the database tool (issue #170). Wraps a better-sqlite3
// handle. Used two ways:
//   • openSqlite({ file, readOnly }) — opens a user's external .db file.
//   • new SqliteDriver(store.db, …)  — the built-in `aperio` connection reuses
//     the app's own live handle (ownsHandle:false, so close() is a no-op).
//
// The classifier (classify.js) gates statement KIND at the tool layer; this
// driver enforces read-only at the CONNECTION level (opened read-only, or
// runWrite refused) as defense in depth.

import Database from "better-sqlite3";

// Escape a SQLite identifier for safe interpolation into PRAGMA calls, which
// (unlike normal statements) cannot take bound parameters. We only ever pass
// names that came back from listTables(), but quote defensively regardless.
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

export class SqliteDriver {
  constructor(db, { readOnly = true, ownsHandle = false } = {}) {
    this.db = db;
    this.readOnly = readOnly;
    this.ownsHandle = ownsHandle;
    this.engine = "sqlite";
  }

  testConnection() {
    this.db.prepare("SELECT 1").get();
    return { ok: true };
  }

  listTables() {
    return this.db
      .prepare(
        `SELECT name, type FROM sqlite_master
          WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
          ORDER BY type, name`
      )
      .all()
      .map((r) => ({ name: r.name, type: r.type }));
  }

  describeTable(name) {
    // Resolve to the exact stored name (allowlist) before any interpolation.
    const row = this.db
      .prepare(
        `SELECT name, type FROM sqlite_master
          WHERE type IN ('table','view') AND name = ? COLLATE NOCASE`
      )
      .get(name);
    if (!row) return null;
    const table = row.name;
    const q = quoteIdent(table);

    const columns = this.db.prepare(`PRAGMA table_info(${q})`).all().map((c) => ({
      name: c.name,
      type: c.type || null,
      nullable: c.notnull === 0,
      default: c.dflt_value,
      primaryKey: c.pk > 0,
    }));

    const indexes = this.db.prepare(`PRAGMA index_list(${q})`).all().map((idx) => ({
      name: idx.name,
      unique: !!idx.unique,
      columns: this.db
        .prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`)
        .all()
        .map((ic) => ic.name),
    }));

    const foreignKeys = this.db.prepare(`PRAGMA foreign_key_list(${q})`).all().map((fk) => ({
      column: fk.from,
      references: { table: fk.table, column: fk.to },
      onUpdate: fk.on_update,
      onDelete: fk.on_delete,
    }));

    return { table, type: row.type, columns, indexes, foreignKeys };
  }

  runRead(sql, params = [], limit = 200) {
    const stmt = this.db.prepare(sql);
    let columns = [];
    try { columns = stmt.columns().map((c) => c.name); } catch { /* not a row-returning shape */ }
    const rows = [];
    let truncated = false;
    const iter = stmt.iterate(...params);
    for (const r of iter) {
      if (rows.length >= limit) { truncated = true; iter.return?.(); break; }
      rows.push(normalizeRow(r));
    }
    if (!columns.length && rows.length) columns = Object.keys(rows[0]);
    return { columns, rows, rowCount: rows.length, truncated };
  }

  runWrite(sql, params = []) {
    if (this.readOnly) throw Object.assign(new Error("connection is read-only"), { userFacing: true });
    const info = this.db.prepare(sql).run(...params);
    return {
      rowsAffected: info.changes,
      lastInsertRowid: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : undefined,
    };
  }

  close() {
    if (this.ownsHandle) { try { this.db.close(); } catch { /* already closed */ } }
  }
}

// BigInt (sqlite INTEGER) and Buffer (BLOB) are not JSON-serialisable as-is —
// coerce to a portable representation for the tool result.
function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "bigint") out[k] = Number(v);
    else if (Buffer.isBuffer(v)) out[k] = `<${v.length} bytes>`;
    else out[k] = v;
  }
  return out;
}

export function openSqlite({ file, readOnly = true }) {
  if (!file) throw Object.assign(new Error("sqlite connection requires a `file` path"), { userFacing: true });
  const db = new Database(file, { readonly: readOnly, fileMustExist: true });
  return new SqliteDriver(db, { readOnly, ownsHandle: true });
}
