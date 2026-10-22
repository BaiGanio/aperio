import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { BrowserJsonReporter } from "../../reporters/browser-json.js";

test("browser reporter writes dashboard-ready final-attempt results", () => {
  const root = mkdtempSync(join(tmpdir(), "aperio-browser-reporter-"));
  const outputFile = join(root, "browser-results.json");
  const reporter = new BrowserJsonReporter({ outputFile });
  const browserRoot = resolve(import.meta.dirname, "..", "..", "browser");

  try {
    const journey = {
      id: "journey",
      title: "persists a job",
      location: { file: resolve(browserRoot, "agents/agent-steps-builder.spec.js") },
    };
    reporter.onTestEnd(journey, {
      status: "failed",
      duration: 8,
      error: { message: "first attempt" },
    });
    reporter.onTestEnd(journey, { status: "passed", duration: 5 });
    reporter.onTestEnd({
      id: "smoke",
      title: "loads the shell",
      location: { file: resolve(browserRoot, "smoke/app-shell.spec.js") },
    }, { status: "skipped", duration: 0 });
    reporter.onEnd();

    const result = JSON.parse(readFileSync(outputFile, "utf8"));
    assert.equal(result.total, 2);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.duration_ms, 5);
    assert.deepEqual(result.suites.map(suite => suite.name), [
      "Agent step builder",
      "App shell smoke",
    ]);
    assert.equal(result.suites[0].tests[0].file, "agents/agent-steps-builder.spec.js");
    assert.equal(result.suites[0].tests[0].error, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
