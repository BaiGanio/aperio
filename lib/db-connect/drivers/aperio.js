// lib/db-connect/drivers/aperio.js
//
// The built-in `aperio` connection (issue #170): Aperio's OWN data store,
// exposed as a named connection so the model can answer questions against it
// ("how many memories do I have", "list my wiki article slugs") through the
// same db_* tools. Read-only by default — it reuses the app's live handle
// rather than opening a second connection, so close() must be a no-op
// (ownsHandle/ownsPool = false).

import { SqliteDriver } from "./sqlite.js";
import { PostgresDriver } from "./postgres.js";

export function openAperio(store, { readOnly = true } = {}) {
  if (store?.db) return new SqliteDriver(store.db, { readOnly, ownsHandle: false });
  if (store?.pool) return new PostgresDriver(store.pool, { readOnly, ownsPool: false });
  throw Object.assign(new Error("the built-in `aperio` connection is unavailable (no live store handle)"), { userFacing: true });
}

/** Engine name of the live store, for connection listings. */
export function aperioEngine(store) {
  if (store?.db) return "sqlite";
  if (store?.pool) return "postgres";
  return "unknown";
}
