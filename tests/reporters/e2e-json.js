// tests/reporters/e2e-json.js
// Custom test reporter that outputs structured JSON for the e2e dashboard.
// Usage: node --test --test-reporter=./tests/reporters/e2e-json.js 'tests/e2e/**/*.test.js'
//
// The Node.js test runner emits events as JSON strings to the reporter stream.
// We collect them and output a final structured object on flush.

import { Transform } from "node:stream";

const tests = [];
const suiteStack = []; // tracks current suite name per nesting level
const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };

const reporter = new Transform({
  writableObjectMode: true,
  readableObjectMode: false,

  transform(event, encoding, callback) {
    try {
      const ev = typeof event === "string" ? JSON.parse(event) : event;
      const { type, data } = ev;

      if (type === "test:start" && data?.nesting !== undefined) {
        const nesting = data.nesting;
        if (nesting === 0) {
          // Suite level — reset stack
          suiteStack[0] = data.name;
          suiteStack.length = 1;
        } else {
          // Individual test — suite is suiteStack[0]
        }
      } else if (type === "test:pass" || type === "test:fail") {
        // Duration comes from details.duration_ms
        const duration_ms = data?.details?.duration_ms ?? 0;
        const nesting = data?.nesting ?? 0;

        if (nesting >= 1) {
          // Individual test result
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
            suite: suiteStack[0] || "__root__",
            duration_ms,
            status: type === "test:pass" ? "pass" : "fail",
            nesting,
            error: typeof errMsg === "string" ? errMsg.slice(0, 500) : errMsg,
          });
        }
      } else if (type === "test:skip" || type === "test:todo") {
        counts.skipped++;
        counts.total++;
        const nesting = data?.nesting ?? 0;
        if (nesting >= 1) {
          tests.push({
            name: data.name,
            suite: suiteStack[0] || "__root__",
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

export default reporter;
