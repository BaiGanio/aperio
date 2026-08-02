// tests/unit/db-connect/file-lock.test.js
// Regression coverage for lib/db-connect/file-lock.js's stale-lock
// reclamation (#250 WS1, P1/P2 review findings).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, renameSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { acquireLock, takeoverStaleMarker, decideTakeoverClaim } from "../../../lib/db-connect/file-lock.js";

// A live process OTHER than this one — the pid a genuine concurrent reclaimer
// would write into its marker. (The reclaimer's finally only unlinks a marker
// it can prove is its own, so planting OUR pid would make the marker look
// self-owned and break the "someone else is mid-flight" simulations below.)
function liveOtherPid() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return { pid: child.pid, kill: () => { try { child.kill(); } catch { /* already gone */ } } };
}

function writeLockFile(lockPath, pid, signature = "") {
  const fd = openSync(lockPath, "w");
  writeSync(fd, `${pid}\n${signature}`);
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

  // P2 review finding: a matching pid alone isn't proof of the SAME holder —
  // after a crash (or reboot) leaves the lock behind, the OS can reuse that
  // pid for a completely unrelated, genuinely live process. Before this fix,
  // isAlive(pid) alone would report that unrelated process as the "still
  // live" original holder forever, wedging every acquirer until it happened
  // to exit. Using our OWN pid (guaranteed alive throughout this test) with a
  // deliberately bogus recorded signature simulates exactly that: a pid
  // that's alive, but demonstrably NOT the process that wrote this lock.
  test("P2: a lock whose pid is alive but whose recorded start-signature no longer matches (pid reused by a different process) is reclaimed", async () => {
    const lockPath = scratchLockPath();
    writeLockFile(lockPath, process.pid, "bogus-signature-that-will-never-match-000000");

    const start = Date.now();
    const release = await acquireLock(lockPath);
    const elapsed = Date.now() - start;
    release();

    assert.ok(elapsed < 5000, `expected reclaim once the recorded signature didn't match this (live) pid's real one, took ${elapsed}ms`);
  });

  // P1 review finding: multiple waiters inspecting the same PID-reused stale
  // record can race — one unlinks it, a new holder acquires the path, and a
  // second waiter then blindly unlinks the NEW holder's lock, allowing
  // concurrent managed-SQLite access. Reclaimers are now serialized behind a
  // marker file (${lockPath}.reclaim, O_EXCL): while a marker exists, NO other
  // reclaimer may touch the lock, so a fresh holder's lock can never be
  // deleted out from under it. This test simulates "another reclaimer is
  // mid-flight" by planting a fresh marker over a stale lock and asserting the
  // lock is left completely untouched; only once the marker is released does
  // acquisition complete.
  test("P1: a fresh reclaimer marker defers ALL reclamation — a concurrent reclaimer can never unlink a new holder's lock", async () => {
    const lockPath = scratchLockPath();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeLockFile(lockPath, dead.pid);
    const other = liveOtherPid();
    try {
      const markerPath = `${lockPath}.reclaim`;
      const markerFd = openSync(markerPath, "w");
      writeSync(markerFd, `${other.pid}\n`);
      closeSync(markerFd);

      const acquiring = acquireLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The fresh marker must have deferred reclamation entirely: the stale lock
      // is byte-for-byte untouched, not replaced by a reclaimer's own record,
      // and the other reclaimer's marker is still there (the reclaimer's
      // finally never unlinks a marker that is not provably its own).
      const stillThere = readFileSync(lockPath, "utf8");
      assert.equal(stillThere.trim().split("\n")[0], String(dead.pid));
      assert.equal(existsSync(markerPath), true, "another reclaimer's fresh marker is left in place");

      // The other reclaimer finishes without having unlinked — now acquisition
      // proceeds normally (next poll reclaims the still-stale lock).
      unlinkSync(markerPath);
      const release = await acquiring;
      release();
    } finally {
      other.kill();
    }
  });

  // P1: a marker left behind by a reclaimer that CRASHED mid-reclaim must not
  // wedge reclamation forever — after the staleness threshold it is stolen and
  // the stale lock is reclaimed within the acquire window.
  test("P1: a reclaim marker abandoned by a crashed reclaimer is stolen after the staleness threshold", async () => {
    const lockPath = scratchLockPath();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeLockFile(lockPath, dead.pid);
    const markerPath = `${lockPath}.reclaim`;
    const markerFd = openSync(markerPath, "w");
    writeSync(markerFd, `${process.pid}\n`);
    closeSync(markerFd);
    const abandoned = new Date(Date.now() - 10_000);
    utimesSync(markerPath, abandoned, abandoned);

    const start = Date.now();
    const release = await acquireLock(lockPath);
    const elapsed = Date.now() - start;
    release();

    assert.ok(elapsed < 10_000, `expected reclaim after the abandoned marker was stolen, took ${elapsed}ms`);
  });

  // P1 review finding: a stat-then-unlink takeover was not atomic — two
  // waiters could both stat the same stale marker, and after one unlinked it
  // and created a fresh marker on its next poll, the other could still delete
  // that FRESH marker from its stale observation, reopening the concurrent-
  // reclaimer race. Takeover is now ownership-preserving: the taker RENAMES
  // the marker to a claim path it alone owns and deletes only a claim whose
  // own mtime proves it is the abandoned marker — a fresh replacement is
  // restored, never unlinked. This test simulates the exact interleaving: a
  // first waiter already took the aged marker over (renamed it to its claim)
  // and left a fresh marker behind; a second waiter's acquire must leave BOTH
  // the claim and the fresh marker untouched, and only proceed once the fresh
  // marker is released.
  test("P1: a stale observation can never unlink a replacement marker — takeover is ownership-preserving", async () => {
    const lockPath = scratchLockPath();
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    writeLockFile(lockPath, dead.pid);

    const markerPath = `${lockPath}.reclaim`;
    const aged = openSync(markerPath, "w");
    writeSync(aged, "111\n");
    closeSync(aged);
    const old = new Date(Date.now() - 10_000);
    utimesSync(markerPath, old, old);

    // First waiter takes the abandoned marker over (atomic rename to its own
    // claim) and moves on, leaving a fresh marker for its next poll.
    const other = liveOtherPid();
    try {
      const claimPath = `${markerPath}.steal-1-aaaaaaaaaaaa`;
      renameSync(markerPath, claimPath);
      const fresh = openSync(markerPath, "w");
      writeSync(fresh, `${other.pid}\n`);
      closeSync(fresh);

      // Second waiter with a stale observation: must not delete the first
      // waiter's claim OR the fresh marker.
      const acquiring = acquireLock(lockPath);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(existsSync(claimPath), true, "the first waiter's claim file is untouched");
      assert.equal(existsSync(markerPath), true, "the fresh marker is untouched");
      assert.equal(readFileSync(markerPath, "utf8").trim().split("\n")[0], String(other.pid));

      // The fresh marker is released; only now does acquisition proceed.
      unlinkSync(markerPath);
      const release = await acquiring;
      release();
      unlinkSync(claimPath); // tidy up the simulated first-waiter claim
    } finally {
      other.kill();
    }
  });

  // Direct protocol tests for takeoverStaleMarker: the staleness decision is
  // made from the object actually renamed away, so an abandoned marker is
  // deleted but a FRESH marker — live reclaimer's or replacement — is restored
  // and never unlinked (P1 review finding).
  test("P1: takeoverStaleMarker deletes only a genuinely abandoned marker", () => {
    const markerPath = `${scratchLockPath()}.reclaim`;
    const fd = openSync(markerPath, "w");
    writeSync(fd, "111\n"); // a reclaimer that crashed mid-reclaim
    closeSync(fd);
    const aged = new Date(Date.now() - 10_000);
    utimesSync(markerPath, aged, aged);
    try {
      assert.equal(takeoverStaleMarker(markerPath), true, "the abandoned marker is taken over");
      assert.equal(existsSync(markerPath), false, "the abandoned marker is removed");
    } finally {
      try { unlinkSync(markerPath); } catch { /* already gone */ }
    }
  });

  test("P1: takeoverStaleMarker restores a fresh marker instead of deleting it", () => {
    const markerPath = `${scratchLockPath()}.reclaim`;
    const fd = openSync(markerPath, "w");
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    try {
      assert.equal(takeoverStaleMarker(markerPath), false, "a fresh marker defers the takeover");
      assert.equal(existsSync(markerPath), true, "the fresh marker is untouched");
      assert.equal(readFileSync(markerPath, "utf8").trim(), String(process.pid));
    } finally {
      try { unlinkSync(markerPath); } catch { /* already gone */ }
    }
  });

  // P1: the takeover's post-rename decision (decideTakeoverClaim). A taker
  // can observe an AGED marker and then have its rename land on a FRESH
  // replacement (a live reclaimer's marker, or one created after another
  // taker's takeover). The claim's own mtime decides: fresh claims are
  // restored to the marker path, never unlinked — a stale observation can
  // never delete a replacement marker.
  test("P1: a fresh claim is restored to the marker path, never deleted", () => {
    const markerPath = `${scratchLockPath()}.reclaim`;
    const claimPath = `${markerPath}.steal-1-aaaaaaaaaaaa`;
    const fd = openSync(claimPath, "w");
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    try {
      assert.equal(decideTakeoverClaim(claimPath, markerPath), false, "a fresh claim is not taken over");
      assert.equal(existsSync(markerPath), true, "the fresh marker is restored to the marker path");
      assert.equal(readFileSync(markerPath, "utf8").trim(), String(process.pid), "the replacement's content is intact");
      assert.equal(existsSync(claimPath), false, "the claim is consumed by the restore");
    } finally {
      try { unlinkSync(markerPath); } catch { /* already gone */ }
      try { unlinkSync(claimPath); } catch { /* already gone */ }
    }
  });

  test("P1: a fresh claim never clobbers a marker path re-occupied in the instant the taker held the claim", () => {
    const markerPath = `${scratchLockPath()}.reclaim`;
    const claimPath = `${markerPath}.steal-1-aaaaaaaaaaaa`;
    const fd = openSync(claimPath, "w");
    writeSync(fd, `${process.pid}\n`);
    closeSync(fd);
    const occupant = openSync(markerPath, "w");
    writeSync(occupant, "222\n");
    closeSync(occupant);
    try {
      assert.equal(decideTakeoverClaim(claimPath, markerPath), false);
      assert.equal(readFileSync(markerPath, "utf8").trim(), "222", "the occupant marker survives");
      assert.equal(existsSync(claimPath), false, "the dropped claim is removed");
    } finally {
      try { unlinkSync(markerPath); } catch { /* already gone */ }
      try { unlinkSync(claimPath); } catch { /* already gone */ }
    }
  });

  test("P1: a genuinely abandoned claim is deleted even when the marker path was re-occupied", () => {
    const markerPath = `${scratchLockPath()}.reclaim`;
    const claimPath = `${markerPath}.steal-1-aaaaaaaaaaaa`;
    const fd = openSync(claimPath, "w");
    writeSync(fd, "111\n");
    closeSync(fd);
    const aged = new Date(Date.now() - 10_000);
    utimesSync(claimPath, aged, aged);
    const occupant = openSync(markerPath, "w");
    writeSync(occupant, "222\n");
    closeSync(occupant);
    try {
      assert.equal(decideTakeoverClaim(claimPath, markerPath), true, "the abandoned marker is removed");
      assert.equal(readFileSync(markerPath, "utf8").trim(), "222", "the occupant marker survives untouched");
      assert.equal(existsSync(claimPath), false);
    } finally {
      try { unlinkSync(markerPath); } catch { /* already gone */ }
      try { unlinkSync(claimPath); } catch { /* already gone */ }
    }
  });
});
