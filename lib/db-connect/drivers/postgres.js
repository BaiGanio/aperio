// lib/db-connect/drivers/postgres.js
//
// Postgres driver for the database tool (issue #170). Wraps a `pg` Pool. Used
// two ways:
//   • openPostgres({ host, port, database, user, password, readOnly }) — a
//     user's external server.
//   • new PostgresDriver(store.pool, …) — the built-in `aperio` connection
//     reuses the app's own pool (ownsPool:false, so close() is a no-op).
//
// Reads always run inside a READ ONLY transaction with a server-side cursor, so
// the row cap is enforced at the database (never pulling an unbounded result
// into memory). Writes require a non-read-only connection.

import pg from "pg";
const { Pool } = pg;

export class PostgresDriver {
  constructor(pool, { readOnly = true, ownsPool = false } = {}) {
    this.pool = pool;
    this.readOnly = readOnly;
    this.ownsPool = ownsPool;
    this.engine = "postgres";
  }

  async testConnection() {
    const client = await this.pool.connect();
    try { await client.query("SELECT 1"); return { ok: true }; }
    finally { client.release(); }
  }

  async listTables() {
    const { rows } = await this.pool.query(
      `SELECT table_schema AS schema, table_name AS name, table_type AS type
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name`
    );
    return rows.map((r) => ({
      name: r.name,
      schema: r.schema,
      type: r.type === "VIEW" ? "view" : "table",
    }));
  }

  async describeTable(name) {
    const columns = (
      await this.pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = $1
            AND table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY ordinal_position`,
        [name]
      )
    ).rows;
    if (columns.length === 0) return null;

    const pkCols = new Set(
      (
        await this.pool.query(
          `SELECT kcu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name
              AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1`,
          [name]
        )
      ).rows.map((r) => r.column_name)
    );

    const foreignKeys = (
      await this.pool.query(
        `SELECT kcu.column_name AS column, ccu.table_name AS ref_table, ccu.column_name AS ref_column
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           JOIN information_schema.constraint_column_usage ccu
             ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1`,
        [name]
      )
    ).rows.map((r) => ({ column: r.column, references: { table: r.ref_table, column: r.ref_column } }));

    const indexes = (
      await this.pool.query(
        `SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE tablename = $1`,
        [name]
      )
    ).rows.map((r) => ({ name: r.name, unique: /CREATE UNIQUE/i.test(r.def), definition: r.def }));

    return {
      table: name,
      columns: columns.map((c) => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === "YES",
        default: c.column_default,
        primaryKey: pkCols.has(c.column_name),
      })),
      indexes,
      foreignKeys,
    };
  }

  async runRead(sql, params = [], limit = 200) {
    const cap = Math.max(1, Math.floor(limit));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query({ text: `DECLARE _aperio_c NO SCROLL CURSOR FOR ${sql}`, values: params });
      const res = await client.query(`FETCH FORWARD ${cap + 1} FROM _aperio_c`);
      let rows = res.rows;
      let truncated = false;
      if (rows.length > cap) { truncated = true; rows = rows.slice(0, cap); }
      const columns = res.fields.map((f) => f.name);
      return { columns, rows: rows.map(normalizeRow), rowCount: rows.length, truncated };
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  }

  async runWrite(sql, params = []) {
    if (this.readOnly) throw Object.assign(new Error("connection is read-only"), { userFacing: true });
    const client = await this.pool.connect();
    try {
      const res = await client.query({ text: sql, values: params });
      return { rowsAffected: res.rowCount ?? 0 };
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.ownsPool) { try { await this.pool.end(); } catch { /* already ended */ } }
  }
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) out[k] = `<${v.length} bytes>`;
    else out[k] = v;
  }
  return out;
}

export function openPostgres({ host, port, database, user, password, readOnly = true }) {
  const pool = new Pool({
    host, port: port ? Number(port) : 5432, database, user, password,
    max: 2,
    connectionTimeoutMillis: 8000,
    statement_timeout: 30000,
  });
  return new PostgresDriver(pool, { readOnly, ownsPool: true });
}
