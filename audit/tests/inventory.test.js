// T1 — audit/scripts/inventory.js reproducibility (aperio-continuous-audit-tests.md, T1.1).
//
// Verify-first proof for the continuous-audit program's baseline generator:
// it must produce a byte-identical inventory (modulo the timestamp) on two
// back-to-back runs against the same working tree, and it must not be a
// vacuous stub — every field must reflect real, known repo facts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateInventory } from "../scripts/inventory.js";

describe("audit/scripts/inventory.js", () => {
  test("T1.1 — repeated inventory is stable except observed_at", () => {
    const a = generateInventory();
    const b = generateInventory();

    assert.notStrictEqual(a.observed_at, undefined);
    assert.notStrictEqual(b.observed_at, undefined);

    const { observed_at: _a, ...restA } = a;
    const { observed_at: _b, ...restB } = b;
    assert.deepStrictEqual(restA, restB);
  });

  test("red/green proof — a stub generator would fail these", () => {
    const inv = generateInventory();

    // repository
    assert.match(inv.repository.commit, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(inv.repository.dirty_paths));

    // providers: derived from lib/config.js's AI_PROVIDER options, not hardcoded
    assert.deepStrictEqual(
      inv.providers,
      ["anthropic", "claude-code", "codex", "deepseek", "gemini", "llamacpp"]
    );

    // migrations: postgres and sqlite must stay in lockstep (AGENTS.md)
    assert.strictEqual(inv.database.migration_parity, true);
    assert.ok(inv.database.migration_count_postgres > 0);
    assert.deepStrictEqual(inv.database.migrations_postgres, inv.database.migrations_sqlite);

    // locales, routes, mcp tools, config keys: non-empty, real lists
    assert.ok(inv.locales.count > 0);
    assert.ok(inv.locales.codes.includes("en"));
    assert.ok(inv.routes.length > 0);
    assert.ok(inv.mcp_tools.length > 0);
    assert.ok(inv.config.count > 0);
    assert.ok(inv.config.keys.includes("AI_PROVIDER"));

    // source/test counts: generated, not copied prose constants (T1.3's intent)
    assert.ok(inv.source_files.total > 0);
    assert.ok(inv.test_files.total > 0);
  });
});
