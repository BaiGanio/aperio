#!/usr/bin/env node

import { join, resolve } from "node:path";
import { writeDashboardData } from "../lib/helpers/modelTierDashboard.js";
import { resolveBenchmarkArtifactDir } from "./model-tier-bench/campaign.js";
import { ROOT } from "./model-tier-bench/paths.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  return "Usage: npm run model-tier:export -- --tier <8|16|24|32> --model <model-id> --campaign <campaign-id> [--output <path>]";
}

const tier = Number(option("--tier"));
const modelId = option("--model");
const campaignId = option("--campaign");
if (![8, 16, 24, 32].includes(tier) || !modelId || !campaignId) {
  console.error(usage());
  process.exit(1);
}

try {
  const artifactDir = resolveBenchmarkArtifactDir(ROOT, tier, modelId, campaignId);
  // Keep the private copy beside the evidence, and refresh the public docs
  // fixture so benchmarking.html always shows the most recently exported run.
  writeDashboardData(artifactDir);
  const docsOutputPath = writeDashboardData(artifactDir, {
    outputPath: join(ROOT, "docs/tools/benchmarks/dashboard-data.js"),
  });
  const outputPath = option("--output")
    ? writeDashboardData(artifactDir, { outputPath: resolve(option("--output")) })
    : docsOutputPath;
  console.log(outputPath);
} catch (error) {
  console.error(`model-tier export failed: ${error.message}`);
  process.exit(1);
}
