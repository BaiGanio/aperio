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
import { existsSync, mkdirSync, renameSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { SETTINGS_KEY, saveConnections } from "./registry.js";
import { createManagedSqliteFile, managedEncryptionKey } from "./drivers/managed-sqlite.js";
import { acquireLock } from "./file-lock.js";

export const EXTRACTION_CONNECTION = "extraction";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const IN_MEMORY_PROCESS_TAG = randomBytes(16).toString("hex");

/** The role node-postgres resolves for a connection string whose URL omits a
 *  username: PGUSER, then the OS user (the same sources pg's own defaults use —
 *  PGUSER first, then USER on POSIX / USERNAME on Windows). Two processes
 *  sharing one checkout and a credential-less `postgresql://host/db` URL but
 *  different implicit roles connect as different Postgres users and must never
 *  collapse onto the same extraction file (P1 review finding). */
function implicitRole() {
  if (process.env.PGUSER) return process.env.PGUSER;
  return process.platform === "win32" ? process.env.USERNAME || "" : process.env.USER || "";
}

// libpq backend-option names that change the LOGICAL namespace a connection
// operates in — the set of tables unqualified queries see. Everything else a
// URL can stuff into `options` (statement_timeout, logging, application
// metadata) affects behavior, not namespace, and must never alter the
// extraction identity (P2 review finding): editing or reordering such options
// would otherwise orphan an already-provisioned extraction row behind a
// reserved-name collision for no operational reason.
const NAMESPACE_OPTIONS = new Set(["search_path"]);

/** Strip surrounding single/double quotes from a libpq option value — the
 *  canonical spelling used in the identity string. */
function canonicalOptionValue(value) {
  const v = value.trim();
  if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === "'" || v[0] === '"')) return v.slice(1, -1);
  return v;
}

/** Split a libpq `options` blob on whitespace, honoring single/double quotes:
 *  a quoted value may legitimately contain spaces (`-c search_path="tenant a"`),
 *  and a naive whitespace split would truncate it at the space — collapsing two
 *  distinct namespaces onto one shared prefix and, hashed, onto one extraction
 *  file. Quotes are stripped here; callers see the raw value text. */
function tokenizeOptions(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Reduce a libpq `options` blob to just its namespace-affecting settings,
 *  canonicalized so that editing, adding or reordering non-namespace entries
 *  never changes the extraction identity. libpq passes the blob to the backend
 *  as ordered `-c name=value` arguments, and a repeated name is applied in
 *  order, so the LAST assignment is the effective one — the only one that
 *  belongs in the identity. Accepts the `-c key=value`, `--key=value` (and
 *  `--set key=value`) and bare `key=value` spellings. */
function canonicalNamespaceOptions(raw) {
  if (!raw) return "";
  const effective = new Map();
  const tokens = tokenizeOptions(String(raw));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let assignment;
    if (token === "-c" || token === "--set") {
      assignment = tokens[i + 1];
      if (assignment !== undefined) i++;
    } else if (token.startsWith("--")) {
      assignment = token.slice(2);
    } else if (token.startsWith("-c")) {
      // Attached short-option form, e.g. `-csearch_path=tenant_a`: libpq
      // strips the leading hyphen(s) and treats the rest as name=value. A
      // naive "anything else starting with - is a flag" skip would drop the
      // assignment and collapse `-csearch_path=tenant_a` /
      // `-csearch_path=tenant_b` onto one identity — different namespaces
      // sharing one extraction file (P1 review finding).
      assignment = token.slice(2);
    } else if (token.startsWith("-") || !token.includes("=")) {
      continue; // other single-dash flags / bare words aren't key=value assignments
    } else {
      assignment = token;
    }
    if (!assignment) continue;
    const eq = assignment.indexOf("=");
    if (eq <= 0) continue;
    const key = assignment.slice(0, eq);
    if (!NAMESPACE_OPTIONS.has(key)) continue;
    effective.set(key, canonicalOptionValue(assignment.slice(eq + 1)));
  }
  return [...effective].map(([key, value]) => `${key}=${value}`).join("&");
}

/** Structured, credential-free fields of a Postgres connection string — the
 *  fields that decide which logical namespace it operates in. The password is
 *  excluded. Returns null when the string is not a recognized Postgres form
 *  (callers then hash the raw string, never collapsing every unparseable value
 *  onto one shared file). URI-form `host`/`port`/`database` keep the URL's
 *  literal spelling; the libpq keyword/value form applies libpq's "localhost"
 *  default for a missing host. */
function parsePostgres(connectionString) {
  try {
    const u = new URL(connectionString);
    if (/^postgres(ql)?:$/.test(u.protocol)) {
      return {
        roleLiteral: u.username || "",
        host: u.hostname,
        port: u.port || "5432",
        database: u.pathname,
        options: u.searchParams.get("options") || "",
        searchPath: u.searchParams.get("search_path") || "",
      };
    }
  } catch { /* not URI-form — try libpq keyword/value form below */ }

  // libpq keyword/value form: "host=... port=... dbname=... user=... options=...".
  const kv = {};
  for (const pair of connectionString.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (kv.host || kv.dbname) {
    return {
      roleLiteral: kv.user || "",
      host: kv.host || "localhost",
      port: kv.port || "5432",
      database: `/${kv.dbname || ""}`,
      options: kv.options || "",
      searchPath: "",
    };
  }
  return null;
}

/** A stable, credential-free identity for a Postgres connection string: host,
 *  port, database, role, and namespace-affecting options — never the password.
 *  Role and search_path are part of Postgres's LOGICAL database namespace, not
 *  mere credentials: two profiles sharing the same host/port/database but a
 *  different role or search_path can see entirely different tables (per-role
 *  default search_path, or an explicit `options=-c search_path=...`) —
 *  collapsing them onto one identity would route their extraction writes into
 *  the SAME local file, exposing or overwriting each other's data (P1 review
 *  finding).
 *
 * The role is the RESOLVED one: when the URL omits a username, node-postgres
 * connects as PGUSER / the OS user, so the identity resolves the same way
 * rather than trusting the literal (empty) URL field — otherwise two processes
 * sharing a credential-less URL but different implicit roles would still
 * collapse onto one file (P1 review finding). Only namespace-affecting options
 * are hashed, canonicalized (P2 review finding). The password is the one field
 * genuinely excluded: hashing it in would make the extraction path change on
 * an ordinary, expected password rotation, and the stored `file` would then
 * stop matching isManagedExtractionFile's recomputed path, permanently
 * orphaning the old database for no operational reason.
 */
function postgresIdentity(connectionString, { resolveRole = true } = {}) {
  const parsed = parsePostgres(connectionString);
  if (!parsed) return connectionString; // unrecognized form: stable, never collapsed
  const role = resolveRole ? (parsed.roleLiteral || implicitRole()) : parsed.roleLiteral;
  const options = canonicalNamespaceOptions(parsed.options);
  const searchPath = canonicalOptionValue(parsed.searchPath);
  return `${role}@${parsed.host}:${parsed.port}${parsed.database}?options=${options}&search_path=${searchPath}`;
}

/** The extraction identity shipped BEFORE the role/namespace expansion
 *  (host/port/database only — 02e7c21). Rows provisioned by that build store a
 *  `file` hashed from THIS string; without a legacy-adoption path, upgrading a
 *  profile whose URL carries a username or options would make
 *  isManagedExtractionFile reject the profile's own row and every extraction
 *  operation would report a reserved-name collision, orphaning all existing
 *  extracted data (P1 review finding). Frozen historical format — do not
 *  change, or the adoption check below silently stops recognizing old rows. */
function legacyV0Identity(connectionString) {
  const parsed = parsePostgres(connectionString);
  if (!parsed) return connectionString;
  return `${parsed.host}:${parsed.port}${parsed.database}`;
}

/** The extraction identity shipped in the first identity-expansion build
 *  (c42ae99): the LITERAL URL role (empty when omitted — before implicit-role
 *  resolution existed) plus the FULL raw `options` and `search_path` values
 *  (before P2 canonicalization filtered behavior-only options). Rows
 *  provisioned under that build must stay recognized too, or the same
 *  reserved-name collision would orphan them a second time. Frozen historical
 *  format — do not change. */
function legacyV1Identity(connectionString) {
  try {
    const u = new URL(connectionString);
    if (/^postgres(ql)?:$/.test(u.protocol)) {
      const role = u.username || "";
      const options = u.searchParams.get("options") || "";
      const searchPath = u.searchParams.get("search_path") || "";
      return `${role}@${u.hostname}:${u.port || "5432"}${u.pathname}?options=${options}&search_path=${searchPath}`;
    }
  } catch { /* not URI-form — try libpq keyword/value form below */ }

  const kv = {};
  for (const pair of connectionString.trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (kv.host || kv.dbname) {
    return `${kv.user || ""}@${kv.host || "localhost"}:${kv.port || "5432"}/${kv.dbname || ""}?options=${kv.options || ""}`;
  }
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
  return hashTag(identity);
}

const hashTag = (identity) => createHash("sha256").update(identity).digest("hex").slice(0, 16);

/** Absolute path of this profile's extraction file, under the app's
 *  persisted var/ dir, namespaced so distinct profiles never collide. */
export function extractionDbPath(store) {
  return join(ROOT, "var", "extraction", `${profileTag(store)}.db`);
}

/** Legacy hash tags for a Postgres store — the identities this profile could
 *  have provisioned under before this change (v0 host/port/database, and the
 *  v1 literal-role/raw-options build). Empty for non-Postgres stores, whose
 *  identity never changed (SQLite and the env fallback hash the same signal in
 *  every build). */
function legacyProfileTags(store) {
  const connectionString = store?.pool?.options?.connectionString;
  if (!connectionString) return [];
  const ids = [legacyV0Identity(connectionString), legacyV1Identity(connectionString)];
  return [...new Set(ids)].map((id) => hashTag(`postgres:${id}`));
}

/** Absolute paths of the extraction files this profile may have provisioned
 *  under PREVIOUS identities (v0 and v1). isManagedExtractionFile's adoption
 *  check accepts these in addition to the current path; exported for tests.
 *  For stores whose identity never changed (SQLite, the env fallback, or a
 *  Postgres URL that happens to hash identically) this is just the current
 *  path. */
export function legacyExtractionDbPaths(store) {
  const tags = legacyProfileTags(store);
  return tags.length ? tags.map((tag) => join(ROOT, "var", "extraction", `${tag}.db`)) : [extractionDbPath(store)];
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
  if (cfg?.engine !== "sqlite" || cfg?.name?.toLowerCase() !== EXTRACTION_CONNECTION) return false;
  if (cfg?.file === extractionDbPath(store)) return true;
  // Legacy adoption (P1 review finding): rows provisioned before the identity
  // expansion hashed host/port/database (v0) or literal-role + raw options
  // (v1) instead of today's resolved-role, canonicalized form, so their saved
  // `file` points at one of those older paths. Rejecting them would orphan
  // every pre-existing extracted document behind a reserved-name collision.
  // The acceptance set is derived from THIS profile's own connection string
  // (or its ancestors) and stays constrained to var/extraction/<hash>.db, so
  // the forged-`provisioned` TOCTOU protection below is unchanged: an
  // attacker-chosen path still never matches. V1-adopted rows are migrated to
  // the current path at the FIRST touch — provisioning or any connection
  // resolution (see adoptManagedExtractionRow) — because their saved hash
  // depends on the raw options and would otherwise orphan on a later
  // behavior-only option edit; v0 rows stay in place here — their identity is
  // stable, and a v0 path may be legitimately shared by several upgraded
  // profiles.
  return legacyExtractionDbPaths(store).includes(cfg?.file);
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

/** Migrate a row adopted from the intermediate (v1) identity to this
 *  profile's CURRENT identity path. v1 hashed the raw `options` value, so a
 *  v1-adopted row's saved file is stable only while the options stay
 *  byte-identical; the current path hashes only canonical namespace-affecting
 *  options, so it survives behavior-only edits. Without the migration, a
 *  later `statement_timeout`-style edit would change the recomputed v1 path,
 *  isManagedExtractionFile would reject the profile's own row, and
 *  provisioning would throw a reserved-name collision — orphaning the adopted
 *  extraction data (P1 review finding).
 *
 * The file is MOVED (never copied) under the same cross-process lock the rest
 * of the managed lifecycle uses, and only when the destination does not
 * already hold a real file (a pre-existing destination is never overwritten —
 * the row then stays adopted in place instead). After migration the row is
 * indistinguishable from a freshly provisioned one. v0-adopted rows are
 * deliberately NOT migrated: their identity is host/port/database only, which
 * is stable under option edits, and a v0 path may be legitimately shared by
 * several upgraded profiles — a rename would silently hand that shared file to
 * whichever profile migrated first. */
async function migrateAdoptedRow(row, store) {
  const oldPath = row.file;
  const currentPath = extractionDbPath(store);
  if (oldPath === currentPath) return row;

  let release;
  try {
    release = await acquireLock(`${oldPath}.lock`);
  } catch (err) {
    if (err.code === "ENOENT") release = null; // var/ is gone — nothing to move; still update the row below
    else throw err;
  }
  try {
    // Re-read the row under the lock: a concurrent process may have already
    // migrated it (idempotent, same pattern as provisioning itself).
    const list = (await store.getSetting(SETTINGS_KEY)) || [];
    const current = list.find((c) => c.name?.toLowerCase() === EXTRACTION_CONNECTION);
    if (!current || !isManaged(current)) throw collisionError(current?.name);
    if (current.file !== oldPath) return current; // someone else migrated first

    if (existsSync(currentPath)) {
      // A real file already sits at the destination — never overwrite it;
      // keep the adopted row at the old path (still recognized via the legacy
      // acceptance set) rather than destroying either database.
      return row;
    }
    const moved = [];
    try {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        if (existsSync(oldPath + suffix)) {
          renameSync(oldPath + suffix, currentPath + suffix);
          moved.push(suffix);
        }
      }
    } catch (err) {
      // Roll a partial move back — splitting the database from its sidecars
      // would corrupt the file.
      for (const suffix of moved.reverse()) {
        try { renameSync(currentPath + suffix, oldPath + suffix); } catch { /* best-effort */ }
      }
      throw err;
    }
    const updated = { ...current, file: currentPath };
    await saveConnections(store, list.map((c) => (c === current ? updated : c)));
    return updated;
  } finally {
    if (release) release();
  }
}

/** The effective managed row for this profile after one-time legacy
 *  adoption. Called at the FIRST touch of the extraction connection — from
 *  provisionExtractionConnection (the confirmed-write path) AND from
 *  getDriver (every read/schema/open path, via registry.js) — so a v1-adopted
 *  row is migrated to the stable current path before any behavior-only option
 *  edit can orphan it. v1 hashed the raw `options` value into the saved file,
 *  which the allowlist can only recompute while the options stay
 *  byte-identical; migrating the row the first time it is seen makes the
 *  saved file independent of that recomputation from then on. v0-adopted and
 *  already-current rows are returned unchanged (v0 is stable under option
 *  edits and may be legitimately shared by several upgraded profiles). Rows
 *  that are not this profile's own managed rows — including forged
 *  `provisioned: true` rows whose file matches no derived path — are returned
 *  unchanged too; the caller's isManagedExtractionFile decision (and
 *  collision error) applies to them exactly as before, so the forged-path
 *  TOCTOU protection is untouched. */
export async function adoptManagedExtractionRow(store, cfg) {
  if (!store || !cfg || cfg.engine !== "sqlite" || cfg.name?.toLowerCase() !== EXTRACTION_CONNECTION || cfg.provisioned !== true) return cfg;
  if (cfg.file === extractionDbPath(store)) return cfg;
  const legacyPaths = legacyExtractionDbPaths(store);
  if (!legacyPaths.includes(cfg.file)) return cfg; // not this profile's own row — caller rejects it
  if (legacyPaths.length > 1 && cfg.file === legacyPaths[1]) {
    return migrateAdoptedRow(cfg, store); // v1 row: migrate to the stable current path
  }
  return cfg; // v0 row: adopted in place
}

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
    if (!isManaged(existing)) throw collisionError(existing.name);
    if (isManagedExtractionFile(existing, store)) {
      // Legacy adoption: v0 rows stay in place (stable identity, potentially
      // shared); a v1 row — whose saved path hashes the raw options and would
      // orphan on a later behavior-only option edit — is migrated to the
      // stable current path here at provisioning, and on every earlier touch
      // through adoptManagedExtractionRow/getDriver (P1 review finding).
      return adoptManagedExtractionRow(store, existing);
    }
    throw collisionError(existing.name);
  }

  const file = extractionDbPath(store);
  mkdirSync(dirname(file), { recursive: true });
  await createManagedSqliteFile(file, managedEncryptionKey());

  const connection = { name: EXTRACTION_CONNECTION, engine: "sqlite", file, readOnly: false, provisioned: true };
  await saveConnections(store, [...list, connection]);
  return connection;
}
