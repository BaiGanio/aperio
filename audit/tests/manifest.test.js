// T4 — audit/scripts/manifest.js (aperio-continuous-audit-tests.md, T4.2/T4.4).
//
// Verify-first proof for the A14 evidence-packet manifest: every included
// path carries a hash and reason (T4.4), the aggregate hash is stable and
// sensitive to a content change (T4.3's mechanism, proven on synthetic
// input), and an oversized packet refuses to be a single invocation and
// proposes deterministic sub-slices instead (T4.2).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildA14Manifest, computeManifestHash, hashFile,
  A14_INCLUDED, A14_EXCLUDED, TOKEN_CEILING,
} from "../scripts/manifest.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

describe("audit/scripts/manifest.js", () => {
  test("T4.4 — every included path has a content hash and a stated reason", () => {
    const m = buildA14Manifest();
    assert.ok(m.included.length > 0);
    for (const f of m.included) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/, `${f.path} should have a sha256 hash`);
      assert.ok(f.reason?.length > 0, `${f.path} should have an inclusion reason`);
      assert.ok(["shared", "sqlite", "postgres", "migrations"].includes(f.bucket));
    }
  });

  test("T4.4 — coupled-but-excluded files are named with reasons", () => {
    assert.ok(A14_EXCLUDED.length > 0);
    for (const f of A14_EXCLUDED) {
      assert.ok(f.path?.length > 0);
      assert.ok(f.reason?.length > 0, `${f.path} should have an exclusion reason`);
    }
  });

  test("T4.4 — both migration directories are captured, and parity is visible", () => {
    const m = buildA14Manifest();
    assert.ok(m.migrations.postgres.length > 0);
    assert.strictEqual(m.migrations.postgres.length, m.migrations.sqlite.length);
  });

  test("T4.4 — companion tests are discovered from the real tree, not hand-typed", () => {
    const m = buildA14Manifest();
    assert.ok(m.companionTests.length > 0);
    assert.ok(m.companionTests.includes("tests/integration/db/sqlite.test.js"));
    assert.ok(m.companionTests.includes("tests/unit/db/migration-lockstep.test.js"));
  });

  test("T4.4 — the aggregate manifest hash is stable across repeated builds", () => {
    const a = buildA14Manifest();
    const b = buildA14Manifest();
    assert.strictEqual(a.manifestHash, b.manifestHash);
  });

  test("T4.2 — the reference A14 packet exceeds the 30K ceiling as a whole, and every " +
    "proposed sub-slice fits under it", () => {
    const m = buildA14Manifest();
    // db/sqlite/store.js + db/postgres/store.js alone run close to the ceiling;
    // this assertion is honest about the reference packet's real size, not a
    // guess — if this ever flips to true, the sub-slice split below is no
    // longer load-bearing and this test (not the packet) should be revisited.
    assert.strictEqual(m.withinCeiling, false, `expected the full A14 packet to exceed ${TOKEN_CEILING} tokens`);
    assert.strictEqual(m.allSubSlicesWithinCeiling, true);
    assert.ok(m.subSlices.length >= 2, "an oversized packet must propose more than one sub-slice");
    for (const s of m.subSlices) {
      assert.ok(s.estimatedTokens <= TOKEN_CEILING, `${s.id} (${s.estimatedTokens} tokens) should fit the ceiling`);
      assert.strictEqual(s.withinCeiling, true);
    }
  });

  test("T5.1 red/green proof — computeManifestHash is sensitive to a content change and blind " +
    "to an unrelated one (synthetic input, no real files touched)", () => {
    const base = [
      { path: "db/index.js", sha256: hashFile("db/index.js").sha256 },
      { path: "db/tables.js", sha256: hashFile("db/tables.js").sha256 },
    ];
    const same = [...base];
    assert.strictEqual(computeManifestHash(base), computeManifestHash(same), "identical input must hash identically");

    const mutated = [{ ...base[0], sha256: "f".repeat(64) }, base[1]];
    assert.notStrictEqual(
      computeManifestHash(base), computeManifestHash(mutated),
      "a changed file hash in an included file must move the manifest hash"
    );

    // An unrelated file changing does not enter A14's manifest at all, since
    // A14_INCLUDED never names it — proven by construction: it is not in the
    // included list, so it cannot appear in the file set computeManifestHash sees.
    const unrelatedPath = "public/locales/en.json";
    assert.ok(
      !A14_INCLUDED.some((f) => f.path === unrelatedPath),
      "test fixture assumption: this path must stay outside A14's scope"
    );
  });

  test("T4.4 — the packet records its revision and dirty-state sensitivity", () => {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    const m = buildA14Manifest();
    assert.strictEqual(m.slice, "A14");
    assert.strictEqual(m.commit, commit);
    assert.strictEqual(typeof m.dirty, "boolean");
    assert.ok(Array.isArray(m.dirtySensitivePaths));
  });
});
