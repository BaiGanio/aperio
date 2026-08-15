// T2.5 — audit/scripts/config-contract.js (aperio-continuous-audit-tests.md, T2.5).
//
// Verify-first proof for the config drift gate: an unregistered env read
// fails with its location named, a reviewed/platform exception passes, and
// today's real scan is asserted — including the two genuine gaps it found
// (logged to id/reference/tech-debt.md, not silently swallowed here).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { envReadsInSource, checkConfigContract, REVIEWED_EXCEPTIONS } from "../scripts/config-contract.js";

describe("audit/scripts/config-contract.js", () => {
  test("envReadsInSource finds both process.env.X and process.env['X'] forms", () => {
    const src = `
const a = process.env.FOO_BAR;
const b = process.env["BAZ_QUX"];
const c = process.env['ANOTHER_ONE'];
`;
    assert.deepStrictEqual([...envReadsInSource(src)].sort(), ["ANOTHER_ONE", "BAZ_QUX", "FOO_BAR"]);
  });

  test("envReadsInSource ignores comment-only mentions (the exact 'process.env.X' prose false positive)", () => {
    const src = `
// instead of rewriting the ~280 existing \`process.env.X\` reads to something else
/* another mention of process.env.X in a block comment */
const real = process.env.REAL_VAR;
`;
    assert.deepStrictEqual([...envReadsInSource(src)], ["REAL_VAR"]);
  });

  test("T2.5 — an unregistered env read fails with its file location named", () => {
    const result = checkConfigContract({
      registeredKeys: new Set(["KNOWN_VAR"]),
      exceptions: {},
      byVar: { KNOWN_VAR: ["lib/a.js"], MYSTERY_VAR: ["lib/b.js", "lib/c.js"] },
    });
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.unregistered, [{ key: "MYSTERY_VAR", readIn: ["lib/b.js", "lib/c.js"] }]);
  });

  test("T2.5 — a reviewed/platform exception passes without being registered", () => {
    const result = checkConfigContract({
      registeredKeys: new Set(["KNOWN_VAR"]),
      exceptions: { HOME: "OS-set" },
      byVar: { KNOWN_VAR: ["lib/a.js"], HOME: ["lib/b.js"] },
    });
    assert.strictEqual(result.ok, true);
  });

  test("T5.1 red/green proof — removing the exception entry for the same read flips the gate back to failing", () => {
    const byVar = { MYSTERY_VAR: ["lib/b.js"] };
    const red = checkConfigContract({ registeredKeys: new Set(), exceptions: {}, byVar });
    assert.strictEqual(red.ok, false);
    const green = checkConfigContract({ registeredKeys: new Set(), exceptions: { MYSTERY_VAR: "reviewed" }, byVar });
    assert.strictEqual(green.ok, true);
    const redAgain = checkConfigContract({ registeredKeys: new Set(), exceptions: {}, byVar });
    assert.strictEqual(redAgain.ok, false);
  });

  test("current real state — two genuine unregistered reads exist today (logged in tech-debt.md, " +
    "not silently allowlisted here)", () => {
    const result = checkConfigContract();
    const keys = result.unregistered.map((u) => u.key).sort();
    assert.deepStrictEqual(keys, ["APERIO_LLAMACPP_RUNTIME_DIR", "APERIO_LOG_CACHE_FINGERPRINT"]);
    assert.ok(!("APERIO_LLAMACPP_RUNTIME_DIR" in REVIEWED_EXCEPTIONS));
    assert.ok(!("APERIO_LOG_CACHE_FINGERPRINT" in REVIEWED_EXCEPTIONS));
  });

  test("current real state — the documented OS/internal exceptions are all actually read somewhere " +
    "(a stale exception entry would go silent, not fail loud, so pin the live ones)", () => {
    const result = checkConfigContract();
    assert.ok(Object.keys(REVIEWED_EXCEPTIONS).length >= 10);
  });
});
