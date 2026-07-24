import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const viewerPath = resolve("docs/benchmarks/pilot/qualification.html");

function viewerRuntime() {
  const html = readFileSync(viewerPath, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, "viewer should have one inline application script");

  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        className: "",
        hidden: true,
        innerHTML: "",
        textContent: "",
        value: "",
        style: { setProperty() {} },
        classList: {
          values: new Set(),
          add(value) { this.values.add(value); },
          remove(value) { this.values.delete(value); },
          toggle(value, force) { if (force) this.values.add(value); else this.values.delete(value); },
        },
        addEventListener() {},
        click() {},
      });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    console,
    structuredClone,
    document: {
      documentElement: { dataset: {} },
      getElementById: node,
      querySelectorAll: () => [],
    },
  });
  new vm.Script(scripts[0][1], { filename: viewerPath }).runInContext(context);
  return { context, html, node };
}

function browserFile(name, value, webkitRelativePath = "") {
  return {
    name,
    webkitRelativePath,
    async text() { return typeof value === "string" ? value : JSON.stringify(value); },
  };
}

test("viewer explains campaign IDs as optional user labels with timestamp fallback", () => {
  const { html } = viewerRuntime();
  assert.match(html, /What is a campaign ID\?/);
  assert.match(html, /If you omit that option for a single run, Aperio generates a UTC timestamp/);
  assert.match(html, /var\/benchmarks\/model-tiers\/&lt;tier&gt;gb\/&lt;model-id&gt;\/&lt;campaign-id&gt;\//);
  assert.match(html, /dashboard-data\.js/);
  assert.doesNotMatch(html, /class="case-prompt"/);
  assert.match(html, /id="demoBtn"/);
  assert.match(html, /class="overview"/);
  assert.match(html, /class="panel panel-pad score-panel"/);
  assert.match(html, /id="metricChart"/);
});

test("metrics export import renders statuses and retry metrics", async () => {
  const { context, node } = viewerRuntime();
  const firstAttempt = {
    status: "fail",
    actualToolSequence: ["recall"],
    expectedToolSequence: ["recall", "wiki_write"],
    statePassed: false,
  };
  const retry = {
    status: "pass",
    actualToolSequence: ["wiki_search", "recall", "wiki_write"],
    expectedToolSequence: ["recall", "wiki_write"],
    statePassed: true,
  };
  const data = {
    schemaVersion: 1,
    privateDataExcluded: true,
    run: {
      status: "complete",
      campaignId: "audit-human-readable-id",
      targetTierGB: 16,
      servedContext: 16384,
      model: { id: "gemma4-e4b-ud-q4kxl" },
    },
    cases: [{
      ...retry,
      id: "chain-recall-wiki",
      retried: true,
      firstAttempt,
      retry,
    }],
    metrics: [
      { phase: "qualification", at: "2026-07-15T11:21:03.247Z", usedRamBytes: 100, aperioRssBytes: 20, llamaRssBytes: 50, swapBytes: 0 },
      { phase: "qualification", at: "2026-07-15T11:21:04.247Z", usedRamBytes: 110, aperioRssBytes: 21, llamaRssBytes: 55, swapBytes: 0 },
    ],
  };
  context.files = [
    browserFile("dashboard-data.js", `window.APERIO_BENCHMARK = ${JSON.stringify(data)};\n`, "audit-human-readable-id/dashboard-data.js"),
  ];

  const result = await vm.runInContext("loadFiles(files)", context);
  assert.deepEqual([...result.loadedNames].sort(), ["dashboard-data.js"]);
  assert.equal(result.ignoredCount, 0);
  assert.equal(node("campaignId").textContent, "audit-human-readable-id");
  assert.match(node("caseList").innerHTML, /First attempt/);
  assert.match(node("caseList").innerHTML, /<details class="case pass">/);
  assert.match(node("caseList").innerHTML, /<summary class="case-summary">/);
  assert.doesNotMatch(node("caseList").innerHTML, /<details class="case pass" open>/);
  assert.match(node("caseList").innerHTML, /Retry/);
  assert.match(node("caseList").innerHTML, /Final persisted result/);
  assert.match(node("caseList").innerHTML, /wiki_search → recall → wiki_write/);
  assert.equal(vm.runInContext("currentMetrics[0].at", context), "2026-07-15T11:21:03.247Z");
});

test("non-export files are rejected", async () => {
  const { context, node } = viewerRuntime();
  context.files = [browserFile("run.json", { status: "complete" })];

  await vm.runInContext("handleFiles(files)", context);
  assert.match(node("notice").innerHTML, /Could not read/);
});

test("explicit context evidence is not relabeled as a generic timeout or harness failure", async () => {
  const { context, node } = viewerRuntime();
  const data = {
    schemaVersion: 1,
    privateDataExcluded: true,
    run: { status: "invalid", campaignId: "context-check" },
    cases: [{
      id: "chain-recall-wiki",
      status: "invalid",
      timeoutKind: "llamacpp-context-limit",
    }],
    metrics: [],
  };
  context.files = [browserFile("dashboard-data.js", `window.APERIO_BENCHMARK = ${JSON.stringify(data)};`)];

  await vm.runInContext("loadFiles(files)", context);
  assert.equal(node("runStatus").textContent, "Explicit context-limit failure");
  assert.doesNotMatch(node("notice").innerHTML, /Harness \/ readiness failure/);
  assert.doesNotMatch(node("caseList").innerHTML, /11,470|11470/);
});
