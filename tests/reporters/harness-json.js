// tests/reporters/harness-json.js
// Custom test reporter that outputs structured JSON for the WS0 agent-loop
// regression harness dashboard. Only events whose source file is under
// tests/harness/ are included. Mirrors tests/reporters/unit-json.js, but
// groups by describe() block ("Safety checks" vs. "Behavior checks") instead
// of subdirectory — the harness is one flat directory, not a tree of module
// areas.

import { Transform } from "node:stream";

function groupFromName(name) {
  if (/safety checks/i.test(name || "")) return "Safety checks";
  return "Behavior checks";
}

function isHarnessFile(file) {
  return typeof file === "string" && /[/\\]tests[/\\]harness[/\\]/.test(file);
}

export function createHarnessReporter() {
  const tests = [];
  const suiteByTestId = new Map();
  const groupBySuite = new Map();
  const counts = { total: 0, passed: 0, failed: 0, skipped: 0 };

  return new Transform({
    writableObjectMode: true,
    readableObjectMode: false,

    transform(event, encoding, callback) {
      try {
        const ev = typeof event === "string" ? JSON.parse(event) : event;
        const { type, data } = ev;
        if (!isHarnessFile(data?.file)) {
          callback();
          return;
        }

        if (type === "test:start" && data?.nesting !== undefined) {
          const suite = data.nesting === 0
            ? data.name
            : suiteByTestId.get(data.parentId) || "__root__";
          suiteByTestId.set(data.testId, suite);
          if (data.nesting === 0) groupBySuite.set(suite, groupFromName(suite));
        } else if (type === "test:pass" || type === "test:fail") {
          const duration_ms = data?.details?.duration_ms ?? 0;
          const nesting = data?.nesting ?? 0;
          if (nesting >= 0 && data?.details?.type !== "suite") {
            counts.total++;
            if (type === "test:pass") counts.passed++; else counts.failed++;
            const errMsg = type === "test:fail"
              ? data?.details?.error?.message ?? data?.details?.error ?? null
              : null;
            const suite = suiteByTestId.get(data.testId) || "__root__";
            tests.push({
              name: data.name,
              suite,
              file: data?.file || "",
              group: groupBySuite.get(suite) || "Behavior checks",
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
            const suite = suiteByTestId.get(data.testId) || suiteByTestId.get(data.parentId) || "__root__";
            tests.push({
              name: data.name,
              suite,
              file: data?.file || "",
              group: groupBySuite.get(suite) || "Behavior checks",
              duration_ms: 0,
              status: "skip",
              nesting,
              error: null,
            });
          }
        }
        callback();
      } catch {
        callback();
      }
    },

    flush(callback) {
      const groupMap = new Map();
      for (const t of tests) {
        const g = t.group || "Behavior checks";
        if (!groupMap.has(g)) {
          groupMap.set(g, { group: g, testCount: 0, passed: 0, failed: 0, skipped: 0, duration_ms: 0, tests: [] });
        }
        const grp = groupMap.get(g);
        grp.testCount++;
        grp.duration_ms += t.duration_ms;
        grp.tests.push(t);
        if (t.status === "pass") grp.passed++;
        else if (t.status === "fail") grp.failed++;
        else if (t.status === "skip") grp.skipped++;
      }

      const totalDuration = tests.reduce((sum, t) => sum + t.duration_ms, 0);
      const result = {
        generatedAt: new Date().toISOString(),
        source: "tests/harness/",
        total: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        duration_ms: totalDuration,
        passRate: counts.total > 0 ? Number(((counts.passed / counts.total) * 100).toFixed(1)) : 100,
        groups: [...groupMap.entries()]
          .map(([, g]) => ({
            group: g.group,
            testCount: g.testCount,
            passed: g.passed,
            failed: g.failed,
            skipped: g.skipped,
            duration_ms: g.duration_ms,
            passRate: g.testCount > 0 ? Number(((g.passed / g.testCount) * 100).toFixed(1)) : 100,
          }))
          .sort((a, b) => a.group.localeCompare(b.group)),
        tests: tests
          .map(t => ({
            name: t.name, suite: t.suite, group: t.group,
            duration_ms: t.duration_ms, status: t.status, error: t.error,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };

      this.push(JSON.stringify(result));
      callback();
    },
  });
}

export default createHarnessReporter();
