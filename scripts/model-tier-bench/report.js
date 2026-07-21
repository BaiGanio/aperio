import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateBenchmarkRuns,
  benchmarkSummaryCsv,
  generateTierDecisions,
  rescoreBenchmarkRun,
  selectFinalists,
  tierDecisionsMarkdown,
  validateFinalistEvidence,
  validateFullExamManifest,
} from "../../lib/helpers/modelTierBench.js";
import { resolveCampaignAggregateDir } from "./campaign.js";
import { DEFAULT_FULL_EXAM } from "./paths.js";
import { atomicJson, readJson } from "./io.js";

function discoverCampaignRuns(root, tier, id) {
  const tierDir = join(root, "var/benchmarks/model-tiers", `${tier}gb`);
  if (!existsSync(tierDir)) return [];
  return readdirSync(tierDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== id)
    .flatMap(entry => {
      const runPath = join(tierDir, entry.name, id, "run.json");
      if (!existsSync(runPath)) return [];
      try { return [{ run: readJson(runPath), artifactPath: runPath }]; }
      catch (error) {
        return [{ run: { status: "invalid", campaignId: id, targetTierGB: tier, model: { id: entry.name }, invalidReason: `cannot read run.json: ${error.message}` }, artifactPath: runPath }];
      }
    });
}

function discoverPersistedRunPaths(base) {
  if (!existsSync(base)) return [];
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() && entry.name === "run.json" ? [path] : [];
  });
  return walk(base).sort();
}

// `base` defaults to the production artifact tree; tests override it to point at
// a committed fixture (var/ is gitignored, so fixtures can't live under it).
export function rescorePersistedRuns(root, base = join(root, "var/benchmarks/model-tiers")) {
  return discoverPersistedRunPaths(base).map(artifactPath => {
    let run;
    try {
      run = readJson(artifactPath);
    } catch (error) {
      return { artifactPath, action: "invalid", requiresRerun: true, invalidReason: `cannot read run.json: ${error.message}` };
    }
    const result = rescoreBenchmarkRun(run);
    const invalidCases = (result.run.caseResults ?? []).filter(item => item.status === "invalid").map(item => item.id);
    const remainingFailures = (result.run.caseResults ?? []).filter(item => item.status === "fail").map(item => item.id);
    const requiresRerun = run.status !== "complete" || invalidCases.length > 0 || remainingFailures.length > 0;
    return {
      artifactPath,
      modelId: run.model?.id ?? null,
      targetTierGB: run.targetTierGB ?? null,
      runStatus: run.status ?? null,
      rescoredCases: result.changedCases,
      invalidCases,
      remainingFailures,
      requiresRerun,
      action: run.status !== "complete" || invalidCases.length ? "invalid" :
        result.changedCases.length ? "rescored" : requiresRerun ? "rerun-required" : "unchanged",
    };
  });
}

export function writeCampaignSummary(root, tier, id, runs = discoverCampaignRuns(root, tier, id)) {
  const summary = aggregateBenchmarkRuns(runs, { campaignId: id, targetTierGB: tier });
  const outputDir = resolveCampaignAggregateDir(root, tier, id);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  atomicJson(join(outputDir, "summary.json"), summary);
  writeFileSync(join(outputDir, "summary.csv"), benchmarkSummaryCsv(summary), { mode: 0o600 });
  return { outputDir, summary };
}

export function writeFinalistManifest(root, tier, id) {
  const dir = resolveCampaignAggregateDir(root, tier, id);
  const summaryPath = join(dir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error(`campaign summary is missing: ${summaryPath}`);
  const fullExam = validateFullExamManifest(readJson(DEFAULT_FULL_EXAM));
  const manifest = selectFinalists(readJson(summaryPath), { fullExamManifest: fullExam });
  atomicJson(join(dir, "finalists.json"), manifest);
  return { outputDir: dir, manifest };
}

export function writeTierDecisions(root, tier, id, evidencePath) {
  const dir = resolveCampaignAggregateDir(root, tier, id);
  const manifestPath = join(dir, "finalists.json");
  if (!existsSync(manifestPath)) throw new Error(`finalist manifest is missing: ${manifestPath}`);
  if (!evidencePath) throw new Error("--evidence is required with --decide");
  const manifest = readJson(manifestPath);
  const fullExam = validateFullExamManifest(readJson(DEFAULT_FULL_EXAM));
  const supplied = readJson(evidencePath);
  const evidence = Array.isArray(supplied) ? supplied : supplied.evidence;
  for (const item of evidence ?? []) validateFinalistEvidence(item, fullExam);
  const decisions = generateTierDecisions({ finalists: manifest.finalists, evidence, manifest: fullExam });
  atomicJson(join(dir, "decisions.json"), decisions);
  writeFileSync(join(dir, "decisions.md"), tierDecisionsMarkdown(decisions), { mode: 0o600 });
  return { outputDir: dir, decisions };
}
