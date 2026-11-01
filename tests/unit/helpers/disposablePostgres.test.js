// tests/unit/helpers/disposablePostgres.test.js
// Guards the guard. tests/helpers/disposablePostgres.js is what stands between
// the opt-in Postgres suites — which migrate, seed and insert — and a
// developer's real database, so its own logic needs to be pinned.
//
// The cases that matter most are the three the PREVIOUS check let through:
// it tested `url.includes("e2e") || url.includes("test")` against the whole
// URL, so a username, host or password containing "test" bought a pass while
// the database stayed the real one. Those three are asserted explicitly below;
// if someone ever reverts to a whole-URL substring check, they go red.

import test from "node:test";
import assert from "node:assert/strict";
import {
  assertDisposablePostgresUrl,
  disposablePostgresRefusal,
  isDisposablePostgresUrl,
  postgresDatabaseName,
} from "../../helpers/disposablePostgres.js";

test("disposable Postgres URL guard", async (t) => {
  await t.test("accepts a database name marked test or e2e", () => {
    // The first is exactly what CI sets (.github/workflows/ci.codecov.yml).
    assert.ok(isDisposablePostgresUrl("postgres://aperio:pw@localhost:5432/aperio_test"));
    assert.ok(isDisposablePostgresUrl("postgres://aperio:pw@localhost:55432/aperio_e2e"));
    assert.ok(isDisposablePostgresUrl("postgres://u:p@h:5432/E2E_SCRATCH"), "case-insensitive");
  });

  await t.test("refuses the real database name", () => {
    assert.equal(isDisposablePostgresUrl("postgres://aperio:pw@localhost:8008/aperio"), false);
  });

  await t.test("a marker outside the database name buys nothing", () => {
    // All three of these passed the old whole-URL substring check while
    // pointing at the real `aperio` database.
    assert.equal(isDisposablePostgresUrl("postgres://test:pw@localhost:5432/aperio"), false,
      "username containing 'test'");
    assert.equal(isDisposablePostgresUrl("postgres://aperio:pw@test-host:5432/aperio"), false,
      "hostname containing 'test'");
    assert.equal(isDisposablePostgresUrl("postgres://aperio:testpw@localhost:5432/aperio"), false,
      "password containing 'test'");
  });

  await t.test("refuses a URL with no database name, and an unparseable one", () => {
    assert.equal(isDisposablePostgresUrl("postgres://aperio:pw@localhost:5432/"), false);
    assert.equal(isDisposablePostgresUrl("postgres://aperio:pw@localhost:5432"), false);
    assert.equal(isDisposablePostgresUrl("not-a-url"), false);
    assert.equal(isDisposablePostgresUrl(""), false);
  });

  await t.test("postgresDatabaseName decodes and reports null when absent", () => {
    assert.equal(postgresDatabaseName("postgres://u:p@h:5432/aperio_test"), "aperio_test");
    assert.equal(postgresDatabaseName("postgres://u:p@h:5432/my%20test%20db"), "my test db");
    assert.equal(postgresDatabaseName("postgres://u:p@h:5432/"), null);
    assert.equal(postgresDatabaseName("nonsense"), null);
  });

  await t.test("assert throws on a real target and passes a disposable one", () => {
    assert.throws(
      () => assertDisposablePostgresUrl("postgres://aperio:pw@localhost:8008/aperio"),
      /not marked disposable/
    );
    assertDisposablePostgresUrl("postgres://aperio:pw@localhost:5432/aperio_test");
  });

  await t.test("the refusal names the offending database and the way out", () => {
    const message = disposablePostgresRefusal("postgres://aperio:pw@localhost:8008/aperio");
    assert.match(message, /"aperio"/, "names the database it refused");
    assert.match(message, /aperio_test/, "shows a name that would work");
    assert.match(disposablePostgresRefusal("nonsense"), /\(none in URL\)/);
  });
});
