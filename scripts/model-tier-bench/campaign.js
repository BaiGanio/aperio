import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { QUALIFICATION_SUITE_VERSION } from "../../lib/helpers/modelTierQualification.js";
import { TIER_POLICY } from "./constants.js";
import { atomicJson, readJson } from "./io.js";

export function resolveBenchmarkArtifactDir(root, tier, modelId, id) {
  if (![8, 16, 24, 32].includes(tier)) throw new Error("tier must be 8, 16, 24, or 32");
  if (!modelId || !id) throw new Error("model id and campaign id are required");
  return join(root, "var/benchmarks/model-tiers", `${tier}gb`, modelId, id);
}

export function resolveCampaignAggregateDir(root, tier, id) {
  if (![8, 16, 24, 32].includes(tier)) throw new Error("tier must be 8, 16, 24, or 32");
  if (!id) throw new Error("campaign id is required");
  return join(root, "var/benchmarks/model-tiers", `${tier}gb`, id);
}

export function buildCampaignPlan({
  models,
  campaignId,
  gitCommit,
  platform,
  hardware,
  ramGB,
  fixtureVersion,
  fixtureContractVersion,
  fixtureMemoryCount,
  fixtureTag,
  qualificationSuiteVersion = QUALIFICATION_SUITE_VERSION,
  profile = "balanced",
  servedContextPolicy = "tier-configured",
} = {}) {
  if (!Array.isArray(models) || !models.length) throw new Error("validated model catalog is required");
  if (!campaignId) throw new Error("campaign id is required");
  const placements = [];
  for (const model of models) {
    for (const tier of model.tiers ?? []) {
      if (![8, 16, 24, 32].includes(tier)) throw new Error(`model ${model.id} has an invalid tier placement`);
      placements.push({ tier, modelId: model.id, model: model.hf, role: model.role ?? "challenger" });
    }
  }
  placements.sort((left, right) => left.tier - right.tier || left.modelId.localeCompare(right.modelId));
  const controls = {
    gitCommit: gitCommit ?? null,
    platform: platform ?? null,
    hardware: hardware ?? null,
    ramGB: ramGB ?? null,
    profile,
    servedContextPolicy,
    qualificationSuiteVersion,
    fixtureVersion: fixtureVersion ?? null,
    fixtureContractVersion: fixtureContractVersion ?? null,
    fixtureMemoryCount: fixtureMemoryCount ?? null,
    fixtureTag: fixtureTag ?? null,
    tierPolicy: TIER_POLICY,
  };
  return {
    contractVersion: 1,
    campaignPlanVersion: 1,
    campaignId,
    status: "planned",
    execution: "not-started",
    private: true,
    controls,
    placements,
    counts: {
      models: models.length,
      placements: placements.length,
      tiers: [...new Set(placements.map(item => item.tier))].length,
    },
  };
}

export function writeCampaignPlan(root, plan) {
  if (!plan?.campaignId || !Array.isArray(plan.placements)) throw new Error("campaign plan is required");
  const outputDirs = [];
  for (const tier of [8, 16, 24, 32]) {
    const placements = plan.placements.filter(item => item.tier === tier);
    if (!placements.length) continue;
    const outputDir = resolveCampaignAggregateDir(root, tier, plan.campaignId);
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    atomicJson(join(outputDir, "campaign.json"), {
      ...plan,
      targetTierGB: tier,
      modelIds: placements.map(item => item.modelId),
      placements,
    });
    outputDirs.push(outputDir);
  }
  return { outputDirs, plan };
}

export function readCampaignPlacements(root, id) {
  if (!id) throw new Error("campaign id is required");
  const placements = [];
  let campaignControls;
  for (const tier of [8, 16, 24, 32]) {
    const path = join(resolveCampaignAggregateDir(root, tier, id), "campaign.json");
    if (!existsSync(path)) continue;
    const manifest = readJson(path);
    if (manifest.private !== true) throw new Error(`campaign manifest is not private: ${path}`);
    if (manifest.campaignId !== id) throw new Error(`campaign manifest has mismatched id: ${path}`);
    if (manifest.targetTierGB !== tier) throw new Error(`campaign manifest has mismatched tier: ${path}`);
    if (!Array.isArray(manifest.placements)) throw new Error(`campaign manifest has no placements: ${path}`);
    const controls = JSON.stringify(manifest.controls ?? null);
    if (campaignControls === undefined) campaignControls = controls;
    if (campaignControls !== controls) throw new Error(`campaign manifests have mismatched controls: ${path}`);
    for (const placement of manifest.placements) {
      if (placement.tier !== tier || !placement.modelId || !placement.model) {
        throw new Error(`campaign manifest has an invalid placement: ${path}`);
      }
      placements.push({ ...placement, manifestPath: path });
    }
  }
  if (!placements.length) throw new Error(`campaign plan is missing: ${id}`);
  const seen = new Set();
  for (const placement of placements) {
    const key = `${placement.tier}:${placement.modelId}`;
    if (seen.has(key)) throw new Error(`campaign plan contains duplicate placement: ${key}`);
    seen.add(key);
  }
  return placements.sort((left, right) => left.tier - right.tier || left.modelId.localeCompare(right.modelId));
}

function writeCampaignExecution(root, id, placements, results) {
  const controls = readJson(placements[0].manifestPath).controls ?? null;
  for (const tier of [8, 16, 24, 32]) {
    const tierPlacements = placements.filter(item => item.tier === tier);
    if (!tierPlacements.length) continue;
    const outputDir = resolveCampaignAggregateDir(root, tier, id);
    atomicJson(join(outputDir, "execution.json"), {
      contractVersion: 1,
      private: true,
      campaignId: id,
      controls,
      targetTierGB: tier,
      placements: tierPlacements.map(item => ({ tier: item.tier, modelId: item.modelId, model: item.model, role: item.role })),
      results: results.filter(item => item.tier === tier),
    });
  }
}

// `runnerPath` must be the CLI entry script (scripts/model-tier-bench.js) so
// respawned placements re-invoke the real runner, not this module — callers
// must pass it explicitly (main() supplies its own import.meta.url).
export async function executeCampaign(root, id, { dryRun = false, runnerPath, spawnPlacement } = {}) {
  const placements = readCampaignPlacements(root, id);
  const runPlacement = spawnPlacement ?? (placement => new Promise(resolveP => {
    const child = spawn(process.execPath, [runnerPath, "--model", placement.modelId, "--tier", String(placement.tier), "--campaign", id], {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", error => resolveP({ exitCode: null, signal: null, error: error.message }));
    child.once("close", (exitCode, signal) => resolveP({ exitCode, signal }));
  }));
  const results = [];
  for (const placement of placements) {
    const result = dryRun ? { status: "planned" } : await runPlacement(placement);
    results.push({ tier: placement.tier, modelId: placement.modelId, ...result });
  }
  writeCampaignExecution(root, id, placements, results);
  return { campaignId: id, placements, results };
}

export function requireLiveCampaignApproval({ dryRun = false, approveLive = false } = {}) {
  if (!dryRun && !approveLive) {
    throw new Error("live campaign execution requires explicit --approve-live approval");
  }
  return true;
}
