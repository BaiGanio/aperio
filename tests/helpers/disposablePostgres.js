// tests/helpers/disposablePostgres.js
// One rule for "is this Postgres URL safe for a test to write to?".
//
// Every suite gated on APERIO_E2E_POSTGRES_URL *writes*: PostgresStore.init()
// runs migrations and baseline seeding, and the domain tests insert rows. The
// only check that previously stood between that and a developer's real
// database was assertNonDefaultDbUrl() (db/postgres/store.js), which refuses
// the shipped example PASSWORD and says nothing about which database is being
// targeted. So a URL with a real password pointed at the real `aperio`
// database passed, and the contract suite would migrate and seed it.
//
// tests/e2e/real-app (T64) did have a guard, but it tested
// `url.includes("e2e") || url.includes("test")` against the WHOLE URL — which
// a username, host or password containing "test" satisfies while the database
// is still the real one. This checks the database NAME, which is the thing
// that actually gets written to.
//
// Both edges import this, so they cannot drift apart — the same
// one-constant-two-edges shape S2.10 used for the attachment budget.

const DISPOSABLE_MARKERS = ["e2e", "test"];

/**
 * The database name from a Postgres connection URL, or null if it has none.
 * @param {string} url
 * @returns {string|null}
 */
export function postgresDatabaseName(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  return name === "" ? null : name;
}

/**
 * True when the URL's DATABASE NAME marks it as disposable.
 * @param {string} url
 * @returns {boolean}
 */
export function isDisposablePostgresUrl(url) {
  const name = postgresDatabaseName(url);
  if (name === null) return false;
  const lower = name.toLowerCase();
  return DISPOSABLE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * The refusal message, so the two call sites word it identically.
 * @param {string} url
 * @returns {string}
 */
export function disposablePostgresRefusal(url) {
  const name = postgresDatabaseName(url);
  return (
    `APERIO_E2E_POSTGRES_URL targets database ${name === null ? "(none in URL)" : `"${name}"`}, ` +
    `which is not marked disposable. These tests run migrations, seed baselines and insert ` +
    `rows, so they must never point at a real database. Name it with "e2e" or "test" ` +
    `(CI uses "aperio_test"), e.g. postgres://user:pw@localhost:5432/aperio_test.`
  );
}

/**
 * Throws unless the URL's database name is marked disposable. Deliberately
 * throws rather than skipping: a silent skip would quietly drop the Postgres
 * half of the coverage, which is the failure mode this repo guards against
 * everywhere else.
 * @param {string} url
 */
export function assertDisposablePostgresUrl(url) {
  if (!isDisposablePostgresUrl(url)) throw new Error(disposablePostgresRefusal(url));
}
