// lib/db-connect/drivers/mysql.js
//
// MySQL driver for the database tool (issue #170). `mysql2` is a bundled
// dependency but still imported lazily here, so the module only loads the
// driver when a MySQL connection is actually used (and degrades to a clear
// message if the package is ever missing).
//
// Reads run inside a READ ONLY transaction; the row cap is applied with a
// LIMIT wrapper subquery so it is enforced server-side.

async function loadMysql() {
  try {
    const mod = await import("mysql2/promise");
    return mod.default ?? mod;
  } catch {
    throw Object.assign(
      new Error("MySQL support requires the `mysql2` package — run `npm install mysql2`, then restart Aperio."),
      { userFacing: true }
    );
  }
}

export class MysqlDriver {
  constructor(pool, { readOnly = true, database } = {}) {
    this.pool = pool;
    this.readOnly = readOnly;
    this.database = database;
    this.engine = "mysql";
  }

  async testConnection() {
    const conn = await this.pool.getConnection();
    try { await conn.query("SELECT 1"); return { ok: true }; }
    finally { conn.release(); }
  }

  async listTables() {
    const [rows] = await this.pool.query(
      `SELECT table_name AS name, table_type AS type
         FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [this.database]
    );
    return rows.map((r) => ({
      name: r.name ?? r.NAME ?? r.table_name,
      type: /VIEW/i.test(r.type ?? r.TYPE ?? "") ? "view" : "table",
    }));
  }

  async describeTable(name) {
    const [columns] = await this.pool.query(
      `SELECT column_name, data_type, is_nullable, column_default, column_key
         FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [this.database, name]
    );
    if (columns.length === 0) return null;

    const [fks] = await this.pool.query(
      `SELECT column_name AS col, referenced_table_name AS ref_table, referenced_column_name AS ref_column
         FROM information_schema.key_column_usage
        WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [this.database, name]
    );
    const [idx] = await this.pool.query(
      `SELECT index_name AS name, non_unique, column_name AS col
         FROM information_schema.statistics
        WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index`,
      [this.database, name]
    );
    const indexMap = new Map();
    for (const r of idx) {
      const key = r.name ?? r.NAME;
      if (!indexMap.has(key)) indexMap.set(key, { name: key, unique: (r.non_unique ?? r.NON_UNIQUE) === 0, columns: [] });
      indexMap.get(key).columns.push(r.col ?? r.COL);
    }

    const get = (r, k) => r[k] ?? r[k.toUpperCase()];
    return {
      table: name,
      columns: columns.map((c) => ({
        name: get(c, "column_name"),
        type: get(c, "data_type"),
        nullable: get(c, "is_nullable") === "YES",
        default: get(c, "column_default"),
        primaryKey: get(c, "column_key") === "PRI",
      })),
      indexes: [...indexMap.values()],
      foreignKeys: fks.map((r) => ({
        column: get(r, "col"),
        references: { table: get(r, "ref_table"), column: get(r, "ref_column") },
      })),
    };
  }

  async runRead(sql, params = [], limit = 200) {
    const cap = Math.max(1, Math.floor(limit));
    const conn = await this.pool.getConnection();
    try {
      await conn.query("START TRANSACTION READ ONLY");
      const [rows, fields] = await conn.query(
        { sql: `SELECT * FROM (${sql}) AS _aperio_sub LIMIT ?`, rowsAsArray: false },
        [...params, cap + 1]
      );
      let truncated = false;
      let out = rows;
      if (out.length > cap) { truncated = true; out = out.slice(0, cap); }
      return {
        columns: (fields ?? []).map((f) => f.name),
        rows: out.map(normalizeRow),
        rowCount: out.length,
        truncated,
      };
    } finally {
      await conn.query("ROLLBACK").catch(() => {});
      conn.release();
    }
  }

  async runWrite(sql, params = []) {
    if (this.readOnly) throw Object.assign(new Error("connection is read-only"), { userFacing: true });
    const [result] = await this.pool.query(sql, params);
    return { rowsAffected: result.affectedRows ?? 0, insertId: result.insertId };
  }

  async close() { try { await this.pool.end(); } catch { /* already ended */ } }
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) out[k] = `<${v.length} bytes>`;
    else out[k] = v;
  }
  return out;
}

export async function openMysql({ host, port, database, user, password, readOnly = true }) {
  const mysql = await loadMysql();
  const pool = mysql.createPool({
    host, port: port ? Number(port) : 3306, database, user, password,
    connectionLimit: 2, connectTimeout: 8000,
  });
  return new MysqlDriver(pool, { readOnly, database });
}
