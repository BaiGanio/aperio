// lib/db-connect/drivers/mssql.js
//
// Microsoft SQL Server driver for the database tool (issue #170). The `mssql`
// package (which wraps tedious) is a bundled dependency but still imported
// lazily here, so it only loads when a SQL Server connection is actually used
// (and degrades to a clear message if the package is ever missing).
//
// SQL Server has no simple `BEGIN TRANSACTION READ ONLY` like Postgres, so a
// read-only connection is enforced at the tool/classifier level (runWrite is
// refused) rather than at the connection level. The row cap is enforced by
// streaming the result and cancelling once the cap is reached, which works for
// arbitrary SELECTs (including ones with ORDER BY, where a TOP/subquery wrapper
// would be invalid).
//
// Parameter binding: positional `params` are bound as named inputs @p0, @p1, …
// so SQL Server statements should reference values as @p0 (etc.).

async function loadMssql() {
  try {
    const mod = await import("mssql");
    return mod.default ?? mod;
  } catch {
    throw Object.assign(
      new Error("SQL Server support requires the `mssql` package — run `npm install mssql`, then restart Aperio."),
      { userFacing: true }
    );
  }
}

const bindInputs = (request, params) => {
  params.forEach((v, i) => request.input(`p${i}`, v));
  return request;
};

export class MssqlDriver {
  constructor(pool, { readOnly = true, database } = {}) {
    this.pool = pool;
    this.readOnly = readOnly;
    this.database = database;
    this.engine = "mssql";
  }

  async testConnection() {
    await this.pool.request().query("SELECT 1 AS ok");
    return { ok: true };
  }

  async listTables() {
    const { recordset } = await this.pool.request().query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type
         FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME`
    );
    return recordset.map((r) => ({ name: r.name, type: /VIEW/i.test(r.type) ? "view" : "table" }));
  }

  async describeTable(name) {
    const cols = (
      await this.pool.request().input("t", name).query(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
           FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @t ORDER BY ORDINAL_POSITION`
      )
    ).recordset;
    if (cols.length === 0) return null;

    const pk = new Set(
      (
        await this.pool.request().input("t", name).query(
          `SELECT kcu.COLUMN_NAME
             FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
               ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @t`
        )
      ).recordset.map((r) => r.COLUMN_NAME)
    );

    const fks = (
      await this.pool.request().input("t", name).query(
        `SELECT fk_col.COLUMN_NAME AS col, pk_tab.TABLE_NAME AS ref_table, pk_col.COLUMN_NAME AS ref_column
           FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk_col ON fk_col.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
           JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk_col ON pk_col.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
           JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS pk_tab ON pk_tab.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
          WHERE fk_col.TABLE_NAME = @t`
      )
    ).recordset.map((r) => ({ column: r.col, references: { table: r.ref_table, column: r.ref_column } }));

    return {
      table: name,
      columns: cols.map((c) => ({
        name: c.COLUMN_NAME,
        type: c.DATA_TYPE,
        nullable: c.IS_NULLABLE === "YES",
        default: c.COLUMN_DEFAULT,
        primaryKey: pk.has(c.COLUMN_NAME),
      })),
      indexes: [],
      foreignKeys: fks,
    };
  }

  runRead(sql, params = [], limit = 200) {
    const cap = Math.max(1, Math.floor(limit));
    return new Promise((resolve, reject) => {
      const request = bindInputs(this.pool.request(), params);
      request.stream = true;
      const rows = [];
      let truncated = false;
      let columns = [];
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve({ columns, rows, rowCount: rows.length, truncated }); } };

      request.on("recordset", (cols) => { columns = Object.keys(cols); });
      request.on("row", (row) => {
        if (rows.length >= cap) { truncated = true; request.cancel(); return; }
        rows.push(normalizeRow(row));
      });
      request.on("error", (err) => { if (!settled) { settled = true; reject(err); } });
      request.on("done", finish);
      request.query(sql);
    });
  }

  async runWrite(sql, params = []) {
    if (this.readOnly) throw Object.assign(new Error("connection is read-only"), { userFacing: true });
    const result = await bindInputs(this.pool.request(), params).query(sql);
    const rowsAffected = Array.isArray(result.rowsAffected)
      ? result.rowsAffected.reduce((a, b) => a + b, 0)
      : (result.rowsAffected ?? 0);
    return { rowsAffected };
  }

  async close() { try { await this.pool.close(); } catch { /* already closed */ } }
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v)) out[k] = `<${v.length} bytes>`;
    else out[k] = v;
  }
  return out;
}

export async function openMssql({ host, port, database, user, password, readOnly = true, encrypt }) {
  const mssql = await loadMssql();
  const pool = await new mssql.ConnectionPool({
    server: host,
    port: port ? Number(port) : 1433,
    database,
    user,
    password,
    pool: { max: 2 },
    options: {
      // encrypt defaults ON (Azure / modern SQL Server); trustServerCertificate
      // lets a local/self-signed server connect without a CA-issued cert.
      encrypt: encrypt !== false,
      trustServerCertificate: true,
    },
    connectionTimeout: 8000,
  }).connect();
  return new MssqlDriver(pool, { readOnly, database });
}
