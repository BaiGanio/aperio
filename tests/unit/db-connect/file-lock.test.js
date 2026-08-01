// tests/unit/db-connect/file-lock.test.js
// Regression coverage for lib/db-connect/file-lock.js's stale-lock
// reclamation (#250 WS1, P1/P2 review findings).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { acquireLock } from "../../../lib/db-connect/file-lock.js";

function writeLockFile(lockPath, pid) {
  const fd = openSync(lockPath, "w");
  writeSync(fd, `${pid}\n`);
  closeSync(fd);
}

const scratchLockPath = () => join(tmpdir(), `aperio-lock-test-${randomBytes(8).toString("hex")}.lock`);

describe("file-lock stale reclamation", () => {
  // P2 review finding: STALE_MS (30s) > ACQUIRE_TIMEOUT_MS (15s) meant a lock
  // left behind by a process that crashed and was restarted right away could
  // never be reclaimed in time — the acquirer always hit its own 15s timeout
  // first. A confirmably dead holder must be reclaimed immediately, not on a
  // 30s clock.
  test("P2: a lock left by a dead holder is reclaimed immediately, without waiting for STALE_MS", async () => {
    // spawnSync only returns once the child has fully exited, so `.pid` here
    // is already a dead process by the time we read it back (pid reuse
    // within the same test run is vanishingly unlikely).
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const lockPath = scratchLockPath();
    writeLockFile(lockPath, dead.pid);

    const start = Date.now();
    const release = await acquireLock(lockPath);
    const elapsed = Date.now() - start;
    release();

    assert.ok(elapsed < 5000, `expected near-immediate reclaim (well under the 30s stale threshold), took ${elapsed}ms`);
  });

  // P2 review finding: a holder that crashes between creating the lock file
  // (openSync 'wx') and writing its pid into it leaves a lock with no
  // readable pid at all — the one case with no liveness signal, so it still
  // falls back to an elapsed-time threshold. That threshold was originally
  // 30s, ABOVE the 15s acquire deadline, so this exact crash guaranteed a
  // timeout instead of the advertised recovery. It must now be comfortably
  // under the acquire deadline, so a fresh acquirer recovers within its own
  // attempt.
  test("P2: a lock file with no readable pid is reclaimed within the acquire window, not after it", async () => {
    const lockPath = scratchLockPath();
    const fd = openSync(lockPath, "w"); // created, but never had a pid written — the crash this simulates
    closeSync(fd);

    const start = Date.now();
    const release = await acquireLock(lockPath);
    const elapsed = Date.now() - start;
    release();

    assert.ok(elapsed < 15_000, `expected reclaim to succeed within the 15s acquire deadline, took ${elapsed}ms`);
  });
});
