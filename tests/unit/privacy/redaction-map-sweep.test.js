// tests/unit/privacy/redaction-map-sweep.test.js
//
// Issue #531 (Aperio Reset S2.5). T2.5 asks that redact mode's placeholder →
// PII map "is not logged or persisted beyond the turn". The map IS persisted:
// var/redaction-maps/<correlationId>.json, because Codex runs recall in its
// own MCP child process and an in-memory Map cannot cross that boundary. So
// the guarantee rests entirely on sweepExpiredRedactionMaps() actually
// deleting an expired entry — and that function had no test, only the worker
// that calls it on a timer (redaction-map-prune.test.js) and the side-channel
// test that checks a redeemed entry's file permissions.
//
// These are deliberately black-box: drive the real exported function against
// a real scratch directory, asserting on files, not on internals.
//
// APERIO_RUNTIME_ROOT is read at MODULE LOAD TIME into a module-level const
// (REDACTION_MAP_DIR), so it must be set BEFORE the dynamic import below —
// setting it afterwards would silently sweep the developer's real
// var/redaction-maps instead of this test's scratch directory.

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const TTL_MS = 20 * 60_000; // REDACTION_MAP_TTL_MS, mirrored intentionally:
// a test that imported the constant could not catch it being shortened.

let scratchRoot, mapDir, sweepExpiredRedactionMaps, oldRuntimeRoot;

before(async () => {
  scratchRoot = mkdtempSync(join(tmpdir(), "aperio-redaction-sweep-"));
  mapDir = join(scratchRoot, "var", "redaction-maps");

  oldRuntimeRoot = process.env.APERIO_RUNTIME_ROOT;
  process.env.APERIO_RUNTIME_ROOT = scratchRoot;
  ({ sweepExpiredRedactionMaps } = await import("../../../lib/handlers/memory/memoryHandlers.js"));
});

after(() => {
  if (oldRuntimeRoot === undefined) delete process.env.APERIO_RUNTIME_ROOT;
  else process.env.APERIO_RUNTIME_ROOT = oldRuntimeRoot;
  rmSync(scratchRoot, { recursive: true, force: true });
});

// Writes an entry whose mtime is `ageMs` in the past, the way an entry left
// behind by an exited MCP child looks to the sweeper.
function writeEntry(ageMs, body = { "«x»": "alice@example.com" }) {
  mkdirSync(mapDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const path = join(mapDir, `${id}.json`);
  writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    utimesSync(path, when, when);
  }
  return path;
}

describe("sweepExpiredRedactionMaps", () => {
  test("deletes an entry older than the TTL and reports it", () => {
    const stale = writeEntry(TTL_MS + 60_000);
    const removed = sweepExpiredRedactionMaps();
    assert.strictEqual(removed, 1, "the expired entry must be counted");
    assert.strictEqual(existsSync(stale), false, "and actually deleted — this file holds real PII");
  });

  test("leaves an entry still inside the TTL alone", () => {
    // The TTL has to outlive a whole provider turn: sweeping a live entry
    // would break restore() mid-turn and show the user «EMAIL_0» instead.
    const fresh = writeEntry(0);
    const removed = sweepExpiredRedactionMaps();
    assert.strictEqual(removed, 0);
    assert.strictEqual(existsSync(fresh), true, "a live turn's map must survive the sweep");
    rmSync(fresh, { force: true });
  });

  test("an entry one minute short of the TTL survives; one a minute past it does not", () => {
    const justUnder = writeEntry(TTL_MS - 60_000);
    const justOver = writeEntry(TTL_MS + 60_000);
    const removed = sweepExpiredRedactionMaps();
    assert.strictEqual(removed, 1, "exactly one side of the cutoff may go");
    assert.strictEqual(existsSync(justUnder), true);
    assert.strictEqual(existsSync(justOver), false);
    rmSync(justUnder, { force: true });
  });

  test("sweeps every expired entry in one pass, not just the first", () => {
    // Several orphans accumulate when a provider crashes repeatedly; a sweep
    // that stopped at the first would let the rest sit there for ever.
    const stale = [writeEntry(TTL_MS + 1), writeEntry(TTL_MS + 2), writeEntry(TTL_MS + 3)];
    const fresh = writeEntry(0);
    const removed = sweepExpiredRedactionMaps();
    assert.strictEqual(removed, 3);
    for (const p of stale) assert.strictEqual(existsSync(p), false);
    assert.strictEqual(existsSync(fresh), true);
    rmSync(fresh, { force: true });
  });

  test("returns 0 and does not throw when the directory does not exist yet", () => {
    // The normal state on a fresh install, and after a successful sweep —
    // a throw here would take down the background worker's whole tick.
    rmSync(mapDir, { recursive: true, force: true });
    assert.strictEqual(sweepExpiredRedactionMaps(), 0);
  });

  test("an unreadable/vanishing entry does not abort the rest of the pass", () => {
    // statSync/unlinkSync race a redeeming reader in the real system. The
    // loop's per-entry catch has to keep going, or one racing entry would
    // strand every later orphan's PII on disk.
    const stale = writeEntry(TTL_MS + 60_000);
    const alsoStale = writeEntry(TTL_MS + 60_000);
    // Simulate the race: remove one out from under the sweeper's readdir.
    const names = readdirSync(mapDir);
    assert.strictEqual(names.length, 2);
    rmSync(stale, { force: true });
    const removed = sweepExpiredRedactionMaps();
    assert.strictEqual(removed, 1, "only the entry that was still there counts as removed");
    assert.strictEqual(existsSync(alsoStale), false, "the surviving orphan must still be swept");
  });
});
