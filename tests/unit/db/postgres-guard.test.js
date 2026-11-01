// tests/db/postgres-guard.test.js
// SECRET-02 — refuse to connect to Postgres with the example default password.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assertNonDefaultDbUrl } from "../../../db/postgres.js";

describe("assertNonDefaultDbUrl", () => {
  test("throws on the example default password", () => {
    assert.throws(
      () => assertNonDefaultDbUrl("postgresql://aperio:aperio_secret@localhost:5432/aperio", undefined),
      /default Postgres password/,
    );
  });

  test("allows a real password", () => {
    assert.doesNotThrow(() =>
      assertNonDefaultDbUrl("postgresql://aperio:s3cr3t-real@localhost:5432/aperio", undefined));
  });

  test("opt-out env lets the default through", () => {
    assert.doesNotThrow(() =>
      assertNonDefaultDbUrl("postgresql://aperio:aperio_secret@localhost:5432/aperio", "1"));
  });

  test("ignores a missing / non-string url", () => {
    assert.doesNotThrow(() => assertNonDefaultDbUrl(undefined, undefined));
    assert.doesNotThrow(() => assertNonDefaultDbUrl("", undefined));
  });
});
