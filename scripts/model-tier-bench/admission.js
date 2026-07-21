import { mkdirSync, statfsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findCachedGguf, factsFromGguf } from "../../lib/helpers/ggufModelFacts.js";
import { selectBenchmarkCases } from "../../lib/helpers/modelTierBench.js";
import { GIB, PREFLIGHT_DISK_RESERVE_GB, TIER_POLICY, DEFAULT_PILOT_CASE_IDS } from "./constants.js";
import { atomicJson } from "./io.js";

export function selectPilotCases(cases, requestedIds = []) {
  return selectBenchmarkCases(cases, requestedIds.length ? requestedIds : DEFAULT_PILOT_CASE_IDS);
}

export function validateTargetTier(model, tier) {
  if (![8, 16, 24, 32].includes(tier)) throw new Error("tier must be 8, 16, 24, or 32");
  if (!model?.tiers?.includes(tier)) throw new Error(`model ${model?.id ?? "unknown"} is not eligible for the ${tier} GB tier`);
  return tier;
}

function exactModelParts(hf, catalogQuant = null) {
  const separator = String(hf).lastIndexOf(":");
  return {
    repo: separator > 0 ? String(hf).slice(0, separator) : String(hf),
    quant: separator > 0 ? String(hf).slice(separator + 1) : String(catalogQuant ?? ""),
  };
}

function formatGB(bytes) {
  const gb = bytes / GIB;
  return Number.isInteger(gb) ? String(gb) : gb.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function availableDiskBytes(path) {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function requireRelative(root, target) {
  const rootResolved = resolve(root);
  const targetResolved = resolve(target);
  return targetResolved === rootResolved || targetResolved.startsWith(`${rootResolved}/`)
    ? targetResolved.slice(rootResolved.length + 1)
    : null;
}

/**
 * Admission-only checks. This must complete before an Aperio or llama.cpp
 * process is started, so a mismatch cannot become model-behaviour evidence.
 */
export function preflightModelCandidate(model, {
  cacheRoot,
  findCached = findCachedGguf,
  factsFromGguf: readFacts = factsFromGguf,
  diskAvailableBytes,
  diskReserveGB = PREFLIGHT_DISK_RESERVE_GB,
} = {}) {
  const reasons = [];
  const { repo, quant } = exactModelParts(model?.hf, model?.quant);
  if (!repo.includes("/") || !quant) reasons.push(`model must use an exact Hugging Face repo:quant identifier: ${model?.hf ?? "missing"}`);
  if (model?.quant && model.quant.toLowerCase() !== quant.toLowerCase()) {
    reasons.push(`catalog quant ${model.quant} does not match requested ${quant}`);
  }

  let cachedPath = null;
  if (!reasons.length) cachedPath = findCached(model.hf, cacheRoot);
  if (!cachedPath) {
    reasons.push(`${model.hf} is not cached with an exact GGUF candidate`);
  }

  let ggufFacts = null;
  if (cachedPath) {
    const expectedCacheDir = join(cacheRoot, `models--${repo.replaceAll("/", "--")}`);
    const relative = requireRelative(expectedCacheDir, cachedPath);
    if (relative === null) reasons.push(`cached GGUF is outside the exact Hugging Face repository cache: ${repo}`);
    if (!basename(cachedPath).toLowerCase().includes(quant.toLowerCase())) {
      reasons.push(`cached GGUF quantization does not match requested ${quant}`);
    }
    try { ggufFacts = readFacts(cachedPath); } catch { ggufFacts = null; }
    if (!ggufFacts) reasons.push("cached GGUF facts could not be read");
    else if (ggufFacts.source !== "gguf") reasons.push("cached model facts are not sourced from the GGUF header");
  }

  const sizeGB = Number(ggufFacts?.sizeGB ?? model?.sizeGB);
  const requiredGB = sizeGB + Number(diskReserveGB);
  const available = Number(diskAvailableBytes);
  if (Number.isFinite(available) && Number.isFinite(requiredGB) && available < requiredGB * GIB) {
    reasons.push(`insufficient disk space: need ${formatGB(requiredGB * GIB)} GB, have ${formatGB(available)} GB`);
  }

  return {
    status: reasons.length ? "invalid" : "admitted",
    hf: model.hf,
    repo,
    quant,
    cachedGguf: cachedPath ? { path: cachedPath, repo, quant } : null,
    ggufFacts,
    disk: {
      availableGB: Number.isFinite(available) ? Number(formatGB(available)) : null,
      requiredGB: Number.isFinite(requiredGB) ? Number(requiredGB.toFixed(2)) : null,
      reserveGB: Number(diskReserveGB),
    },
    reasons,
  };
}

export function writeInvalidAdmissionRun(path, {
  model, campaignId, targetTierGB, reasons, preflight = null, tierConfiguration = null, tierAdmission = null,
} = {}) {
  const run = {
    pilot: true,
    status: "invalid",
    invalidReason: reasons.join("; "),
    admission: true,
    campaignId,
    targetTierGB,
    tierConfiguration,
    tierPolicy: TIER_POLICY,
    tierAdmission,
    model,
    preflight,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    caseResults: [],
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicJson(path, run);
  return run;
}

export function resolveHostTier(ramGB) {
  const gb = Number(ramGB);
  if (!Number.isFinite(gb) || gb <= 0) throw new Error("host RAM must be a positive number");
  if (gb <= 8) return 8;
  if (gb <= 16) return 16;
  if (gb <= 24) return 24;
  return 32;
}

export function resolveTierConfiguration(targetTier, hostRamGB, facts = {}) {
  const hostTierGB = resolveHostTier(hostRamGB);
  if (![8, 16, 24, 32].includes(targetTier)) throw new Error("tier must be 8, 16, 24, or 32");
  const memoryBudgetGB = targetTier;
  const reserveGB = Math.max(1, targetTier * 0.15);
  const overheadGB = 1;
  const availableGB = memoryBudgetGB - reserveGB - overheadGB - Number(facts.sizeGB || 0);
  const kvBytesPerToken = Number(facts.kvBytesPerToken) > 0 ? Number(facts.kvBytesPerToken) : 172032;
  const fitTokens = availableGB > 0 ? availableGB * GIB / kvBytesPerToken : 2048;
  const maxContext = Number(facts.maxContext) > 0 ? Number(facts.maxContext) : 16384;
  const servedContext = Math.max(2048, Math.floor(Math.min(maxContext, 16384, fitTokens) / 1024) * 1024);
  return {
    targetTierGB: targetTier,
    hostTierGB,
    hostRamGB: Number(hostRamGB),
    memoryBudgetGB,
    reserveGB,
    overheadGB,
    servedContext,
    evidenceMode: targetTier === hostTierGB ? "hardware-tier" : "simulated-tier",
    policy: TIER_POLICY,
  };
}

export function evaluateTierAdmission(targetTier, hostRamGB, facts = {}) {
  const configuration = resolveTierConfiguration(targetTier, hostRamGB, facts);
  const reasons = [];
  const contextGB = configuration.servedContext
    * (Number(facts.kvBytesPerToken) > 0 ? Number(facts.kvBytesPerToken) : 172032) / GIB;
  const configurationRequiredGB = Number(facts.sizeGB || 0)
    + configuration.reserveGB
    + configuration.overheadGB
    + contextGB;

  // A host larger than the requested tier can faithfully simulate the smaller
  // budget (see evidenceMode "simulated-tier"): we cap served context and hold
  // the model to the tier's memory budget below. Only a host too SMALL to
  // physically represent the tier is a hard rejection.
  if (configuration.hostTierGB < targetTier) {
    reasons.push(`host capacity ${configuration.hostRamGB} GB cannot represent the requested ${targetTier} GB tier budget`);
  }
  if (configurationRequiredGB > configuration.memoryBudgetGB) {
    reasons.push(`configuration requires ${formatGB(configurationRequiredGB * GIB)} GB beyond the ${targetTier} GB memory budget`);
  }

  return {
    status: reasons.length ? "invalid" : "admitted",
    admission: reasons.length ? "rejected" : "accepted",
    invalidReason: reasons.length ? reasons.join("; ") : null,
    reasons,
    policy: TIER_POLICY,
    targetTierGB: targetTier,
    hostRamGB: configuration.hostRamGB,
    hostTierGB: configuration.hostTierGB,
    memoryBudgetGB: configuration.memoryBudgetGB,
    configurationRequiredGB: Number(configurationRequiredGB.toFixed(2)),
    configuration,
  };
}
