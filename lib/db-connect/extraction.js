// lib/db-connect/extraction.js
//
// The writable destination for document extraction (issue #250, WS1). A
// clean profile has no writable connection configured, and the model must
// never be able to create one without the user seeing a confirm step first —
// so "extraction" is a reserved connection name that provisions itself, once,
// the first time a db_execute write against it is actually confirmed.
//
// The file lives under the app's own `var/` directory — the same directory
// lib/db-connect/secrets.js already uses for its machine-local key, and the
// one durable volume the supported Docker Compose deployment persists
// (docker/docker-compose.prod.yml mounts aperio_var:/app/var; nothing under
// SQLITE_PATH's directory survives a container recreation when DB_BACKEND is
// postgres and SQLITE_PATH is unset, which is exactly the supported
// production configuration).
//
// var/ alone is not enough, though: two Aperio PROFILES — separate installs
// or separate SQLITE_PATH/DATABASE_URL configs sharing one code checkout —
// would otherwise resolve to the exact same file and read/overwrite each
// other's extracted documents. The filename is therefore namespaced by a hash
// of the live store's OWN resolved identity (the sqlite file's real path, or
// the Postgres connection string) — the same signal that already determines
// which `aperio` database this profile is actually talking to, read straight
// off the live handle rather than re-derived from env vars (see
// lib/db-connect/drivers/aperio.js's store.db / store.pool duck-typing for
// the established precedent). Hashed, never embedded raw, because a
// connection string can carry a password.
//
// A `:memory:` main store needs its own special case: store.db.name is the
// literal string ":memory:" for every such store, which would otherwise
// collapse every separate in-memory profile onto the same persisted
// extraction file. Each process gets its own random, session-scoped identity
// instead — stable for the lifetime of THIS profile, so writes and reads
// still round-trip normally within one run, but never shared with any other
// run or profile.
//
// When APERIO_DB_ENCRYPT is on, the file is provisioned and reopened through
// lib/db-connect/drivers/managed-sqlite.js so extracted documents get the
// same at-rest AES-256-GCM protection as the app's own store — never a plain
// SQLite file just because it lives outside db/sqlite/store.js.
//
// This module owns only the connection's existence. Table names, columns and
// row content belong to whoever calls db_execute against it — there is no
// template layer here (that is WS3), so "schema is user-selected or
// provisioned, never path-derived" holds trivially: nothing in this file ever
// reads a document path.

import { createHash, randomBytes } from "crypto";
import { mkdirSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { SETTINGS_KEY, saveConnections } from "./registry.js";
import { createManagedSqliteFile, managedEncryptionKey } from "./drivers/managed-sqlite.js";
import { acquireLock } from "./file-lock.js";

export const EXTRACTION_CONNECTION = "extraction";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IN_MEMORY_PROCESS_TAG = randomBytes(16).toString("hex");

/**
 * A stable, credential-free identity for a Postgres connection string: host,
 * port, database name, role (username), and any explicit search_path/options
 * — never the password. Role and search_path/options are part of Postgres's
 * LOGICAL database namespace, not mere credentials: two profiles sharing the
 * same host/port/database but a different role or search_path can see
 * entirely different tables (per-role default search_path, or an explicit
 * `options=-c search_path=...`) — collapsing them onto one identity would
 * route their extraction writes into the SAME local file, exposing or
 * overwriting each other's data (P1 review finding). The password is the one
 * field genuinely excluded: hashing it in would make the extraction path
 * change on an ordinary, expected password rotation, and the stored `file`
 * would then stop matching isManagedExtractionFile's recomputed path,
 * permanently orphaning the old database for no operational reason.
 */
function postgresIdentity(connectionString) {
  try {
    const u = new URL(connectionString);
    if (/^postgres(ql)?:$/.test(u.protocol)) {
      const role = u.username || "";
      const options = u.searchParams.get("options") || "";
      const searchPath = u.searchParams.get("search_path") || "";
      return `${role}@${u.hostname}:${u.port || "5432"}${u.pathname}?options=${options}&search_path=${searchPath}`;
    }
  } catch { /* not URI-form — try libpq keyword/value form below */ }

  // libpq keyword/value form: "host=... port=... dbname=... user=... password=... options=...".
  const kv = {};
  for (const pair of connectionString.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (kv.host || kv.dbname) {
    return `${kv.user || ""}@${kv.host || "localhost"}:${kv.port || "5432"}/${kv.dbname || ""}?options=${kv.options || ""}`;
  }

  // Unrecognized form: still resolve to SOMETHING stable (never collapse
  // every unparseable string onto one shared file) rather than throwing;
  // credential rotation may change identity here, but that's strictly no
  // worse than before this function existed.
  return connectionString;
}

/** The live store's own resolved database identity — never the raw value,
 *  since a Postgres connection string carries its password.
 *
 *  For sqlite, `store._encryptSourcePath` (db/sqlite/store.js) — the real
 *  SQLITE_PATH the store was opened from — is used in preference to
 *  `store.db.name`. When APERIO_DB_ENCRYPT is on, `store.db.name` is the
 *  live handle's decrypted TEMP path (prepareDatabase's tmpdir() scratch
 *  file), not the real database path; toggling encryption would otherwise
 *  change this identity, making every previously-provisioned extraction row
 *  stop matching isManagedExtractionFile and permanently reserved-name-
 *  collide (P1 review finding). `_encryptSourcePath` is set unconditionally
 *  by SqliteStore.init() regardless of encryption mode, so it stays stable
 *  across the toggle; `store.db.name` remains the fallback for store shapes
 *  that don't set it (e.g. test doubles). */
function profileTag(store) {
  const dbName = store?._encryptSourcePath ?? store?.db?.name;
  const identity = dbName === ":memory:" ? `memory-process:${IN_MEMORY_PROCESS_TAG}`
    : dbName != null ? `sqlite:${dbName}`
    : store?.pool?.options?.connectionString ? `postgres:${postgresIdentity(store.pool.options.connectionString)}`
    // No live handle to read an identity from (e.g. a not-yet-initialized
    // store): fall back to whatever env signal would resolve one, rather
    // than collapsing every unresolvable profile onto one shared file.
    : `env:${process.env.DATABASE_URL || process.env.SQLITE_PATH || ""}`;
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** Absolute path of this profile's extraction file, under the app's
 *  persisted var/ dir, namespaced so distinct profiles never collide. */
export function extractionDbPath(store) {
  return join(ROOT, "var", "extraction", `${profileTag(store)}.db`);
}

/**
 * Remove a managed extraction file and its sidecars (WAL/SHM/journal) from
 * disk. Deleting only the settings row (the generic connection-delete
 * endpoint's default behavior) leaves the file itself untouched: the data
 * stays readable at rest indefinitely, and a later confirmed write against
 * "extraction" silently re-provisions the exact same path — resurrecting
 * everything the user believed they'd removed. Called only for a row that
 * has already passed isManagedExtractionFile, so `file` is always this
 * profile's own managed path, never a user-supplied one.
 *
 * Holds the SAME cross-process lock managed-sqlite.js's open/close lifecycle
 * uses (keyed by `${file}.lock`) for the full duration of the unlinks. Aperio
 * explicitly supports several MCP processes per agent session; without this
 * lock, a concurrent openManagedSqlite() elsewhere could still have the file
 * decrypted and in use when it's unlinked here, and that process's own close()
 * would then re-encrypt its in-memory state straight back to the now-deleted
 * path — silently resurrecting the file the user just deleted (P1 review
 * finding).
 *
 * Only a missing file (ENOENT — already gone) is swallowed. Anything else
 * (EACCES, EBUSY, a disk I/O error) is thrown: the caller must not report a
 * successful wipe of sensitive data when the data is, in fact, still there.
 *
 * If the containing var/extraction/ directory itself is already gone (the
 * user removed it by hand, or an earlier delete already cleaned it up),
 * acquireLock's own openSync('wx') fails with ENOENT before it can even
 * create the lock file — there's nothing left to protect a lock over. That
 * ENOENT is treated the same as the missing-file case above: nothing to
 * delete, not a failure. Without this, the DELETE endpoint would 500 and
 * leave a permanently undeletable stale connection row pointing at a
 * directory that no longer exists (P2 review finding).
 */
export async function deleteExtractionFile(file) {
  let release;
  try {
    release = await acquireLock(`${file}.lock`);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  try {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { unlinkSync(file + suffix); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  } finally {
    release();
  }
}

/**
 * A row only counts as the connection this module manages if it carries the
 * `provisioned` marker this module itself writes. Matching on name alone
 * would let an unrelated connection that happens to be named "extraction"
 * (headless DB_CONNECTIONS seed, or one created before this reserved name
 * existed) be silently treated as the destination — redirecting document
 * writes into a database the user never intended, or, if that unrelated
 * connection is read-only, blocking self-provisioning entirely while
 * reporting a misleading "read-only" error.
 */
const isManaged = (c) => c?.name?.toLowerCase() === EXTRACTION_CONNECTION && c.provisioned === true;

/**
 * True only when `cfg` is genuinely this module's own managed row — its file
 * path is the exact one this profile would derive for itself. `provisioned`
 * is stored, user-reachable data (a raw `PUT /api/settings/db.connections` or
 * a headless `DB_CONNECTIONS` seed can both set it), so it must never be
 * trusted alone before routing a connection through the encryption-aware
 * managed path — that path will happily encrypt-in-place whatever plaintext
 * sqlite file it's pointed at with Aperio's own key. Recomputing the expected
 * path here and requiring an exact match closes that off regardless of which
 * write path let the forged flag through.
 */
export function isManagedExtractionFile(cfg, store) {
  return cfg?.engine === "sqlite" && cfg?.name?.toLowerCase() === EXTRACTION_CONNECTION
    && cfg?.file === extractionDbPath(store);
}

/** The managed row, or null when not yet provisioned. Ignores any unrelated,
 *  unmanaged connection that happens to share the reserved name. */
export async function findExtractionConnection(store) {
  const list = (await store.getSetting(SETTINGS_KEY)) || [];
  return list.find(isManaged) || null;
}

const collisionError = (name) => Object.assign(
  new Error(
    `"${EXTRACTION_CONNECTION}" is reserved for Aperio's self-provisioned document-extraction database, ` +
    `but an existing connection named "${name}" already uses it and is not the managed one. Rename that ` +
    `connection in Settings → Database connections to free the reserved name.`
  ),
  { userFacing: true }
);

/**
 * Provision the extraction connection if it does not already exist.
 * Idempotent: a second call with the managed connection already registered
 * returns the existing row unchanged and creates nothing — the "destination
 * already exists" case is a no-op, not an error. A same-named connection that
 * is NOT the managed one is a collision, not a match, and is rejected rather
 * than reused or duplicated.
 *
 * Reuse requires isManagedExtractionFile too, not just the `provisioned`
 * marker isManaged() checks: a settings write can land between an already-
 * confirmed write's revalidation and this call (executeTool's own claim
 * step), inserting a forged `provisioned: true` row under this reserved name
 * with an attacker-chosen file. Without the path check, that row would be
 * returned as-is here, then openDriver's OWN isManagedExtractionFile check
 * would correctly refuse the encrypting managed path for it and fall back to
 * the plain driver — silently redirecting the already-confirmed SQL onto the
 * attacker's file instead of failing loudly.
 */
export async function provisionExtractionConnection(store) {
  const list = (await store.getSetting(SETTINGS_KEY)) || [];
  const existing = list.find((c) => c.name?.toLowerCase() === EXTRACTION_CONNECTION);
  if (existing) {
    if (isManaged(existing) && isManagedExtractionFile(existing, store)) return existing;
    throw collisionError(existing.name);
  }

  const file = extractionDbPath(store);
  mkdirSync(dirname(file), { recursive: true });
  await createManagedSqliteFile(file, managedEncryptionKey());

  const connection = { name: EXTRACTION_CONNECTION, engine: "sqlite", file, readOnly: false, provisioned: true };
  await saveConnections(store, [...list, connection]);
  return connection;
}
