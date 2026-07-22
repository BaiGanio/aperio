import assert from "node:assert/strict";
import { test } from "node:test";

import { createE2EReporter } from "../../reporters/e2e-json.js";

test("E2E reporter filters a full-suite event stream by source file", async () => {
  const reporter = createE2EReporter();
  let output = "";
  reporter.on("data", (chunk) => { output += chunk.toString(); });

  const events = [
    event("test:start", "unit suite", 0, 1, 0, "/repo/tests/lib/unit.test.js"),
    event("test:start", "unit case", 1, 2, 1, "/repo/tests/lib/unit.test.js"),
    event("test:pass", "unit case", 1, 2, 1, "/repo/tests/lib/unit.test.js"),
    event("test:start", "E2E suite", 0, 3, 0, "/repo/tests/e2e/chat.test.js"),
    event("test:start", "connects", 1, 4, 3, "/repo/tests/e2e/chat.test.js"),
    event("test:pass", "connects", 1, 4, 3, "/repo/tests/e2e/chat.test.js"),
  ];

  for (const item of events) reporter.write(item);
  reporter.end();
  await new Promise((resolve, reject) => {
    reporter.on("end", resolve);
    reporter.on("error", reject);
    reporter.resume();
  });

  const result = JSON.parse(output);
  assert.equal(result.total, 1);
  assert.equal(result.passed, 1);
  assert.deepEqual(result.suites.map((suite) => suite.name), ["E2E suite"]);
  assert.deepEqual(result.suites[0].tests.map((item) => item.name), ["connects"]);
});

test("E2E reporter includes top-level tests that are not suites", async () => {
  const reporter = createE2EReporter();
  let output = "";
  reporter.on("data", (chunk) => { output += chunk.toString(); });

  reporter.write(event("test:start", "top-level chat", 0, 1, 0, "/repo/tests/e2e/chat.test.js"));
  reporter.write(event("test:pass", "top-level chat", 0, 1, 0, "/repo/tests/e2e/chat.test.js", "test"));
  reporter.end();
  await new Promise((resolve, reject) => {
    reporter.on("end", resolve);
    reporter.on("error", reject);
    reporter.resume();
  });

  const result = JSON.parse(output);
  assert.equal(result.total, 1);
  assert.equal(result.passed, 1);
  assert.deepEqual(result.suites[0].tests.map((item) => item.name), ["top-level chat"]);
});

function event(type, name, nesting, testId, parentId, file, detailType) {
  return {
    type,
    data: {
      name,
      nesting,
      testId,
      parentId,
      file,
      details: type === "test:pass" ? { duration_ms: 5, type: detailType ?? (nesting ? "test" : "suite") } : undefined,
    },
  };
}
