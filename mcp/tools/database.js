// mcp/tools/database.js
// Database tools (issue #170): db_connections, db_schema, db_query, db_execute.
// A generic SQL client surface over the user's external databases (SQLite /
// Postgres / MySQL / SQL Server) AND Aperio's own store, through named
// connections.
// Reads run freely; writes/DDL route through confirm-before-write.

import { z } from "zod";
import {
  connectionsHandler,
  schemaHandler,
  queryHandler,
  executeHandler,
} from "../../lib/handlers/database/databaseHandlers.js";

const createBoundHandlers = (ctx) => ({
  connections: (args) => connectionsHandler(ctx, args),
  schema:      (args) => schemaHandler(ctx, args),
  query:       (args) => queryHandler(ctx, args),
  execute:     (args) => executeHandler(ctx, args),
});

const TOOLS = [
  {
    name: "db_connections",
    description:
      "List the database connections available to query. Returns each connection's {name, engine, readOnly} " +
      "— never any password or secret. Always includes the built-in `aperio` connection (Aperio's own internal " +
      "store: memories, wiki, sessions — read-only). Call this FIRST when you don't know which connections exist " +
      "or what their names are; the name is what you pass to db_schema / db_query / db_execute. Connections are " +
      "configured by the user in Settings → Database connections, never passed as tool arguments.",
    schema: {},
    getHandler: (h) => h.connections,
  },
  {
    name: "db_schema",
    description:
      "Introspect a connection's structure. With no `table`, lists every table and view. With a `table`, returns " +
      "its columns (name, type, nullable, default, primary key), indexes, and foreign keys. Use this to learn the " +
      "shape of the data before writing a db_query — never guess column names. Read-only and always safe to call.",
    schema: {
      connection: z.string().describe("Connection name from db_connections (e.g. 'aperio' or a user connection)."),
      table: z.string().optional().describe("A table/view name to describe. Omit to list all tables and views."),
    },
    getHandler: (h) => h.schema,
  },
  {
    name: "db_query",
    description:
      "Run ONE read-only SQL statement and return the rows. Accepts SELECT / WITH / EXPLAIN / PRAGMA / SHOW / " +
      "DESCRIBE only — it REJECTS INSERT/UPDATE/DELETE and DDL (use db_execute for those) and rejects multi-statement " +
      "batches. Results are capped (default 200 rows, max 1000) and flagged `truncated` when more exist; raise `limit` " +
      "or add your own LIMIT/WHERE to narrow. ALWAYS pass user-supplied or variable values through `params` " +
      "(positional ? / $1 placeholders) — never string-concatenate them into `sql`.",
    schema: {
      connection: z.string().describe("Connection name from db_connections."),
      sql: z.string().describe("A single read statement, e.g. 'SELECT * FROM users WHERE id = ?'."),
      params: z.array(z.any()).optional().describe("Positional bind parameters for the placeholders in `sql`."),
      limit: z.number().min(1).max(1000).optional().describe("Max rows to return (default 200)."),
    },
    getHandler: (h) => h.query,
  },
  {
    name: "db_execute",
    description:
      "Run ONE writing or schema statement (INSERT/UPDATE/DELETE or CREATE/ALTER/DROP/TRUNCATE) on a WRITABLE " +
      "connection. SAFETY: confirm-before-write. Call this tool ONCE to PROPOSE the statement; the user is then " +
      "shown a confirm button and the SERVER runs it when they click. Do NOT set `confirmation_token` yourself and " +
      "do NOT call this tool again — just propose, then end your turn. It rejects read statements (use db_query), " +
      "multi-statement batches, and read-only connections (including the built-in `aperio`). ALWAYS pass values " +
      "through `params` (placeholders), never string-concatenated into `sql`.",
    schema: {
      // connection/sql are required when PROPOSING (enforced in the handler), but
      // optional in the schema because the server's confirm step re-invokes this
      // tool with only `confirmation_token`.
      connection: z.string().optional().describe("A writable connection name from db_connections."),
      sql: z.string().optional().describe("A single write/DDL statement, e.g. 'UPDATE users SET active = ? WHERE id = ?'."),
      params: z.array(z.any()).optional().describe("Positional bind parameters for the placeholders in `sql`."),
      confirmation_token: z.string().optional().describe(
        "RESERVED for the server's confirm flow — do NOT set this. The user's confirm button click triggers execution server-side."
      ),
    },
    getHandler: (h) => h.execute,
  },
];

export function register(server, ctx) {
  const handlers = createBoundHandlers(ctx);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: z.object(tool.schema) },
      tool.getHandler(handlers)
    );
  }
}
