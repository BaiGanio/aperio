// tests/reporters/integration-json.js
// Custom test reporter that outputs structured JSON for the integration dashboard.
// Only events whose source file is under tests/integration/ are included.
// Groups by module area (routes/, db/, store/, etc.) for dashboard color-coding.

import { Transform } from "node:stream";

/** Map of subdirectory name → display group label for dashboard coloring. */
const GROUP_LABELS = {
  routes:  "Routes",
  db:      "Database",
  store:   "Store",
  mcp:     "MCP",
  skills:  "Skills",
  handlers:"Handlers",
  context: "Context",
  tools:   "Tools",
  agent:   "Agent",
  workers: "Workers",
  helpers: "Helpers",
  scripts: "Scripts",
  public:  "Public",
  docs:    "Docs",
  e2e:     "E2E",
  vms:     "VMs",
  "db-connect":"DB Connect",
  codegraph:"Code Graph",
  docgraph:"Doc Graph",
};

function groupFromFile(file) {
  if (!file) return "Other";
  // Extract the subdirectory immediately after tests/integration/
  const match = file.match(/[/\\]tests[/\\]integration[/\\]([^/\\]+)/);
  if (!match) return "Other";
  if (match[1].endsWith(".test.js")) return "Root";
  return GROUP_LABELS[match[1]] || match[1];
}

function isIntegrationFile(file) {
  return typeof file === "string" && /[/\\]tests[/\\]integration[/\\]/.test(file);
}

export function createIntegrationReporter() {
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
        if (!isIntegrationFile(data?.file)) {
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
              file: data?.file || "",
              group: groupFromFile(data?.file),
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
              file: data?.file || "",
              group: groupFromFile(data?.file),
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
      // Group by test file for suite-level grouping
      const fileMap = new Map();
      for (const t of tests) {
        const key = t.file || "__root__";
        if (!fileMap.has(key)) {
          fileMap.set(key, {
            file: key,
            group: t.group,
            tests: [],
            passed: 0,
            failed: 0,
            skipped: 0,
            duration_ms: 0,
          });
        }
        const s = fileMap.get(key);
        s.tests.push(t);
        if (t.status === "pass") s.passed++;
        else if (t.status === "fail") s.failed++;
        else if (t.status === "skip") s.skipped++;
        s.duration_ms += t.duration_ms;
      }

      // Group-level summary
      const groupMap = new Map();
      for (const [, fileGroup] of fileMap) {
        const g = fileGroup.group || "Other";
        if (!groupMap.has(g)) {
          groupMap.set(g, {
            group: g,
            fileCount: 0,
            testCount: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration_ms: 0,
          });
        }
        const grp = groupMap.get(g);
        grp.fileCount++;
        grp.testCount += fileGroup.tests.length;
        grp.passed += fileGroup.passed;
        grp.failed += fileGroup.failed;
        grp.skipped += fileGroup.skipped;
        grp.duration_ms += fileGroup.duration_ms;
      }

      const totalDuration = tests.reduce((sum, t) => sum + t.duration_ms, 0);

      const result = {
        generatedAt: new Date().toISOString(),
        source: "tests/integration/",
        total: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        duration_ms: totalDuration,
        passRate:
          counts.total > 0
            ? Number(((counts.passed / counts.total) * 100).toFixed(1))
            : 100,
        groups: [...groupMap.entries()]
          .map(([, g]) => ({
            group: g.group,
            fileCount: g.fileCount,
            testCount: g.testCount,
            passed: g.passed,
            failed: g.failed,
            skipped: g.skipped,
            duration_ms: g.duration_ms,
            passRate:
              g.testCount > 0
                ? Number(((g.passed / g.testCount) * 100).toFixed(1))
                : 100,
          }))
          .sort((a, b) => a.group.localeCompare(b.group)),
        files: [...fileMap.entries()]
          .map(([, s]) => ({
            file: s.file,
            group: s.group,
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
          .sort((a, b) => a.file.localeCompare(b.file)),
      };

      this.push(JSON.stringify(result));
      callback();
    },
  });
}

export default createIntegrationReporter();
