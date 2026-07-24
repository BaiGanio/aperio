// tests/reporters/e2e-json.js
// Custom test reporter that outputs structured JSON for the e2e dashboard.
// Usage: node --test --test-reporter=spec --test-reporter-destination=stdout
//   --test-reporter=./tests/reporters/e2e-json.js
//   --test-reporter-destination=tests/results/e2e-results.json 'tests/**/*.test.js'
//
// The reporter may observe the full test suite. Only events whose source file is
// under tests/e2e/ are included in the dashboard result.

import { Transform } from "node:stream";

export function createE2EReporter() {
  const tests = [];
  const suiteByTestId = new Map();
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };

  return new Transform({
  writableObjectMode: true,
  readableObjectMode: false,

  transform(event, encoding, callback) {
    try {
      const ev = typeof event === "string" ? JSON.parse(event) : event;
      const { type, data } = ev;
      if (!isE2EFile(data?.file)) {
        callback();
        return;
      }

      if (type === "test:start" && data?.nesting !== undefined) {
        const suite = data.nesting === 0
          ? data.name
          : suiteByTestId.get(data.parentId) || "__root__";
        suiteByTestId.set(data.testId, suite);
      } else if (type === "test:pass" || type === "test:fail") {
        const duration_ms = data?.details?.duration_ms ?? 0;
        const nesting = data?.nesting ?? 0;

        if (nesting >= 0 && data?.details?.type !== "suite") {
          counts.total++;
          if (type === "test:pass") {
            counts.passed++;
          } else {
            counts.failed++;
          }

          const errMsg =
            type === "test:fail"
              ? data?.details?.error?.message ??
                data?.details?.error ??
                null
              : null;

          tests.push({
            name: data.name,
            suite: suiteByTestId.get(data.testId) || "__root__",
            duration_ms,
            status: type === "test:pass" ? "pass" : "fail",
            nesting,
            error: typeof errMsg === "string" ? errMsg.slice(0, 500) : errMsg,
          });
        }
      } else if (type === "test:skip" || type === "test:todo") {
        const nesting = data?.nesting ?? 0;
        if (nesting >= 0 && data?.details?.type !== "suite") {
          counts.skipped++;
          counts.total++;
          tests.push({
            name: data.name,
            suite: suiteByTestId.get(data.testId)
              || suiteByTestId.get(data.parentId)
              || "__root__",
            duration_ms: 0,
            status: "skip",
            nesting,
            error: null,
          });
        }
      }

      callback();
    } catch (err) {
      // Don't crash on malformed events
      callback();
    }
  },

  flush(callback) {
    const suiteMap = new Map();

    for (const t of tests) {
      const key = t.suite || "__root__";
      if (!suiteMap.has(key)) {
        suiteMap.set(key, { name: key, tests: [], passed: 0, failed: 0, skipped: 0, duration_ms: 0 });
      }
      const s = suiteMap.get(key);
      s.tests.push(t);
      if (t.status === "pass") s.passed++;
      else if (t.status === "fail") s.failed++;
      else if (t.status === "skip") s.skipped++;
      s.duration_ms += t.duration_ms;
    }

    const totalDuration = tests.reduce((sum, t) => sum + t.duration_ms, 0);

    const result = {
      generatedAt: new Date().toISOString(),
      source: "tests/e2e/",
      total: counts.total,
      passed: counts.passed,
      failed: counts.failed,
      skipped: counts.skipped,
      duration_ms: totalDuration,
      passRate:
        counts.total > 0
          ? Number(((counts.passed / counts.total) * 100).toFixed(1))
          : 100,
      suites: [...suiteMap.entries()]
        .map(([name, s]) => ({
          name,
          testCount: s.tests.length,
          passed: s.passed,
          failed: s.failed,
          skipped: s.skipped,
          duration_ms: s.duration_ms,
          passRate:
            s.tests.length > 0
              ? Number(((s.passed / s.tests.length) * 100).toFixed(1))
              : 100,
          tests: s.tests.sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };

    this.push(JSON.stringify(result));
    callback();
  },
  });
}

function isE2EFile(file) {
  return typeof file === "string" && /[/\\]tests[/\\]e2e[/\\]/.test(file);
}

export default createE2EReporter();
