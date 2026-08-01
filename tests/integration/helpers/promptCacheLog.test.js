// tests/lib/helpers/promptCacheLog.test.js
//
// Prompt-cache hygiene: parseServerLog() against fixture lines lifted from
// real var/llamacpp/*.log
// output (llamacpp.md's LCP-similarity slot reuse logging).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseServerLog, formatPromptCacheReport } from "../../../lib/helpers/promptCacheLog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Named .txt, not .log — a blanket `*.log` rule in .gitignore (boilerplate
// VS-project block, unrelated to test fixtures) would silently exclude it.
const FIXTURE_PATH = join(__dirname, "../../fixtures/llamacpp-server-log-sample.txt");

describe("parseServerLog", () => {
  test("parses the three baseline requests from the plan's measured table", () => {
    const text = readFileSync(FIXTURE_PATH, "utf-8");
    const records = parseServerLog(text);

    assert.equal(records.length, 3);

    const [cold, mid, low] = records;
    assert.deepEqual(cold, { taskId: 729, selection: "lru", sim: null, fKeep: null, promptTokens: 8609, promptMs: 38400 });
    assert.deepEqual(mid, { taskId: 804, selection: "lcp", sim: 0.823, fKeep: 1.000, promptTokens: 1872, promptMs: 9200 });
    assert.deepEqual(low, { taskId: 892, selection: "lcp", sim: 0.657, fKeep: 0.773, promptTokens: 4426, promptMs: 21500 });
  });

  test("LRU-selection lines parse as sim: null (no LCP score to report)", () => {
    const text = readFileSync(FIXTURE_PATH, "utf-8");
    const [cold] = parseServerLog(text);
    assert.equal(cold.selection, "lru");
    assert.equal(cold.sim, null);
    assert.equal(cold.fKeep, null);
  });

  test("returns an empty array for empty/undefined input", () => {
    assert.deepEqual(parseServerLog(""), []);
    assert.deepEqual(parseServerLog(undefined), []);
  });

  test("skips a request whose prompt eval time line never arrives (truncated log)", () => {
    const text = [
      "[999] 0.05.000.000 I slot get_availabl: id  0 | task -1 | selected slot by LRU, t_last = -1",
      "[999] 0.05.000.100 I slot launch_slot_: id  0 | task 1 | processing task, is_child = 0",
      "[999] 0.05.001.000 I slot print_timing: id  0 | task 1 | prompt processing, n_tokens =   512, progress = 0.50, t =   1.00 s / 512.00 tokens per second",
      // log cut off here — no "prompt eval time" line for task 1
    ].join("\n");
    assert.deepEqual(parseServerLog(text), []);
  });

  test("skips truncated/malformed lines without throwing", () => {
    const text = [
      "[999] 0.05.000.000 I slot get_availabl: id  0 | task -1 | selected slot by LCP simila", // cut mid-line
      "not a log line at all",
      "[999] 0.05.000.200 I slot launch_slot_: id  0 | task 2 | processing t", // cut mid-line
      "[999] 0.05.001.000 I slot print_timing: id  0 | task 2 | prompt eval time =    500.00 ms /   100 tokens (    5.00 ms per token,   200.00 tokens per second)",
    ].join("\n");
    // The launch_slot_ line was truncated before "processing task" — it
    // never matches, so no record ever opens for task 2. The later eval
    // line for task 2 has nothing to attach to and is correctly dropped,
    // not fabricated into a partial record.
    assert.deepEqual(parseServerLog(text), []);
  });

  test("strips embedded NUL bytes from a line before matching", () => {
    // A \0 dropped mid-line by a racing tee write (see stripNuls() in
    // startLlamaCpp.js) — removing it must still leave a matchable line.
    const nulHoled = "[999] 0.05.000.000 I slot print\0_timing: id  0 | task 5 | prompt eval time =   750.00 ms /   150 tokens (    5.00 ms per token,   200.00 tokens per second)";
    const text = [
      "[999] 0.05.000.000 I slot get_availabl: id  0 | task -1 | selected slot by LRU, t_last = -1",
      "[999] 0.05.000.100 I slot launch_slot_: id  0 | task 5 | processing task, is_child = 0",
      nulHoled,
    ].join("\n");
    const records = parseServerLog(text);
    assert.deepEqual(records, [
      { taskId: 5, selection: "lru", sim: null, fKeep: null, promptTokens: 150, promptMs: 750 },
    ]);
  });

  test("a restarted server reusing small task ids pairs each occurrence with its own timing, not a stale one", () => {
    const text = [
      // First "session": task 0 cold, then finishes.
      "[100] 0.01.000.000 I slot get_availabl: id  0 | task -1 | selected slot by LRU, t_last = -1",
      "[100] 0.01.000.100 I slot launch_slot_: id  0 | task 0 | processing task, is_child = 0",
      "[100] 0.01.005.000 I slot print_timing: id  0 | task 0 | prompt eval time =   1000.00 ms /   200 tokens (    5.00 ms per token,   200.00 tokens per second)",
      // Server restarts (PID changes) — task ids reset, task 0 appears again.
      "[200] 0.01.000.000 I slot get_availabl: id  0 | task -1 | selected slot by LRU, t_last = -1",
      "[200] 0.01.000.100 I slot launch_slot_: id  0 | task 0 | processing task, is_child = 0",
      "[200] 0.01.009.000 I slot print_timing: id  0 | task 0 | prompt eval time =   3000.00 ms /   600 tokens (    5.00 ms per token,   200.00 tokens per second)",
    ].join("\n");
    const records = parseServerLog(text);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0], { taskId: 0, selection: "lru", sim: null, fKeep: null, promptTokens: 200, promptMs: 1000 });
    assert.deepEqual(records[1], { taskId: 0, selection: "lru", sim: null, fKeep: null, promptTokens: 600, promptMs: 3000 });
  });
});

describe("formatPromptCacheReport", () => {
  test("reports a cold LRU request without a sim/f_keep score", () => {
    const report = formatPromptCacheReport([
      { taskId: 729, selection: "lru", sim: null, fKeep: null, promptTokens: 8609, promptMs: 38400 },
    ]);
    assert.match(report, /task 729: cold \(LRU — no prefix match\) — reprocessed 8609 tok in 38400 ms/);
  });

  test("reports an LCP request's sim_best and f_keep", () => {
    const report = formatPromptCacheReport([
      { taskId: 804, selection: "lcp", sim: 0.823, fKeep: 1.0, promptTokens: 1872, promptMs: 9200 },
    ]);
    assert.match(report, /task 804: sim_best=0\.823 f_keep=1\.000 — reprocessed 1872 tok in 9200 ms/);
  });

  test("handles an empty record list", () => {
    assert.equal(formatPromptCacheReport([]), "No requests found in this log.");
  });
});
