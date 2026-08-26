import assert from "node:assert/strict";
import { test } from "node:test";

import { createIntegrationReporter } from "../../reporters/integration-json.js";
import { createUnitReporter } from "../../reporters/unit-json.js";
import { createCIReporter } from "../../reporters/ci-json.js";

test("unit reporter includes top-level skipped tests", async () => {
  const result = await report(createUnitReporter(), [
    event("test:skip", "top-level skipped", 0, 1, 0, "/repo/tests/unit/helpers.test.js", "test"),
    event("test:skip", "skipped suite", 0, 2, 0, "/repo/tests/unit/helpers.test.js", "suite"),
  ]);

  assert.equal(result.total, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.groups[0].group, "Root");
});

test("integration reporter groups root files and includes top-level skipped tests", async () => {
  const result = await report(createIntegrationReporter(), [
    event("test:skip", "top-level skipped", 0, 1, 0, "/repo/tests/integration/agent.test.js", "test"),
    event("test:skip", "skipped suite", 0, 2, 0, "/repo/tests/integration/agent.test.js", "suite"),
  ]);

  assert.equal(result.total, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.groups[0].group, "Root");
});

test("combined CI reporter keeps unit and integration results separate", async () => {
  const result = await report(createCIReporter(), [
    event("test:skip", "unit skipped", 0, 1, 0, "/repo/tests/unit/helpers.test.js", "test"),
    event("test:skip", "integration skipped", 0, 2, 0, "/repo/tests/integration/agent.test.js", "test"),
  ]);

  assert.equal(result.unit.total, 1);
  assert.equal(result.unit.files[0].tests[0].name, "unit skipped");
  assert.equal(result.integration.total, 1);
  assert.equal(result.integration.files[0].tests[0].name, "integration skipped");
});

async function report(reporter, events) {
  let output = "";
  reporter.on("data", (chunk) => { output += chunk.toString(); });
  for (const item of events) reporter.write(item);
  reporter.end();
  await new Promise((resolve, reject) => {
    reporter.on("end", resolve);
    reporter.on("error", reject);
    reporter.resume();
  });
  return JSON.parse(output);
}

function event(type, name, nesting, testId, parentId, file, detailType) {
  return {
    type,
    data: {
      name,
      nesting,
      testId,
      parentId,
      file,
      details: { duration_ms: 0, type: detailType },
    },
  };
}
