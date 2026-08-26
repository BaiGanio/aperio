import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..", "..");
const BROWSER_ROOT = resolve(ROOT, "tests/browser");

export class BrowserJsonReporter {
  constructor(options = {}) {
    this.outputFile = resolve(ROOT, options.outputFile || "tests/results/browser-results.json");
    this.results = new Map();
  }

  onTestEnd(test, result) {
    const file = relative(BROWSER_ROOT, test.location.file).replaceAll("\\", "/");
    const status = normalizeStatus(result.status);
    this.results.set(test.id, {
      name: test.title,
      suite: suiteName(file),
      file,
      duration_ms: result.duration || 0,
      status,
      error: status === "fail"
        ? String(result.error?.message || result.error || "Browser test failed").slice(0, 500)
        : null,
    });
  }

  onEnd() {
    const tests = [...this.results.values()].sort((a, b) =>
      a.suite.localeCompare(b.suite) || a.name.localeCompare(b.name)
    );
    const suites = groupSuites(tests);
    const passed = tests.filter(test => test.status === "pass").length;
    const failed = tests.filter(test => test.status === "fail").length;
    const skipped = tests.filter(test => test.status === "skip").length;
    const total = tests.length;
    const result = {
      generatedAt: new Date().toISOString(),
      source: "tests/browser/",
      total,
      passed,
      failed,
      skipped,
      duration_ms: tests.reduce((sum, test) => sum + test.duration_ms, 0),
      passRate: total > 0 ? Number(((passed / total) * 100).toFixed(1)) : 100,
      suites,
    };

    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, `${JSON.stringify(result)}\n`, "utf8");
  }
}

function normalizeStatus(status) {
  if (status === "passed") return "pass";
  if (status === "skipped") return "skip";
  return "fail";
}

function suiteName(file) {
  if (file.startsWith("agents/")) return "Agent step builder";
  if (file.startsWith("smoke/")) return "App shell smoke";
  return file.split("/")[0] || "Browser";
}

function groupSuites(tests) {
  const suites = new Map();
  for (const test of tests) {
    const suite = suites.get(test.suite) || {
      name: test.suite,
      tests: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      duration_ms: 0,
    };
    suite.tests.push(test);
    suite[`${test.status}ed`]++;
    suite.duration_ms += test.duration_ms;
    suites.set(test.suite, suite);
  }
  return [...suites.values()].map(suite => ({
    ...suite,
    testCount: suite.tests.length,
    passRate: suite.tests.length > 0
      ? Number(((suite.passed / suite.tests.length) * 100).toFixed(1))
      : 100,
  }));
}

export default BrowserJsonReporter;
