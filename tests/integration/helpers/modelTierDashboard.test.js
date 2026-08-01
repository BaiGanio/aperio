import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildDashboardData, parseMetricsCsv, writeDashboardData } from "../../../lib/helpers/modelTierDashboard.js";

test("metrics export excludes private run and case content", () => {
  const data = buildDashboardData({
    run: {
      status: "complete", campaignId: "audit-1", targetTierGB: 16,
      model: { id: "model-a", displayName: "Model A", hf: "secret/repo" },
      startedAt: "2026-07-23T00:00:00.000Z", finishedAt: "2026-07-23T00:01:00.000Z",
      invalidReason: "/private/path", transcript: "private transcript",
    },
    cases: [{
      id: "case-a", prompt: "private prompt", objective: "private objective",
      requiredAnswerTerms: ["private answer"], stateAssertion: { contentIncludes: ["secret"] },
      status: "pass", durationMs: 100, actualToolSequence: ["recall"], completed: true,
    }],
    metrics: parseMetricsCsv("phase,at,usedRamBytes,aperioRssBytes,llamaRssBytes,swapBytes\nload,2026-07-23T00:00:00.000Z,10,20,30,0\n"),
  });

  assert.equal(data.privateDataExcluded, true);
  assert.equal(data.run.model.hf, undefined);
  assert.equal(data.run.invalidReason, undefined);
  assert.equal(data.cases[0].prompt, undefined);
  assert.equal(data.cases[0].requiredAnswerTerms, undefined);
  assert.equal(data.cases[0].stateAssertion, undefined);
  assert.deepEqual(data.metrics[0], {
    phase: "load", at: "2026-07-23T00:00:00.000Z", usedRamBytes: 10,
    aperioRssBytes: 20, llamaRssBytes: 30, swapBytes: 0,
  });
});

test("writeDashboardData creates one browser-loadable private export", () => {
  const dir = mkdtempSync(join(tmpdir(), "aperio-dashboard-export-"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ status: "complete", model: { id: "model-a" }, caseResults: [] }));
  writeFileSync(join(dir, "cases.jsonl"), `${JSON.stringify({ id: "case-a", status: "pass" })}\n`);
  writeFileSync(join(dir, "metrics.csv"), "phase,at,usedRamBytes,aperioRssBytes,llamaRssBytes,swapBytes\nload,now,1,2,3,0\n");
  const output = writeDashboardData(dir);
  const text = readFileSync(output, "utf8");
  assert.match(text, /^window\.APERIO_BENCHMARK = \{/);
  assert.doesNotMatch(text, /caseResults|cases\.jsonl|metrics\.csv/);
  assert.match(text, /"privateDataExcluded":true/);
});
