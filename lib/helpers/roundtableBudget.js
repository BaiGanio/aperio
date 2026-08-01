import os from "os";
import { resolveModelFacts, llamacppContextWindow } from "../providers/index.js";

const GIB = 1024 ** 3;
const DEFAULT_KV_BYTES_PER_TOKEN = 144 * 1024;
const DEFAULT_RESERVE_FRACTION = 0.20;
const DEFAULT_RESERVE_GB = 4;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

// A llama-server on another host serves models from THAT machine's RAM —
// os.totalmem() here says nothing about it, so the budget check must not run.
function llamacppIsRemote(env) {
  const raw = env.LLAMACPP_BASE_URL || "http://127.0.0.1:8080";
  try {
    return !LOOPBACK_HOSTS.has(new URL(raw).hostname);
  } catch {
    return false;
  }
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function estimateLlamaCppFootprintGB(model, contextWindow, env = process.env) {
  if (!model) return 0;
  const facts = resolveModelFacts(model, env);
  const ctx = toNumber(contextWindow) ?? llamacppContextWindow(env);
  const perToken = facts.kvBytesPerToken > 0 ? facts.kvBytesPerToken : DEFAULT_KV_BYTES_PER_TOKEN;
  const weightsGB = facts.sizeGB ?? 8;
  const cacheGB = ctx > 0 ? (ctx * perToken) / GIB : 0;
  return weightsGB + cacheGB + 1;
}

export function shouldEnableRoundtable({
  mainProvider = null,
  primaryConfig = null,
  verifierConfig = null,
  totalRamGB = os.totalmem() / GIB,
  env = process.env,
} = {}) {
  if (!primaryConfig || !verifierConfig) {
    return { enabled: false, reason: "ROUNDTABLE_AGENTS needs two provider:model pairs" };
  }

  // Only the roundtable agents' models matter for the ADDITIONAL footprint.
  // The main provider's model is already loaded and consuming RAM.
  const roundtableModels = [...new Set(
    [primaryConfig, verifierConfig]
      .filter(c => c?.name === "llamacpp")
      .map(c => c.model),
  )];

  // No local roundtable models → no additional RAM needed
  if (roundtableModels.length === 0) {
    return { enabled: true, reason: null, footprintGB: 0, budgetGB: totalRamGB };
  }

  // Deduplicate against main provider: models already loaded there cost nothing extra
  const mainModel = mainProvider?.name === "llamacpp" ? mainProvider.model : null;

  // If all roundtable models are already loaded as the main model, no additional cost
  if (mainModel && roundtableModels.length === 1 && roundtableModels[0] === mainModel) {
    return { enabled: true, reason: null, footprintGB: 0, budgetGB: totalRamGB };
  }

  if (llamacppIsRemote(env)) {
    return { enabled: true, reason: null, footprintGB: 0, budgetGB: totalRamGB };
  }

  const contextWindow = llamacppContextWindow(env);
  // Only estimate the additional models — skip any already loaded by the main provider
  const footprintGB = roundtableModels.reduce((sum, model) => {
    if (mainModel && model === mainModel) return sum;
    return sum + estimateLlamaCppFootprintGB(model, contextWindow, env);
  }, 0);

  // No additional footprint needed → always fine
  if (footprintGB === 0) {
    return { enabled: true, reason: null, footprintGB: 0, budgetGB: totalRamGB };
  }

  const reserveGB = Math.max(
    toNumber(env.APERIO_ROUNDTABLE_RESERVE_GB) ?? DEFAULT_RESERVE_GB,
    totalRamGB * (toNumber(env.APERIO_ROUNDTABLE_RESERVE_FRACTION) ?? DEFAULT_RESERVE_FRACTION),
  );
  const budgetGB = Math.max(0, totalRamGB - reserveGB);

  if (footprintGB > budgetGB) {
    return {
      enabled: false,
      reason: `estimated local model footprint ${footprintGB.toFixed(1)} GB exceeds budget ${budgetGB.toFixed(1)} GB`,
      footprintGB,
      budgetGB,
    };
  }

  return { enabled: true, reason: null, footprintGB, budgetGB };
}
