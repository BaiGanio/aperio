// tests/lib/config-sync.test.js
// Phase 2b — .env ↔ registry reconciliation helpers (issue #167).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  inferType, unmanagedKeys, unmanagedFields, classify, OS_EXCLUDED,
} from "../../lib/config-sync.js";

describe("config-sync", () => {
  test("inferType: secret by name regardless of value", () => {
    assert.equal(inferType("ACME_API_KEY", "x"), "secret");
    assert.equal(inferType("MY_TOKEN", ""), "secret");
    assert.equal(inferType("DB_PASSWORD", "123"), "secret");
  });

  test("inferType: boolean / number / text by value", () => {
    assert.equal(inferType("FOO_FLAG", "on"), "boolean");
    assert.equal(inferType("FOO_FLAG", "false"), "boolean");
    assert.equal(inferType("FOO_COUNT", "42"), "number");
    assert.equal(inferType("FOO_COUNT", "-3.5"), "number");
    assert.equal(inferType("FOO_NAME", "hello"), "text");
    assert.equal(inferType("FOO_NAME", ""), "text");
  });

  test("unmanagedKeys: registry + OS vars excluded", () => {
    const env = { OLLAMA_MODEL: "x", HOME: "/h", MY_CUSTOM: "y", NODE_ENV: "test" };
    assert.deepEqual(unmanagedKeys(env), ["MY_CUSTOM"]);
    assert.ok(OS_EXCLUDED.has("HOME"));
  });

  test("unmanagedFields: secret masked, others carry value", () => {
    const fields = unmanagedFields({ MY_TOKEN: "sk-secret", MY_FLAG: "on", MY_NAME: "bob" });
    const tok = fields.find((f) => f.key === "MY_TOKEN");
    assert.equal(tok.secret, true);
    assert.equal(tok.configured, true);
    assert.equal(tok.value, undefined);
    assert.doesNotMatch(JSON.stringify(fields), /sk-secret/);

    const flag = fields.find((f) => f.key === "MY_FLAG");
    assert.equal(flag.type, "boolean");
    assert.equal(flag.example, "on");   // ON token seeded from observed value

    const name = fields.find((f) => f.key === "MY_NAME");
    assert.equal(name.value, "bob");
    assert.equal(name.editable, true);
    assert.equal(name.section, "imported");
  });

  test("classify: managed / unmanaged / orphaned", () => {
    const env = { OLLAMA_MODEL: "x", MY_CUSTOM: "y", HOME: "/h" };
    const dbKeys = ["config.OLLAMA_MODEL", "config.MY_CUSTOM", "config.GONE", "triage.foo"];
    const { managed, unmanaged, orphaned } = classify(env, dbKeys);
    assert.deepEqual(managed, ["OLLAMA_MODEL"]);
    assert.deepEqual(unmanaged, ["MY_CUSTOM"]);
    // GONE is in the DB but neither in the registry nor .env → orphaned.
    // MY_CUSTOM is in .env so it's unmanaged (adopted), not orphaned.
    assert.deepEqual(orphaned, ["GONE"]);
  });
});
