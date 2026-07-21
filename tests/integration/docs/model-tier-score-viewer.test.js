import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const viewerPath = resolve("docs/model-tier-score-viewer.html");

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
  assert.match(html, /id="demoBtn"/);
  assert.match(html, /class="overview"/);
  assert.match(html, /class="panel panel-pad score-panel"/);
  assert.match(html, /id="metricChart"/);
});

test("campaign-folder import reads exact viewer artifacts and renders retry evidence", async () => {
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
  const run = {
    status: "complete",
    campaignId: "audit-human-readable-id",
    targetTierGB: 16,
    servedContext: 16384,
    model: { id: "gemma4-e4b-ud-q4kxl" },
    caseResults: [{
      ...retry,
      id: "chain-recall-wiki",
      title: "Recall and write a wiki article",
      retried: true,
      firstAttempt,
      retry,
    }],
  };
  context.files = [
    browserFile("campaign.json", { campaignId: "must-not-replace-run" }, "audit-human-readable-id/campaign.json"),
    browserFile("transcript.jsonl", "{}\n", "audit-human-readable-id/transcript.jsonl"),
    browserFile("run.json", run, "audit-human-readable-id/run.json"),
    browserFile("cases.jsonl", `${JSON.stringify(run.caseResults[0])}\n`, "audit-human-readable-id/cases.jsonl"),
    browserFile("metrics.csv", "phase,at,usedRamBytes,aperioRssBytes,llamaRssBytes,swapBytes\nqualification,2026-07-15T11:21:03.247Z,100,20,50,0\nqualification,2026-07-15T11:21:04.247Z,110,21,55,0\n", "audit-human-readable-id/metrics.csv"),
  ];

  const result = await vm.runInContext("loadFiles(files)", context);
  assert.deepEqual([...result.loadedNames].sort(), ["cases.jsonl", "metrics.csv", "run.json"]);
  assert.equal(result.ignoredCount, 2);
  assert.equal(node("campaignId").textContent, "audit-human-readable-id");
  assert.match(node("caseList").innerHTML, /First attempt/);
  assert.match(node("caseList").innerHTML, /Retry/);
  assert.match(node("caseList").innerHTML, /Final persisted result/);
  assert.match(node("caseList").innerHTML, /wiki_search → recall → wiki_write/);
  assert.equal(vm.runInContext("currentMetrics[0].at", context), "2026-07-15T11:21:03.247Z");
});

test("partial cases-only import does not fabricate run metadata", async () => {
  const { context, node } = viewerRuntime();
  context.files = [browserFile("cases.jsonl", `${JSON.stringify({ id: "chain-recall-wiki", status: "pass" })}\n`, "generated-campaign-id/cases.jsonl")];

  await vm.runInContext("loadFiles(files)", context);
  assert.equal(node("modelName").textContent, "Unavailable");
  assert.equal(node("campaignId").textContent, "generated-campaign-id");
  assert.equal(node("peakLlama").textContent, "Unavailable");
  assert.match(node("chartHost").innerHTML, /Unavailable/);
});

test("explicit context evidence is not relabeled as a generic timeout or harness failure", async () => {
  const { context, node } = viewerRuntime();
  const run = {
    status: "invalid",
    invalidReason: "case exceeded context",
    caseResults: [{
      id: "chain-recall-wiki",
      status: "invalid",
      timeoutKind: "llamacpp-context-limit",
      invalidReason: "request (11470 tokens) exceeds the available context size (11264 tokens)",
    }],
  };
  context.files = [browserFile("run.json", run)];

  await vm.runInContext("loadFiles(files)", context);
  assert.equal(node("runStatus").textContent, "Explicit context-limit failure");
  assert.doesNotMatch(node("notice").innerHTML, /Harness \/ readiness failure/);
  assert.match(node("caseList").innerHTML, /11,470|11470/);
});
