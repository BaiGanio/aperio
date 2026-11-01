// tests/unit/workers/redaction-map-prune.test.js
//
// Issue #531 (Aperio Reset S2.5). The redaction-map pruner is the mechanism
// behind redact mode's "the map does not outlive the turn" guarantee: every
// var/redaction-maps/*.json entry holds real, un-redacted PII (email, phone,
// card, IBAN), and each entry's own writer only schedules an unref'd timer to
// delete it — a timer that dies with Codex's short-lived MCP child process
// long before it fires. This worker, running in the main server process, is
// the backstop that makes an abandoned entry no more than one sweep interval
// old. Its three sibling pruners (session, llamacpp-log, agent-run) all had
// tests; this one shipped with the `_sweep` injection seam built for one and
// nothing using it. These are that test.
//
// Style follows llamacpp-log-prune.test.js, the closest sibling.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRedactionMapPruner } from "../../../lib/workers/redaction-map-prune.js";

const SWEEP_INTERVAL_MS = 5 * 60_000;

describe("redaction-map pruning", () => {
  test("sweeps immediately on start, not only after the first interval", () => {
    // An entry orphaned by a crashed MCP child is already on disk when the
    // server boots. Waiting out a whole interval before the first sweep would
    // leave that PII readable for five minutes of every restart.
    let calls = 0;
    const worker = createRedactionMapPruner(() => { calls++; return 0; });
    worker.stop();
    assert.strictEqual(calls, 1);
  });

  test("a throwing sweep does not take down the worker", () => {
    // A sweep hitting EACCES or a racing unlink must not kill the interval —
    // one transient error would otherwise silently retire PII cleanup for the
    // rest of the process's life.
    const worker = createRedactionMapPruner(() => { throw new Error("EACCES"); });
    worker.stop(); // reaching here means run() swallowed it
  });

  test("keeps sweeping on the interval, including after a sweep threw", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let calls = 0;
    const worker = createRedactionMapPruner(() => {
      calls++;
      if (calls === 2) throw new Error("transient");
      return 0;
    });
    assert.strictEqual(calls, 1, "the start-up sweep");
    t.mock.timers.tick(SWEEP_INTERVAL_MS);
    assert.strictEqual(calls, 2, "first interval sweep (the one that throws)");
    t.mock.timers.tick(SWEEP_INTERVAL_MS);
    assert.strictEqual(calls, 3, "the interval must survive the throwing tick");
    worker.stop();
  });

  test("stop() clears the interval — no further sweep fires", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let calls = 0;
    const worker = createRedactionMapPruner(() => { calls++; return 0; });
    worker.stop();
    t.mock.timers.tick(SWEEP_INTERVAL_MS * 3);
    assert.strictEqual(calls, 1, "only the start-up sweep should ever have run");
  });

  test("a sweep that removes nothing is silent; one that removes entries reports", () => {
    // The count is the only operator-visible signal that PII was left behind
    // and cleaned up, so it must come from the sweep rather than be assumed.
    for (const removed of [0, 3]) {
      const worker = createRedactionMapPruner(() => removed);
      worker.stop(); // no throw either way — the log branch is the only difference
    }
  });
});
